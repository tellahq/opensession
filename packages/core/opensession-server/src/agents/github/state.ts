/**
 * Per-PR state for the github agent, one JSON file per PR at
 * ~/.opensession-github/<prNumber>.json. Tracks the single review comment id, which
 * head SHAs we've already reviewed (dedup), the resumable review session, and the
 * auto-fix run state. Mirrors the grafana-poller dedup store.
 *
 * In-process locks coalesce rapid webhook bursts (force-push, stacked commits)
 * within one process; the on-disk state guards across restarts.
 */
import { stateDir } from "../../server/paths";
import { prKey } from "./constants";
import type { HandoffState } from "./handoff-gates";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "fs";
import { writeJsonAtomic } from "../../server/shared/atomic-write";

const STATE_DIR = stateDir("github");

mkdirSync(STATE_DIR, { recursive: true });

// Engine-session resume is handled via the deterministic per-PR session file
// (see run.ts `bksIdFor`), so these track only behavioral state.

export interface AutoFixState {
  active: boolean;
  iterations: number;
  worktreeDir?: string;
  lastPushedSha?: string;
  statusCommentId?: number;
  requestedBy?: string; // github login that applied the label (for commit attribution)
  steer?: string; // free-text steer from the triggering message (recovered on restart)
  startedAt: string;
}

/** What the last completed review concluded, kept so the UI can show the score
 *  without re-reading the PR's comments. Written only after a successful run,
 *  so a transient model failure never blanks the previous verdict. */
export interface LastReviewState {
  /** approve | comment | request_changes (absent when the model omitted it). */
  verdict?: string;
  /** 1-5: how safe this is to merge, per the review contract. */
  confidence?: number;
  findings: number;
  /** P0/P1 findings (request_changes counts as a floor of 1). */
  blocking: number;
  /** Head SHA this verdict describes — a later head means the score is stale. */
  sha: string;
  at: string;
}

interface PendingReviewCommon {
  /** Optional only while loading state written before generation fencing shipped. */
  generation?: string;
  headRef: string;
  headSha: string;
  title: string;
  firstPushAt: string;
  dueAt: string;
  attempts?: number;
  lastError?: string;
}

export type PendingReviewState =
  | (PendingReviewCommon & {
      phase?: "queued";
      claimedAt?: never;
      exhaustedAt?: never;
    })
  | (PendingReviewCommon & {
      phase: "running";
      claimedAt: string;
      exhaustedAt?: never;
    })
  | (PendingReviewCommon & {
      phase: "exhausted";
      exhaustedAt: string;
      claimedAt?: never;
    });

export interface GithubPrState {
  prNumber: number;
  headRef: string;
  /** owner/name when this PR lives outside the default repo (multi-repo);
   *  absent = the default repo (every pre-existing state file). */
  ghRepo?: string;
  summaryCommentId?: number;
  reviewedShas: string[];
  lastReviewedSha?: string;
  /** The last review's conclusion (verdict/confidence), for the UI. */
  lastReview?: LastReviewState;
  autoFix?: AutoFixState;
  /** A label-triggered request persisted before its async run starts. If the
   *  process exits during dispatch, reconcile can still attribute the run to
   *  the person who applied the label. Cleared when runAutoFix takes ownership. */
  pendingAutoFix?: {
    requestedBy: string;
    receivedAt: string;
  };
  /** Desired review work retained until this exact generation is recorded.
   * The timer is only a wake-up hint and may be rebuilt after a restart. */
  pendingReview?: PendingReviewState;
  /** Review → owning-session fix rounds (handoff.ts); cleared when a review
   *  comes back satisfied or the PR closes. */
  handoff?: HandoffState;
  /** Reconcile-sweep retry bookkeeping (reconcile.ts). Attempts are per-SHA:
   *  a new head resets the count, so only a *repeatedly*-failing SHA is given
   *  up on. A fresh human label re-arms autofix (webhook.ts clears the count). */
  reconcile?: {
    /** Head SHA the review attempts below refer to. */
    reviewSha?: string;
    reviewAttempts?: number;
    /** Head SHA the autofix attempts below refer to. */
    autofixSha?: string;
    autofixAttempts?: number;
  };
  /**
   * Set while a one-shot action (review/simplify/adversarial) is in flight; cleared
   * in its finally. If the process is killed mid-run, this persists so the github
   * agent re-runs it on startup. (Auto-fix uses its own `autoFix.active`.)
   */
  activeRun?: {
    kind: "review" | "simplify" | "adversarial";
    requestedBy: string;
    startedAt: string;
    /** A person stopped this run. Recovery must not start it again. */
    cancelRequestedAt?: string;
    /** The head under review. Recovery only reuses a progress comment for this same SHA. */
    headSha?: string;
    /** The run's progress comment id, reused only on restart recovery, not on a fresh re-trigger. */
    progressCommentId?: number;
    /** Durable model result. Recovery can finish GitHub posting without rerunning a completed review. */
    reviewResult?: {
      text: string;
      error?: string;
      model?: string;
    };
    /** Free-text steer from the triggering message, so a restart can re-pass it. */
    steer?: string;
  };
  /** An in-flight @mention reply (conversational), persisted so a restart can re-run it. */
  activeMention?: {
    author: string;
    body: string;
    kind: "issue" | "review";
    replyToId?: number;
    inline?: { path: string; line?: number; diffHunk?: string };
    progressCommentId?: number;
    startedAt: string;
  };
  /**
   * A just-received @mention, persisted synchronously on receipt — before the run
   * self-persists (the classify + worktree window, several seconds). If the process
   * dies in that window — e.g. a webhook that lands during shutdown drain, which we
   * still ack 200 so GitHub won't redeliver — startup recovery replays it. Cleared
   * once a run takes ownership (activeMention/activeRun) or the dispatch completes.
   */
  pendingMention?: {
    kind: "issue" | "review";
    commentId: number;
    body: string;
    author: string;
    replyToId?: number;
    inline?: { path: string; line?: number; diffHunk?: string };
    receivedAt: string;
    /** REST-posted receipt, reused as the run progress comment after a retry. */
    progressCommentId?: number;
  };
  updatedAt: string;
}

function statePath(prNumber: number, ghRepo?: string): string {
  return `${STATE_DIR}/${prKey(prNumber, ghRepo)}.json`;
}

export function readPrState(
  prNumber: number,
  ghRepo?: string,
): GithubPrState | null {
  const path = statePath(prNumber, ghRepo);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GithubPrState;
  } catch {
    return null;
  }
}

export function getOrInitPrState(
  prNumber: number,
  headRef: string,
  ghRepo?: string,
): GithubPrState {
  return (
    readPrState(prNumber, ghRepo) || {
      prNumber,
      headRef,
      ...(prKey(prNumber, ghRepo) !== String(prNumber) ? { ghRepo } : {}),
      reviewedShas: [],
      updatedAt: new Date().toISOString(),
    }
  );
}

/** Module-private on purpose: a caller that holds a whole-file snapshot across an
 *  await and writes it back reverts whatever another behavior landed in between.
 *  Every mutation goes through updatePrState (or one of the helpers below), which
 *  re-reads immediately before patching. */
function writePrState(state: GithubPrState): void {
  state.updatedAt = new Date().toISOString();
  // Keep the reviewed-SHA list bounded.
  if (state.reviewedShas.length > 20)
    state.reviewedShas = state.reviewedShas.slice(-20);
  writeJsonAtomic(statePath(state.prNumber, state.ghRepo), state);
}

/**
 * Read, patch, write: the ONLY way to mutate a PR's state. Behaviors keep their
 * own locals across network work and call this at each commit point, so a write
 * from the other lane (reviews and code actions hold different locks by design)
 * survives instead of being reverted by a stale snapshot.
 */
export function updatePrState(
  prNumber: number,
  headRef: string,
  patch: (s: GithubPrState) => void,
  ghRepo?: string,
): GithubPrState {
  const s = getOrInitPrState(prNumber, headRef, ghRepo);
  patch(s);
  writePrState(s);
  return s;
}

/** Generation-fenced variant for races where a stale callback should do no I/O. */
export function updatePrStateIf(
  prNumber: number,
  headRef: string,
  patch: (s: GithubPrState) => boolean,
  ghRepo?: string,
): GithubPrState {
  const s = getOrInitPrState(prNumber, headRef, ghRepo);
  if (patch(s)) writePrState(s);
  return s;
}

/** Persist a just-received mention so a crash/restart before the run self-persists
 *  can still recover it. headRef may be unknown here; the run backfills the real one. */
export function setPendingMention(
  prNumber: number,
  pending: NonNullable<GithubPrState["pendingMention"]>,
  ghRepo?: string,
): void {
  updatePrState(
    prNumber,
    `pr-${prNumber}`,
    (s) => {
      s.pendingMention = pending;
    },
    ghRepo,
  );
}

/** Clear the pending-mention marker once a run owns the mention or it completes. */
export function clearPendingMention(prNumber: number, ghRepo?: string): void {
  if (!readPrState(prNumber, ghRepo)?.pendingMention) return;
  updatePrState(
    prNumber,
    `pr-${prNumber}`,
    (s) => {
      s.pendingMention = undefined;
    },
    ghRepo,
  );
}

/** Record a completed review: the SHA (dedup) plus the verdict the UI shows. */
export function recordReviewed(
  prNumber: number,
  headRef: string,
  sha: string,
  lastReview: LastReviewState,
  ghRepo?: string,
): void {
  updatePrState(
    prNumber,
    headRef,
    (s) => {
      if (!s.reviewedShas.includes(sha)) s.reviewedShas.push(sha);
      s.lastReviewedSha = sha;
      s.lastReview = lastReview;
    },
    ghRepo,
  );
}

/** Clear the one-shot recovery marker — but only when it's still ours. A run that
 *  chains into another one (simplify → re-review) must not clear the successor's. */
export function clearActiveRun(
  prNumber: number,
  headRef: string,
  kind: NonNullable<GithubPrState["activeRun"]>["kind"],
  ghRepo?: string,
): void {
  updatePrState(
    prNumber,
    headRef,
    (s) => {
      if (s.activeRun?.kind === kind) s.activeRun = undefined;
    },
    ghRepo,
  );
}

/** Persist a stop request before aborting the engine, so startup recovery and
 *  pre-engine setup cannot bring the run back. */
export function requestActiveRunCancellation(
  prNumber: number,
  headRef: string,
  kind: NonNullable<GithubPrState["activeRun"]>["kind"],
  ghRepo?: string,
): boolean {
  let requested = false;
  updatePrState(
    prNumber,
    headRef,
    (s) => {
      if (s.activeRun?.kind !== kind) return;
      s.activeRun.cancelRequestedAt ||= new Date().toISOString();
      requested = true;
    },
    ghRepo,
  );
  return requested;
}

export function activeRunCancellationRequested(
  prNumber: number,
  kind: NonNullable<GithubPrState["activeRun"]>["kind"],
  ghRepo?: string,
): boolean {
  const run = readPrState(prNumber, ghRepo)?.activeRun;
  return run?.kind === kind && Boolean(run.cancelRequestedAt);
}

/** Every PR state file (for the startup recovery sweep). */
export function listPrStates(): GithubPrState[] {
  const out: GithubPrState[] = [];
  for (const file of readdirSync(STATE_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(
        JSON.parse(
          readFileSync(`${STATE_DIR}/${file}`, "utf-8"),
        ) as GithubPrState,
      );
    } catch {}
  }
  return out;
}

// ── Startup recovery selection ───────────────────────────────

/** The recovery markers a PR state can carry, in the order that decides which
 *  run owns the PR. Outermost first: auto-fix's gate review sets `activeRun`
 *  while `autoFix.active` is still set (that pair is NORMAL, not corruption), so
 *  resuming the fix loop resumes the review with it. */
export type RecoveryKind =
  | "auto-fix"
  | "pending-auto-fix"
  | "run"
  | "mention"
  | "pending-mention";

const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** When the marker was armed — the age `planRecovery` judges it by. */
export function recoveryMarkerAt(
  s: GithubPrState,
  kind: RecoveryKind,
): string | undefined {
  switch (kind) {
    case "auto-fix":
      return s.autoFix?.startedAt;
    case "pending-auto-fix":
      return s.pendingAutoFix?.receivedAt;
    case "run":
      return s.activeRun?.startedAt;
    case "mention":
      return s.activeMention?.startedAt;
    case "pending-mention":
      return s.pendingMention?.receivedAt;
  }
}

function markersOn(s: GithubPrState): RecoveryKind[] {
  const out: RecoveryKind[] = [];
  if (s.autoFix?.active) out.push("auto-fix");
  if (s.pendingAutoFix) out.push("pending-auto-fix");
  if (s.activeRun) out.push("run");
  if (s.activeMention) out.push("mention");
  if (s.pendingMention) out.push("pending-mention");
  return out;
}

/**
 * Pick the ONE run a restart should resume for this PR, plus the markers to
 * clear on the way. Walks the markers outermost-first: each is stale (older than
 * RECOVERY_MAX_AGE_MS, or undated) or live, and the first live one wins — every
 * marker after it belongs to a run nested inside it, so firing those too would
 * start a second run for the same PR.
 *
 * Crash recovery only makes sense across one restart window: an older flag is a
 * leftover whose cleanup failed, and re-firing it would spawn a surprise run
 * (and PR comments) on a long-dead PR at every boot. Stale flags are cleared and
 * the next marker considered instead.
 *
 * Pure: the caller clears `stale` and fires `fire`.
 */
export function planRecovery(
  s: GithubPrState,
  now = Date.now(),
): { fire?: RecoveryKind; stale: RecoveryKind[] } {
  const stale: RecoveryKind[] = [];
  for (const kind of markersOn(s)) {
    // A cancelled one-shot stays marked until its running function unwinds.
    // Treat it as cleanup-only if the process restarts in that window.
    if (kind === "run" && s.activeRun?.cancelRequestedAt) {
      stale.push(kind);
      continue;
    }
    const t = Date.parse(recoveryMarkerAt(s, kind) || "");
    if (t && now - t <= RECOVERY_MAX_AGE_MS) return { fire: kind, stale };
    stale.push(kind);
  }
  return { stale };
}

/** Clear one recovery marker (used for the stale ones planRecovery reports). */
export function clearRecoveryMarker(
  s: GithubPrState,
  kind: RecoveryKind,
): void {
  updatePrState(
    s.prNumber,
    s.headRef,
    (st) => {
      switch (kind) {
        case "auto-fix":
          if (st.autoFix) st.autoFix.active = false;
          break;
        case "pending-auto-fix":
          st.pendingAutoFix = undefined;
          break;
        case "run":
          st.activeRun = undefined;
          break;
        case "mention":
          st.activeMention = undefined;
          break;
        case "pending-mention":
          st.pendingMention = undefined;
          break;
      }
    },
    s.ghRepo,
  );
}

// ── In-process locks ─────────────────────────────────────────
// "review" is independent (read-only, main checkout). "code" is shared by
// auto-fix AND simplify because they operate on the same PR-branch worktree —
// running them concurrently on one PR would corrupt that worktree.

// "review" is independent (read-only, main checkout). "code" is shared by
// auto-fix, simplify, AND mention replies — they all operate on the same
// PR-branch worktree, so they must not run concurrently on one PR.
// Keyed by prKey (bare number for the default repo, repoId-number otherwise).
const locks: Record<"review" | "code", Set<string>> = {
  review: new Set(),
  code: new Set(),
};

/** Try to claim the lock; false if already held. Release with releaseLock. */
export function claimLock(
  behavior: keyof typeof locks,
  prNumber: number,
  ghRepo?: string,
): boolean {
  const key = prKey(prNumber, ghRepo);
  if (locks[behavior].has(key)) return false;
  locks[behavior].add(key);
  return true;
}

export function releaseLock(
  behavior: keyof typeof locks,
  prNumber: number,
  ghRepo?: string,
): void {
  locks[behavior].delete(prKey(prNumber, ghRepo));
}

/** Is the lock currently held? (Read-only probe — never claims.) */
export function isLockHeld(
  behavior: keyof typeof locks,
  prNumber: number,
  ghRepo?: string,
): boolean {
  return locks[behavior].has(prKey(prNumber, ghRepo));
}

export function activeCodeLoops(): string[] {
  return locks.code.size ? [...locks.code] : [];
}
