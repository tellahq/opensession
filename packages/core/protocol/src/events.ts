/**
 * Engine-neutral run event types shared by the runner (pi) and by
 * everything that consumes a run's event stream (opensession.ts, sandbox
 * providers, the runner host).
 */

/**
 * Token/cost accounting for a single run (accumulated across all turns in the
 * run — steers and background-task follow-ups included), attached to the
 * terminal `done` event. `contextTokens` is the last turn's full prompt size
 * (input + cache read + cache creation) — the live "how full is the context
 * window" figure.
 */
export interface TurnUsage {
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
}

/** A large Anthropic turn after the first should reuse at least some prefix. */
export function isLikelyPromptCacheMiss(
  usage: TurnUsage,
  userTurns: number,
  providerId: string,
): boolean {
  if (
    providerId !== "anthropic" ||
    userTurns < 2 ||
    usage.contextTokens < 10_000
  )
    return false;
  return (
    usage.cacheReadTokens < 1_024 &&
    usage.cacheReadTokens / usage.contextTokens < 0.05
  );
}

/** Prompt size + cache reuse of one completed model step, for the rebuild
 *  detector below. */
export interface StepPromptUsage {
  contextTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Did the layer BELOW pi silently rebuild this conversation's context
 * between two steps of the same turn?
 *
 * Anthropic models run through the bundled Meridian bridge onto Claude Agent
 * SDK sessions, and two things down there can replace the conversation without
 * pi (or us) ever seeing it: the SDK auto-compacting its session near the
 * context limit, and Meridian classifying a request as diverged and replaying
 * the history into a fresh SDK session. Both look identical from here — the
 * next step reads NOTHING from the prompt cache and writes a new prefix, after
 * the previous step read a large one. The model gets handed a rewritten
 * conversation mid-task, which is a decent way to end up re-orienting and
 * stopping (2026-08-03 incident: 262k → 94k between step 5 and 6, then the
 * turn ended on "Let me examine that commit."; 32 rebuilds across 6.4k steps in
 * the three days before that).
 *
 * Deliberately conservative — a cold cache on a turn's FIRST step is ordinary
 * (expiry, a rotation to another account, a fresh server), so this only fires
 * with a warm predecessor inside the same attempt. Callers keep per-attempt
 * state, so a rotation's fresh pump starts with no predecessor and can't
 * trigger it.
 */
export function isContextRebuildStep(
  previous: StepPromptUsage | undefined,
  current: StepPromptUsage,
): boolean {
  if (!previous || previous.cacheReadTokens < 50_000) return false;
  return current.cacheReadTokens === 0 && current.cacheCreationTokens > 20_000;
}

/** Human-readable line for a detected rebuild — the durable transcript note. */
export function contextRebuildNotice(
  previous: StepPromptUsage,
  current: StepPromptUsage,
): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return (
    `The engine rebuilt this conversation's context mid-turn (${k(previous.contextTokens)} → ` +
    `${k(current.contextTokens)} tokens, prompt cache cold). The model continued from a ` +
    "rewritten context and may have lost detail from earlier in the turn."
  );
}

export interface StreamEvent {
  type:
    | "init"
    | "text_chunk"
    | "tool_use"
    | "tool_result"
    | "usage_snapshot"
    // Internal runner acknowledgement: an accepted steer crossed the engine's
    // step boundary. The server consumes this before broadcasting run events.
    | "steer_delivered"
    | "done"
    | "error"
    | "model_switch"
    // Runner-injected operational notice (`text`), e.g. "usage limit hit on
    // account X; switched to Y and retrying". NOT part of the model's reply —
    // the runner persists it as a durable system line in the session
    // transcript (the remote mirror does the same host-side), so stream
    // consumers should not fold it into assistant text.
    | "runner_notice";
  sessionId?: string;
  text?: string;
  /**
   * On a text_chunk: which assistant block this text belongs to, when the
   * engine names its blocks (pi's part id). The durable transcript
   * entry for that block carries the SAME id, which is what lets a viewer
   * cancel the live copy exactly when the durable one lands, instead of
   * subtracting strings (see LiveTextBuffer in the protocol package).
   */
  blockId?: string;
  /** On a model_switch: the exhausted model and the fallback it switched to. */
  fromModel?: string;
  toModel?: string;
  /** On a model_switch: why — "out of credits" (usage) vs a transient engine
   *  failure. Consumers building modelHistory labels should use this instead
   *  of assuming out-of-credits (the 2026-07-17 outage was mislabeled). */
  switchReason?: "out of credits" | "hit a transient engine error";
  /** The selected model is still viable; this fallback only rescues this turn. */
  temporaryFallback?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  /** Exact queue receipt on an internal steer_delivered event. */
  steerId?: string;
  content?: string;
  result?: string;
  /**
   * Renderable image sources on a tool_result (data: URLs, direct URLs, or
   * authenticated local-media paths). Forwarded to viewers so screenshots
   * show up the moment the tool returns instead of waiting for persistence.
   */
  images?: string[];
  /**
   * Renderable video sources on a tool_result, parsed from `OPENSESSION_VIDEO:`
   * markers in the (full, pre-truncation) tool output. Forwarded so recordings
   * play the moment the tool returns, no reload needed.
   */
  videos?: string[];
  /**
   * The subset of `images`/`videos` that came from an explicit
   * `OPENSESSION_IMAGE:`/`OPENSESSION_VIDEO:` marker — the agent asking for
   * this one to be shown. Viewers open the tool row for these and leave
   * incidental media (a Read, a path mentioned in output) folded away. Mirrors
   * `TranscriptEntry.featuredMedia`; see that field for the full contract.
   */
  featuredMedia?: string[];
  /** Which backend emitted this event (set on init/done). */
  provider?: "claude" | "codex" | "pi";
  /** Effective model for the run (set on init/done). */
  model?: string;
  /**
   * Cumulative token/cost accounting for the run. Set on terminal `done` or
   * `error` events when the provider completed billable work (authoritative),
   * and on every `usage_snapshot` (live mid-run figures — always
   * run-cumulative, so consumers fold a snapshot onto the pre-run base rather
   * than onto the previous snapshot).
   */
  usage?: TurnUsage;
  /** This completed Anthropic turn unexpectedly reused almost none of its prompt. */
  cacheMissWarning?: boolean;
  /** On a terminal `error`: the runner already persisted its own (friendlier)
   *  system line for this failure (e.g. the turn-timeout notice) — consumers
   *  that persist terminal errors to the transcript must not add a second. */
  noticePersisted?: boolean;
  /**
   * Set on a terminal done/error when the run died on usage limits with no
   * account left to rotate to — the dispatcher's cue to try a fallback model.
   */
  usageLimitExhausted?: boolean;
}

/**
 * Usage exhaustion of the selected model changes the session selection so the
 * next turn does not immediately hit the same dry pool. A temporary fallback
 * must not rewrite what the user selected, even if a later rung also exhausts.
 */
export function shouldPersistModelSwitch(
  event: Pick<StreamEvent, "type" | "switchReason" | "temporaryFallback">,
): boolean {
  return (
    event.type === "model_switch" &&
    event.temporaryFallback !== true &&
    (event.switchReason === undefined ||
      event.switchReason === "out of credits")
  );
}

/** A pasted/dropped image, decoded to raw base64 (no `data:` prefix). */
export interface ImageInput {
  mediaType: string;
  data: string;
}
