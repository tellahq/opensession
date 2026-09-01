/**
 * Real-work sandbox scorecard.
 *
 * The scorecard consumes the structured metrics already written to the audit
 * log. Its gate is intentionally conservative: live conformance smokes prove
 * that a path can work, while this module asks whether it has worked often,
 * over multiple days, without being slower or less reliable than worktrees.
 * A passing automatic gate is still only evidence for the human default-flip
 * decision documented in docs/self-hosting-sandboxes.md.
 */

import { existsSync, readFileSync } from "fs";
import { stateDir } from "../paths";

export const SCORECARD_DEFAULT_DAYS = 30;
export const SCORECARD_THRESHOLDS = {
  minimumTurnsPerEnvironment: 20,
  minimumSandboxDays: 5,
  minimumPreviewsPerEnvironment: 5,
  minimumSandboxResumes: 5,
  minimumRestartAttempts: 3,
  maximumFailureRateRegression: 0.02,
  requiredRestartSurvivalRate: 1,
} as const;

export interface DurationStats {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export interface TurnScore {
  environment: "worktree" | "sandbox";
  provider: string;
  turns: number;
  successful: number;
  failed: number;
  failureRate: number | null;
  activeDays: number;
  firstEvent: DurationStats;
  firstToken: DurationStats;
  duration: DurationStats;
  sandboxReady: DurationStats;
}

export interface EnvironmentTimingScore {
  environment: "worktree" | "sandbox";
  provider: string;
  timing: DurationStats;
}

export interface OutcomeScore {
  provider: string;
  attempts: number;
  successful: number;
  failed: number;
  successRate: number | null;
  timing: DurationStats;
}

export interface SandboxScorecard {
  generatedAt: string;
  window: { days: number; from: string; through: string };
  thresholds: typeof SCORECARD_THRESHOLDS;
  turns: TurnScore[];
  previews: EnvironmentTimingScore[];
  resumes: OutcomeScore[];
  restartSurvival: OutcomeScore[];
  gate: {
    automaticReady: boolean;
    defaultFlipApproved: false;
    readyToFlip: false;
    reasons: string[];
    note: string;
  };
}

type AuditEvent = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}

function timing(values: number[]): DurationStats {
  return {
    samples: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function rate(successful: number, failed: number): number | null {
  const total = successful + failed;
  return total ? successful / total : null;
}

function dayOf(event: AuditEvent): string | null {
  const value = typeof event.time === "string" ? event.time.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function providerOf(event: AuditEvent, environment?: string): string {
  return typeof event.provider === "string" && event.provider
    ? event.provider
    : environment === "worktree"
      ? "host"
      : "unknown";
}

function utcDate(daysAgo: number, now: Date): string {
  return new Date(now.getTime() - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function scoreOutcomeEvents(
  events: AuditEvent[],
  kind: string,
): OutcomeScore[] {
  const groups = new Map<
    string,
    { successful: number; failed: number; values: number[] }
  >();
  for (const event of events) {
    if (event.kind !== kind) continue;
    const provider = providerOf(event);
    const group = groups.get(provider) ?? {
      successful: 0,
      failed: 0,
      values: [],
    };
    if (event.outcome === "ok") group.successful++;
    else group.failed++;
    const elapsed = finiteNumber(
      kind === "sandbox_resume_metric" ? event.resume_ms : event.recovery_ms,
    );
    if (elapsed !== null) group.values.push(elapsed);
    groups.set(provider, group);
  }
  return [...groups.entries()]
    .map(([provider, group]) => ({
      provider,
      attempts: group.successful + group.failed,
      successful: group.successful,
      failed: group.failed,
      successRate: rate(group.successful, group.failed),
      timing: timing(group.values),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function buildSandboxScorecard(
  events: AuditEvent[],
  options: { days?: number; now?: Date } = {},
): SandboxScorecard {
  const days = Math.min(
    90,
    Math.max(1, Math.floor(options.days ?? SCORECARD_DEFAULT_DAYS)),
  );
  const now = options.now ?? new Date();
  const through = now.toISOString().slice(0, 10);
  const from = utcDate(days - 1, now);
  const windowEvents = events.filter((event) => {
    const day = dayOf(event);
    return day !== null && day >= from && day <= through;
  });

  type TurnGroup = {
    environment: "worktree" | "sandbox";
    provider: string;
    successful: number;
    failed: number;
    days: Set<string>;
    firstEvent: number[];
    firstToken: number[];
    duration: number[];
    sandboxReady: number[];
  };
  const turnGroups = new Map<string, TurnGroup>();
  for (const event of windowEvents) {
    if (event.kind !== "session_turn_metric") continue;
    const environment =
      event.environment === "sandbox" ? "sandbox" : "worktree";
    const provider = providerOf(event, environment);
    const key = `${environment}:${provider}`;
    const group = turnGroups.get(key) ?? {
      environment,
      provider,
      successful: 0,
      failed: 0,
      days: new Set<string>(),
      firstEvent: [],
      firstToken: [],
      duration: [],
      sandboxReady: [],
    };
    if (event.outcome === "ok") group.successful++;
    else group.failed++;
    const day = dayOf(event);
    if (day) group.days.add(day);
    for (const [field, values] of [
      ["start_to_first_event_ms", group.firstEvent],
      ["start_to_first_token_ms", group.firstToken],
      ["duration_ms", group.duration],
      ["sandbox_ready_ms", group.sandboxReady],
    ] as const) {
      const value = finiteNumber(event[field]);
      if (value !== null) values.push(value);
    }
    turnGroups.set(key, group);
  }
  const turns = [...turnGroups.values()]
    .map((group): TurnScore => ({
      environment: group.environment,
      provider: group.provider,
      turns: group.successful + group.failed,
      successful: group.successful,
      failed: group.failed,
      failureRate:
        group.successful + group.failed
          ? group.failed / (group.successful + group.failed)
          : null,
      activeDays: group.days.size,
      firstEvent: timing(group.firstEvent),
      firstToken: timing(group.firstToken),
      duration: timing(group.duration),
      sandboxReady: timing(group.sandboxReady),
    }))
    .sort((a, b) =>
      `${a.environment}:${a.provider}`.localeCompare(
        `${b.environment}:${b.provider}`,
      ),
    );

  const previewGroups = new Map<
    string,
    { environment: "worktree" | "sandbox"; provider: string; values: number[] }
  >();
  for (const event of windowEvents) {
    if (event.kind !== "preview_ready_metric") continue;
    const environment =
      event.environment === "sandbox" ? "sandbox" : "worktree";
    const provider = providerOf(event, environment);
    const key = `${environment}:${provider}`;
    const group = previewGroups.get(key) ?? {
      environment,
      provider,
      values: [],
    };
    const value = finiteNumber(event.ready_ms);
    if (value !== null) group.values.push(value);
    previewGroups.set(key, group);
  }
  const previews = [...previewGroups.values()]
    .map((group): EnvironmentTimingScore => ({
      environment: group.environment,
      provider: group.provider,
      timing: timing(group.values),
    }))
    .sort((a, b) =>
      `${a.environment}:${a.provider}`.localeCompare(
        `${b.environment}:${b.provider}`,
      ),
    );

  const resumes = scoreOutcomeEvents(windowEvents, "sandbox_resume_metric");
  const restartSurvival = scoreOutcomeEvents(
    windowEvents,
    "sandbox_restart_survival_metric",
  );
  const hostTurns = turns.filter((score) => score.environment === "worktree");
  const sandboxTurns = turns.filter((score) => score.environment === "sandbox");
  const hostPreviews = previews.filter(
    (score) => score.environment === "worktree",
  );
  const sandboxPreviews = previews.filter(
    (score) => score.environment === "sandbox",
  );
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0);
  const weightedFailureRate = (scores: TurnScore[]) => {
    const total = sum(scores.map((score) => score.turns));
    return total ? sum(scores.map((score) => score.failed)) / total : null;
  };
  const pooledMedian = (scores: TurnScore[], field: "firstToken") => {
    // Provider-level medians are sufficient only for display. Gate on raw
    // samples so a low-volume provider cannot carry the aggregate.
    const values = windowEvents
      .filter(
        (event) =>
          event.kind === "session_turn_metric" &&
          (event.environment === "sandbox" ? "sandbox" : "worktree") ===
            (scores[0]?.environment ?? "missing"),
      )
      .map((event) => finiteNumber(event.start_to_first_token_ms))
      .filter((value): value is number => value !== null);
    return field === "firstToken" ? percentile(values, 0.5) : null;
  };

  const reasons: string[] = [];
  const hostTurnCount = sum(hostTurns.map((score) => score.turns));
  const sandboxTurnCount = sum(sandboxTurns.map((score) => score.turns));
  if (hostTurnCount < SCORECARD_THRESHOLDS.minimumTurnsPerEnvironment) {
    reasons.push(
      `Need ${SCORECARD_THRESHOLDS.minimumTurnsPerEnvironment - hostTurnCount} more worktree turns.`,
    );
  }
  if (sandboxTurnCount < SCORECARD_THRESHOLDS.minimumTurnsPerEnvironment) {
    reasons.push(
      `Need ${SCORECARD_THRESHOLDS.minimumTurnsPerEnvironment - sandboxTurnCount} more sandbox turns.`,
    );
  }
  const sandboxDays = new Set(
    windowEvents
      .filter(
        (event) =>
          event.kind === "session_turn_metric" &&
          event.environment === "sandbox",
      )
      .map(dayOf)
      .filter((day): day is string => day !== null),
  ).size;
  if (sandboxDays < SCORECARD_THRESHOLDS.minimumSandboxDays) {
    reasons.push(
      `Need sandbox use on ${SCORECARD_THRESHOLDS.minimumSandboxDays - sandboxDays} more distinct days.`,
    );
  }
  const hostPreviewCount = sum(
    hostPreviews.map((score) => score.timing.samples),
  );
  const sandboxPreviewCount = sum(
    sandboxPreviews.map((score) => score.timing.samples),
  );
  if (hostPreviewCount < SCORECARD_THRESHOLDS.minimumPreviewsPerEnvironment) {
    reasons.push(
      `Need ${SCORECARD_THRESHOLDS.minimumPreviewsPerEnvironment - hostPreviewCount} more worktree preview starts.`,
    );
  }
  if (
    sandboxPreviewCount < SCORECARD_THRESHOLDS.minimumPreviewsPerEnvironment
  ) {
    reasons.push(
      `Need ${SCORECARD_THRESHOLDS.minimumPreviewsPerEnvironment - sandboxPreviewCount} more sandbox preview starts.`,
    );
  }
  const resumeAttempts = sum(resumes.map((score) => score.attempts));
  if (resumeAttempts < SCORECARD_THRESHOLDS.minimumSandboxResumes) {
    reasons.push(
      `Need ${SCORECARD_THRESHOLDS.minimumSandboxResumes - resumeAttempts} more sandbox wake/resume samples.`,
    );
  }
  const restartAttempts = sum(restartSurvival.map((score) => score.attempts));
  if (restartAttempts < SCORECARD_THRESHOLDS.minimumRestartAttempts) {
    reasons.push(
      `Need ${SCORECARD_THRESHOLDS.minimumRestartAttempts - restartAttempts} more sandbox restart-survival samples.`,
    );
  }

  const hostMedian = pooledMedian(hostTurns, "firstToken");
  const sandboxMedian = pooledMedian(sandboxTurns, "firstToken");
  if (
    hostMedian !== null &&
    sandboxMedian !== null &&
    sandboxMedian > hostMedian
  ) {
    reasons.push(
      `Sandbox median first-token latency (${sandboxMedian} ms) exceeds worktree (${hostMedian} ms).`,
    );
  }
  const hostFailureRate = weightedFailureRate(hostTurns);
  const sandboxFailureRate = weightedFailureRate(sandboxTurns);
  if (
    hostFailureRate !== null &&
    sandboxFailureRate !== null &&
    sandboxFailureRate >
      hostFailureRate + SCORECARD_THRESHOLDS.maximumFailureRateRegression
  ) {
    reasons.push(
      "Sandbox turn failure rate exceeds the worktree rate by more than 2 percentage points.",
    );
  }
  const restartSuccessful = sum(
    restartSurvival.map((score) => score.successful),
  );
  if (
    restartAttempts >= SCORECARD_THRESHOLDS.minimumRestartAttempts &&
    restartSuccessful / restartAttempts <
      SCORECARD_THRESHOLDS.requiredRestartSurvivalRate
  ) {
    reasons.push(
      "Not every observed sandbox run survived the Open Session restart.",
    );
  }

  return {
    generatedAt: now.toISOString(),
    window: { days, from, through },
    thresholds: SCORECARD_THRESHOLDS,
    turns,
    previews,
    resumes,
    restartSurvival,
    gate: {
      automaticReady: reasons.length === 0,
      defaultFlipApproved: false,
      readyToFlip: false,
      reasons,
      note: "Passing metrics nominate the default flip; they never approve it. The human decision in docs/self-hosting-sandboxes.md remains required.",
    },
  };
}

export function readSandboxScorecard(
  days = SCORECARD_DEFAULT_DAYS,
): SandboxScorecard {
  const boundedDays = Math.min(90, Math.max(1, Math.floor(days)));
  const now = new Date();
  const events: AuditEvent[] = [];
  const auditDir = stateDir("audit");
  for (let offset = 0; offset < boundedDays; offset++) {
    const date = utcDate(offset, now);
    const path = `${auditDir}/audit-${date}.jsonl`;
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as AuditEvent;
        if (
          event.kind === "session_turn_metric" ||
          event.kind === "preview_ready_metric" ||
          event.kind === "sandbox_resume_metric" ||
          event.kind === "sandbox_restart_survival_metric"
        ) {
          events.push(event);
        }
      } catch {}
    }
  }
  return buildSandboxScorecard(events, { days: boundedDays, now });
}
