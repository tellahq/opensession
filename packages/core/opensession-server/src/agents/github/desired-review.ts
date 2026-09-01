import type { PrAutomationDetails } from "../../server/pr-info";
import { prKey } from "./constants";
import {
  nextReviewDebounce,
  reviewBurstStart,
  reviewDebounceDelay,
  reviewRetryDelay,
} from "./review-debounce";
import type { PrRef, ReviewResult } from "./review";
import type { GithubPrState, PendingReviewState } from "./state";

interface DesiredReviewTimer {
  timer: ReturnType<typeof setTimeout>;
  generation: string;
  firstPushAt: number;
  attempts: number;
}

export interface DesiredReviewDependencies {
  readState: (prNumber: number, ghRepo?: string) => GithubPrState | null;
  updateState: (
    prNumber: number,
    headRef: string,
    patch: (state: GithubPrState) => void,
    ghRepo?: string,
  ) => GithubPrState;
  updateStateIf: (
    prNumber: number,
    headRef: string,
    patch: (state: GithubPrState) => boolean,
    ghRepo?: string,
  ) => GithubPrState;
  resolvePr: (
    prNumber: number,
    ghRepo?: string,
  ) => Promise<PrAutomationDetails | null>;
  runReview: (
    ref: PrRef,
    details: PrAutomationDetails,
  ) => Promise<ReviewResult | null>;
  isReviewLocked: (prNumber: number, ghRepo?: string) => boolean;
  restBackoffUntil: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
  newGeneration?: () => string;
  log?: (message: string) => void;
  logError?: (message: string, error?: unknown) => void;
}

export interface DesiredReviewOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  restoreStaggerMs?: number;
}

interface RequiredOptions {
  debounceMs: number;
  maxWaitMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  restoreStaggerMs: number;
}

export function desiredReviewOutstanding(
  state: GithubPrState | null | undefined,
): boolean {
  return Boolean(
    state?.pendingReview && state.pendingReview.phase !== "exhausted",
  );
}

function markerAttempts(marker: PendingReviewState): number {
  return Number.isFinite(marker.attempts) ? Number(marker.attempts) : 0;
}

function markerBase(marker: PendingReviewState) {
  return {
    generation: marker.generation,
    headRef: marker.headRef,
    headSha: marker.headSha,
    title: marker.title,
    firstPushAt: marker.firstPushAt,
    dueAt: marker.dueAt,
    attempts: markerAttempts(marker),
    ...(marker.lastError ? { lastError: marker.lastError } : {}),
  };
}

function queuedMarker(
  ref: PrRef,
  generation: string,
  firstPushAt: number,
  dueAt: number,
  attempts = 0,
  lastError?: string,
): PendingReviewState {
  return {
    phase: "queued",
    generation,
    headRef: ref.headRef,
    headSha: ref.headSha,
    title: ref.title,
    firstPushAt: new Date(firstPushAt).toISOString(),
    dueAt: new Date(dueAt).toISOString(),
    attempts,
    ...(lastError ? { lastError } : {}),
  };
}

export class DesiredReviewScheduler {
  private readonly timers = new Map<string, DesiredReviewTimer>();
  private readonly options: RequiredOptions;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly now: () => number;
  private readonly newGeneration: () => string;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, error?: unknown) => void;

  constructor(
    private readonly deps: DesiredReviewDependencies,
    options: DesiredReviewOptions = {},
  ) {
    this.options = {
      debounceMs: options.debounceMs ?? 240_000,
      maxWaitMs: options.maxWaitMs ?? 900_000,
      retryBaseMs: options.retryBaseMs ?? 15_000,
      retryMaxMs: options.retryMaxMs ?? 300_000,
      maxAttempts: options.maxAttempts ?? 6,
      restoreStaggerMs: options.restoreStaggerMs ?? 5_000,
    };
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.now = deps.now ?? Date.now;
    this.newGeneration = deps.newGeneration ?? (() => crypto.randomUUID());
    this.log = deps.log ?? ((message) => console.log(message));
    this.logError =
      deps.logError ?? ((message, error) => console.error(message, error));
  }

  admit(ref: PrRef): void {
    const key = prKey(ref.number, ref.ghRepo);
    const timer = this.timers.get(key);
    const persisted = timer
      ? undefined
      : this.deps.readState(ref.number, ref.ghRepo)?.pendingReview;
    const parsedFirstPushAt = Date.parse(persisted?.firstPushAt || "");
    const now = this.now();
    const firstPushAt = reviewBurstStart(
      timer
        ? { firstPushAt: timer.firstPushAt, attempts: timer.attempts }
        : persisted
          ? {
              firstPushAt: Number.isFinite(parsedFirstPushAt)
                ? parsedFirstPushAt
                : undefined,
              attempts: markerAttempts(persisted),
            }
          : undefined,
      now,
    );
    const timing = nextReviewDebounce(
      firstPushAt,
      now,
      this.options.debounceMs,
      this.options.maxWaitMs,
    );
    const generation = this.newGeneration();
    const marker = queuedMarker(
      ref,
      generation,
      timing.firstPushAt,
      timing.dueAt,
    );
    this.deps.updateState(
      ref.number,
      ref.headRef,
      (state) => {
        state.pendingReview = marker;
      },
      ref.ghRepo,
    );
    this.arm(ref, marker, timing.dueAt);
  }

  cancel(ref: PrRef): void {
    this.removeTimer(prKey(ref.number, ref.ghRepo));
    this.deps.updateStateIf(
      ref.number,
      ref.headRef,
      (state) => {
        if (!state.pendingReview) return false;
        state.pendingReview = undefined;
        return true;
      },
      ref.ghRepo,
    );
  }

  restore(states: GithubPrState[]): void {
    const now = this.now();
    let restored = 0;
    for (const state of states) {
      const raw = state.pendingReview;
      if (!raw) continue;
      const marker = this.normalize(state, raw);
      if (!marker || marker.phase === "exhausted") continue;
      const ref = this.refFor(state, marker);
      if (state.reviewedShas.includes(marker.headSha)) {
        this.clear(ref, marker.generation!);
        continue;
      }
      const parsedDueAt = Date.parse(marker.dueAt);
      const requestedDueAt =
        marker.phase === "running"
          ? now + this.options.retryBaseMs
          : Number.isFinite(parsedDueAt)
            ? parsedDueAt
            : now;
      const dueAt = Math.max(
        requestedDueAt,
        now + restored * this.options.restoreStaggerMs,
      );
      restored += 1;
      this.arm(ref, marker, dueAt);
      this.log(`[github] restored desired review for PR #${state.prNumber}`);
    }
  }

  private normalize(
    state: GithubPrState,
    raw: PendingReviewState,
  ): PendingReviewState | undefined {
    const legacy = raw as PendingReviewState & {
      claimedAt?: string;
      exhaustedAt?: string;
    };
    const generation = raw.generation || this.newGeneration();
    const attempts = markerAttempts(raw);
    const firstPushAt = Date.parse(raw.firstPushAt);
    const dueAt = Date.parse(raw.dueAt);
    const now = this.now();
    const phase = legacy.exhaustedAt
      ? "exhausted"
      : legacy.claimedAt || raw.phase === "running"
        ? "running"
        : raw.phase === "exhausted"
          ? "exhausted"
          : "queued";
    const normalized: PendingReviewState =
      phase === "running"
        ? {
            ...markerBase(raw),
            phase,
            generation,
            attempts,
            firstPushAt: new Date(
              Number.isFinite(firstPushAt) ? firstPushAt : now,
            ).toISOString(),
            dueAt: new Date(Number.isFinite(dueAt) ? dueAt : now).toISOString(),
            claimedAt: legacy.claimedAt || new Date(now).toISOString(),
          }
        : phase === "exhausted"
          ? {
              ...markerBase(raw),
              phase,
              generation,
              attempts,
              firstPushAt: new Date(
                Number.isFinite(firstPushAt) ? firstPushAt : now,
              ).toISOString(),
              dueAt: new Date(
                Number.isFinite(dueAt) ? dueAt : now,
              ).toISOString(),
              exhaustedAt: legacy.exhaustedAt || new Date(now).toISOString(),
            }
          : {
              ...markerBase(raw),
              phase,
              generation,
              attempts,
              firstPushAt: new Date(
                Number.isFinite(firstPushAt) ? firstPushAt : now,
              ).toISOString(),
              dueAt: new Date(
                Number.isFinite(dueAt) ? dueAt : now,
              ).toISOString(),
            };

    const needsWrite =
      raw.generation !== generation ||
      raw.phase !== normalized.phase ||
      raw.attempts !== attempts ||
      raw.firstPushAt !== normalized.firstPushAt ||
      raw.dueAt !== normalized.dueAt ||
      (normalized.phase === "running" &&
        legacy.claimedAt !== normalized.claimedAt) ||
      (normalized.phase === "exhausted" &&
        legacy.exhaustedAt !== normalized.exhaustedAt);
    if (!needsWrite) return normalized;
    let stored = false;
    this.deps.updateStateIf(
      state.prNumber,
      normalized.headRef,
      (current) => {
        const pending = current.pendingReview;
        if (
          !pending ||
          pending.generation !== raw.generation ||
          pending.headSha !== raw.headSha
        )
          return false;
        current.pendingReview = normalized;
        stored = true;
        return true;
      },
      state.ghRepo,
    );
    return stored ? normalized : undefined;
  }

  private arm(ref: PrRef, marker: PendingReviewState, dueAt: number): void {
    const generation = marker.generation;
    if (!generation || marker.phase === "exhausted") return;
    const key = prKey(ref.number, ref.ghRepo);
    this.removeTimer(key);
    let pending: DesiredReviewTimer;
    const timer = this.setTimer(
      () => {
        if (this.timers.get(key) !== pending) return;
        void this.run(ref, generation).catch((error) => {
          this.logError(
            `[github] desired review crashed for PR #${ref.number}`,
            error,
          );
          this.defer(ref, generation, error);
        });
      },
      reviewDebounceDelay(dueAt, this.now()),
    );
    timer.unref?.();
    pending = {
      timer,
      generation,
      firstPushAt: Date.parse(marker.firstPushAt),
      attempts: markerAttempts(marker),
    };
    this.timers.set(key, pending);
  }

  private async run(ref: PrRef, generation: string): Promise<void> {
    const key = prKey(ref.number, ref.ghRepo);
    const marker = this.deps.readState(ref.number, ref.ghRepo)?.pendingReview;
    if (marker?.generation !== generation || marker.phase === "exhausted") {
      this.removeTimer(key, generation);
      return;
    }
    if (this.deps.isReviewLocked(ref.number, ref.ghRepo)) {
      this.arm(ref, marker, this.now() + this.options.retryBaseMs);
      return;
    }
    const knownBackoff = this.deps.restBackoffUntil();
    if (knownBackoff > this.now()) {
      this.defer(ref, generation, "GitHub REST is rate limited", knownBackoff);
      return;
    }

    const running = this.claim(ref, generation);
    if (!running) return;
    this.removeTimer(key, generation);

    let details: PrAutomationDetails | null;
    try {
      details = await this.deps.resolvePr(ref.number, ref.ghRepo);
    } catch (error) {
      this.defer(ref, generation, error, this.deps.restBackoffUntil());
      return;
    }
    if (
      !details ||
      details.state !== "OPEN" ||
      details.isDraft ||
      !details.headRefOid
    ) {
      this.clear(ref, generation);
      return;
    }

    const current: PrRef = {
      number: ref.number,
      headRef: details.headRefName || ref.headRef,
      headSha: details.headRefOid,
      title: details.title || ref.title,
      ...(ref.ghRepo ? { ghRepo: ref.ghRepo } : {}),
    };
    const latest = this.deps.readState(ref.number, ref.ghRepo);
    if (latest?.pendingReview?.generation !== generation) return;
    if (latest.reviewedShas.includes(current.headSha)) {
      this.clear(current, generation);
      return;
    }
    if (current.headSha !== running.headSha) {
      this.replaceHead(ref, generation, current);
      return;
    }

    let result: ReviewResult | null;
    try {
      result = await this.deps.runReview(current, details);
    } catch (error) {
      this.defer(current, generation, error);
      return;
    }
    const after = this.deps.readState(current.number, current.ghRepo);
    if (after?.pendingReview?.generation !== generation) return;
    if (after.reviewedShas.includes(current.headSha)) {
      this.clear(current, generation);
      return;
    }
    this.defer(
      current,
      generation,
      result?.error || "Review finished without recording the requested head",
    );
  }

  private claim(
    ref: PrRef,
    generation: string,
  ): PendingReviewState | undefined {
    let running: PendingReviewState | undefined;
    this.deps.updateStateIf(
      ref.number,
      ref.headRef,
      (state) => {
        const pending = state.pendingReview;
        if (
          !pending ||
          pending.generation !== generation ||
          pending.phase === "exhausted"
        )
          return false;
        running = {
          ...markerBase(pending),
          phase: "running",
          generation,
          attempts: markerAttempts(pending) + 1,
          claimedAt: new Date(this.now()).toISOString(),
        };
        state.pendingReview = running;
        return true;
      },
      ref.ghRepo,
    );
    return running;
  }

  private defer(
    ref: PrRef,
    generation: string,
    error: unknown,
    notBefore = 0,
  ): void {
    const now = this.now();
    const message =
      error instanceof Error
        ? error.message
        : String(error || "Review did not complete");
    let next: PendingReviewState | undefined;
    this.deps.updateStateIf(
      ref.number,
      ref.headRef,
      (state) => {
        const pending = state.pendingReview;
        if (!pending || pending.generation !== generation) return false;
        const attempts = markerAttempts(pending);
        if (attempts >= this.options.maxAttempts) {
          next = {
            ...markerBase(pending),
            phase: "exhausted",
            generation,
            attempts,
            lastError: message,
            exhaustedAt: new Date(now).toISOString(),
          };
        } else {
          const retryAt = Math.max(
            now +
              reviewRetryDelay(
                attempts,
                this.options.retryBaseMs,
                this.options.retryMaxMs,
              ),
            notBefore,
          );
          next = {
            ...markerBase(pending),
            phase: "queued",
            generation,
            attempts,
            lastError: message,
            dueAt: new Date(retryAt).toISOString(),
          };
        }
        state.pendingReview = next;
        return true;
      },
      ref.ghRepo,
    );
    if (!next) return;
    if (next.phase === "exhausted") {
      this.removeTimer(prKey(ref.number, ref.ghRepo), generation);
      this.logError(
        `[github] desired review exhausted for PR #${ref.number} @ ${ref.headSha.slice(0, 7)} after ${markerAttempts(next)} attempts: ${message}`,
      );
      return;
    }
    this.arm(ref, next, Date.parse(next.dueAt));
  }

  private replaceHead(ref: PrRef, generation: string, current: PrRef): void {
    const now = this.now();
    const timing = nextReviewDebounce(
      now,
      now,
      this.options.debounceMs,
      this.options.maxWaitMs,
    );
    const replacement = queuedMarker(
      current,
      this.newGeneration(),
      timing.firstPushAt,
      timing.dueAt,
    );
    let replaced = false;
    this.deps.updateStateIf(
      ref.number,
      current.headRef,
      (state) => {
        if (state.pendingReview?.generation !== generation) return false;
        state.pendingReview = replacement;
        replaced = true;
        return true;
      },
      ref.ghRepo,
    );
    if (!replaced) return;
    this.arm(current, replacement, timing.dueAt);
    this.log(
      `[github] desired review for PR #${ref.number} advanced from ${ref.headSha.slice(0, 7)} to ${current.headSha.slice(0, 7)}`,
    );
  }

  private clear(ref: PrRef, generation: string): void {
    this.removeTimer(prKey(ref.number, ref.ghRepo), generation);
    this.deps.updateStateIf(
      ref.number,
      ref.headRef,
      (state) => {
        if (state.pendingReview?.generation !== generation) return false;
        state.pendingReview = undefined;
        return true;
      },
      ref.ghRepo,
    );
  }

  private removeTimer(key: string, generation?: string): void {
    const pending = this.timers.get(key);
    if (!pending || (generation && pending.generation !== generation)) return;
    this.clearTimer(pending.timer);
    this.timers.delete(key);
  }

  private refFor(state: GithubPrState, marker: PendingReviewState): PrRef {
    return {
      number: state.prNumber,
      headRef: marker.headRef || state.headRef,
      headSha: marker.headSha,
      title: marker.title || `PR #${state.prNumber}`,
      ...(state.ghRepo ? { ghRepo: state.ghRepo } : {}),
    };
  }
}
