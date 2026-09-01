/**
 * Tool-less single-prompt helper backed by Pi.
 *
 * Callers use this for titles, branch names, classifiers, recaps, and the Dial
 * oracle. Every call gets a throwaway Pi session with no local or MCP tools.
 * It is fail-soft by contract: any model, timeout, or provider failure returns
 * null so each caller can keep its deterministic fallback.
 */
import { mkdirSync, rmSync } from "fs";
import { audit } from "./audit";
import { cancelPiRun, parsePiModel, PI_STATE_DIR, runPi } from "./pi-runner";
import {
  configuredHaikuFallbackModel,
  toPiModel,
  type SessionEffort,
} from "./models";
import { isShuttingDown } from "./shutdown-state";
import { envCapacity } from "./shared/env-capacity";

const DEFAULT_ONESHOT_MODEL = "pi/anthropic/claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 120_000;
const ONESHOT_CWD = `${PI_STATE_DIR}/oneshot`;
const ONESHOT_CONCURRENCY = envCapacity(
  "OPENSESSION_ONESHOT_CONCURRENCY",
  4,
  1,
  64,
);

type OneShotPool = {
  active: number;
  waiters: Array<() => void>;
};
const pool: OneShotPool = ((globalThis as any).__piOneShotPool ??= {
  active: 0,
  waiters: [],
});

async function acquireOneShotSlot(): Promise<() => void> {
  if (pool.active >= ONESHOT_CONCURRENCY) {
    await new Promise<void>((resolve) => pool.waiters.push(resolve));
  } else {
    pool.active++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = pool.waiters.shift();
    if (next) next();
    else pool.active = Math.max(0, pool.active - 1);
  };
}

export interface OneShotOpts {
  /** Additional high-priority instructions injected into Pi's system context. */
  system?: string;
  /** Any native, Pi, or Pi model id. It is routed onto Pi. */
  model?: string;
  /** Account-affinity user for provider-pool selection. */
  user?: string;
  /** Call-site label for audit rows. */
  label?: string;
  effort?: SessionEffort;
  timeoutMs?: number;
}

/** Resolve one-shot model configuration onto Pi, preserving provider + tier. */
export function oneShotModel(model?: string): string | undefined {
  const requested =
    model || process.env.OPENSESSION_ONESHOT_MODEL || DEFAULT_ONESHOT_MODEL;
  return toPiModel(requested);
}

const HAIKU_FALLOVER_SHAPES =
  /usage[-_ ]?limit|weekly limit|no usable|exhausted|sidelined|rate[-_ ]?limit|quota|subscription access|disabled Claude|timed out|overloaded|too many requests|\b(429|500|502|503|529)\b|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i;

export function haikuOneShotShouldFallOver(error: string | null): boolean {
  if (!error) return true;
  return HAIKU_FALLOVER_SHAPES.test(error);
}

export function haikuOneShotFallbackModel(
  model: string | undefined,
  error: string | null,
): string | undefined {
  if (!model?.startsWith("pi/anthropic/claude-haiku-")) return undefined;
  if (!haikuOneShotShouldFallOver(error)) return undefined;
  const fallback = configuredHaikuFallbackModel();
  if (!fallback?.startsWith("pi/openai/") || fallback === model)
    return undefined;
  return fallback;
}

/** What a one-shot did: the answer, or the reason there is not one.
 *  `oneShot` collapses this to null by design, since every caller has a
 *  deterministic fallback and must not have to catch. But a caller that can
 *  ACT on the reason needs it to survive that collapse: the Dial oracle
 *  retries on another provider when the pool is dry, and says so instead of
 *  reporting a bare "unavailable" that sends the reader to journalctl. */
export type OneShotResult = { text: string | null; error: string | null };

/** Run one tool-less Pi prompt and return its settled assistant text. */
export async function oneShot(
  prompt: string,
  opts: OneShotOpts = {},
): Promise<string | null> {
  return (await oneShotDetailed(prompt, opts)).text;
}

/** As `oneShot`, but reports why an empty answer is empty. */
export async function oneShotDetailed(
  prompt: string,
  opts: OneShotOpts = {},
): Promise<OneShotResult> {
  const primaryModel = oneShotModel(opts.model);
  const primary = await runOneShotAttempt(prompt, opts);
  if (primary.text) return primary;
  if (process.env.NODE_ENV === "test") return primary;

  const fallbackModel = haikuOneShotFallbackModel(primaryModel, primary.error);
  if (!fallbackModel) return primary;

  const label = opts.label || "oneshot";
  console.warn(
    `[oneshot:${label}] Haiku unavailable (${primary.error || "empty answer"}); retrying on ${fallbackModel}`,
  );
  const fallback = await runOneShotAttempt(prompt, {
    ...opts,
    model: fallbackModel,
    label: `${label}-openai-fallback`,
  });
  if (fallback.text) return fallback;
  return {
    text: null,
    error: [
      primary.error ? `Haiku: ${primary.error}` : "Haiku: empty answer",
      fallback.error
        ? `OpenAI fallback: ${fallback.error}`
        : "OpenAI fallback: empty answer",
    ].join("; "),
  };
}

async function runOneShotAttempt(
  prompt: string,
  opts: OneShotOpts,
): Promise<OneShotResult> {
  // One-shots are real model calls. Import-heavy test suites rely on their
  // deterministic fallback paths and must never spend a model turn.
  if (process.env.NODE_ENV === "test") return { text: null, error: null };
  // Derived one-shots have deterministic fallbacks and no caller-owned durable
  // intent. Once shutdown starts, both new calls and calls waiting on bounded
  // capacity must park instead of creating fresh model work during the drain.
  if (isShuttingDown()) return { text: null, error: "server restarting" };

  const model = oneShotModel(opts.model);
  const label = opts.label || "oneshot";
  if (!model || !parsePiModel(model)) {
    console.warn(
      `[oneshot:${label}] model "${opts.model || ""}" does not resolve to Pi; skipping`,
    );
    return {
      text: null,
      error: `model "${opts.model || ""}" does not resolve to Pi`,
    };
  }

  const releaseSlot = await acquireOneShotSlot();
  if (isShuttingDown()) {
    releaseSlot();
    return { text: null, error: "server restarting" };
  }
  mkdirSync(ONESHOT_CWD, { recursive: true });
  const runKey = `oneshot-${crypto.randomUUID()}`;
  const sessionDir = `${PI_STATE_DIR}/sessions/${runKey}`;
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  let text = "";
  let settled = "";
  let error = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancelPiRun(runKey);
  }, timeoutMs);

  try {
    for await (const event of runPi(
      {
        prompt,
        // Supplying a private run key lets us remove Pi's native JSONL after
        // the call. No osSessionId means no Open Session transcript is made.
        sessionId: runKey,
        cwd: ONESHOT_CWD,
        mode: "ask",
        mcpServers: [],
        disableLocalWorkspaceTools: true,
        reposNote: opts.system
          ? `One-shot instructions (follow these for this response):\n${opts.system}`
          : "This is a tool-less one-shot text transformation. Return only the requested answer.",
        user: opts.user,
        effort: opts.effort,
        // Interactive pool semantics fail fast on a dry account. One-shots
        // already have deterministic caller fallbacks and must not join the
        // unattended ten-minute account wait queue.
        journal: { kind: "prompt" },
      },
      model,
    )) {
      if (event.type === "text_chunk") text += event.text || "";
      if (event.type === "error") error = event.content || "Pi one-shot failed";
      if (event.type === "done") settled = event.result || text;
    }

    if (timedOut) error = `timed out after ${timeoutMs}ms`;
    const answer = (settled || text).trim();
    audit({
      msg: "pi_oneshot",
      label,
      model,
      status: error ? "error" : "ok",
      duration_ms: Date.now() - startedAt,
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
    if (error) {
      console.warn(`[oneshot:${label}] failed: ${error}`);
      return { text: null, error };
    }
    return { text: answer || null, error: answer ? null : "empty answer" };
  } catch (e) {
    const message = String((e as Error)?.message || e);
    console.warn(`[oneshot:${label}] failed: ${message}`);
    audit({
      msg: "pi_oneshot",
      label,
      model,
      status: "error",
      error: message.slice(0, 500),
      duration_ms: Date.now() - startedAt,
    });
    return { text: null, error: message };
  } finally {
    clearTimeout(timer);
    // The generator has disposed the SDK session before this block runs.
    // A one-shot has no resume value, so its native JSONL must not accumulate.
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
    releaseSlot();
  }
}
