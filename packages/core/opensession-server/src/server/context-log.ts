/**
 * Model-visible means logged.
 *
 * A turn's model input is more than the message a human typed: an engine
 * handoff transcript, the repos/memory note, an attached session's excerpt, a
 * ticket's context. All of it is deliberately invisible in the rendered
 * conversation (prompt-context.ts fences it; the parsers strip the fence), and
 * until this module none of it was written down anywhere — so a stored session
 * could not reproduce the request that produced its answers. Replay, eval and
 * "why did it do that" all need the real input.
 *
 * This records every injected payload as an ordinary `TranscriptEntry` — a
 * system entry tagged `context-injection` — at the point it reaches an engine.
 * Riding the normal entry path is deliberate: the store's blob-splitting
 * bounds a 180KB handoff exactly as it bounds any other oversized entry, the
 * bus/ws protocol needs no new frame, and deletion/import/export keep working.
 * Client-bound projections drop these entries (dropContextInjections), so no
 * viewer's transcript changes.
 *
 * ## The choke point
 *
 * `runOnModel` (agent-runner.ts) is where every engine dispatch happens —
 * pi, pi, and the test fake — for every
 * model of a fallback walk. One call there covers all of them, including the
 * handoff the walk itself prepends on a cross-provider hop, because it runs
 * once per hop with that hop's exact prompt.
 *
 * Its one blind spot is an injection added BELOW it: the pi runner
 * prepends a same-engine-restart handoff per attempt (pi-runner.ts), so
 * that site calls in too. Both calls are safe to overlap — an entry's id is
 * derived from its content, so re-logging a payload upserts its own row
 * instead of duplicating it, and the in-process dedupe below usually skips the
 * write entirely.
 *
 * ## Standing context
 *
 * Not every model-visible input rides a turn. A run's tool surface and its
 * standing instructions are properties of the checkout and the run config: the
 * model sees them on every turn, unchanged, for the life of a session. Copying
 * a multi-KB blob onto each turn would bloat every transcript to say the same
 * thing a hundred times, so `logStandingContext` records each source ONCE and
 * again only when its content hash moves. A reader reconstructs a turn's
 * standing input by taking the newest record of each source at or before it.
 *
 * The record is an ordinary entry again — same reasons, plus the store's
 * blob-splitting, which matters more here (a real instructions payload measured
 * 273KB). The hash rides as metadata and as the entry id rather than keying a
 * separate content-addressed table: the store already dedupes by entry id, so
 * one version of one source is one row however many times it is re-asserted,
 * and a parallel store is the thing this design exists to avoid.
 *
 * ## What is NOT covered
 *
 * The MCP tool SCHEMAS themselves — every mounted tool's name, description and
 * JSON schema, the largest single input at roughly 104k tokens a run — are not
 * recordable from here, and this is a limit of the engine rather than an
 * omission. Pi fetches them from each MCP server at startup and neither
 * persists nor exposes them: `/experimental/tool` returns only its own
 * built-ins (12 tools, 23KB) and `/mcp` returns a connection status per server
 * (verified against a live server, 2026-08-16). Obtaining them would mean
 * connecting to every configured MCP server ourselves, per session, with the
 * OAuth and subprocess cost that implies. So what is recorded is the tool
 * SURFACE: which servers were mounted, which tools were stripped, what the run
 * was scoped to. That reconstructs which tools the model had, not the wording
 * of each schema.
 *
 * An engine that assembles its own system prompt (the removed direct-SDK
 * engines did; historical sessions carry their records) logs the
 * `instructions` source at the point its text is final rather than from a
 * runner. What stays outside such a record is the vendor preset the engine
 * appends to, which is the engine's own text and not ours to record.
 */
import { createHash } from "crypto";
import {
  storeAppendUserLineEarly,
  transcriptLineContextInjection,
  transcriptLineStandingContext,
} from "./transcript-persistence";
import { parseContextBlocks, type ContextSource } from "./prompt-context";

export interface InjectedContextInput {
  /** Unified session id. No session ⇒ nothing to log against (see gaps). */
  sessionId?: string | null;
  /** The prompt's transcript entry id, or the run token — what groups a
   *  turn's injections with the message they rode with. */
  turnId?: string | null;
  /** Prompt body about to be sent; every fenced block in it is recorded. */
  prompt?: string | null;
  /** The per-turn system note (repos + memory), injected through the engine's
   *  system/instructions channel rather than the prompt body. */
  reposNote?: string | null;
  /** Model the payload was sent to, for the audit line. */
  model?: string;
}

/**
 * Entry ids already written this process run. An entry id is a content hash,
 * so this only ever skips a byte-identical re-append (a retry, a second call
 * from the pi runner) — the store would upsert those onto the same row
 * anyway; skipping saves the write and the bus wake. Bounded because a
 * long-lived server would otherwise accumulate one string per injection
 * forever; a drop past the bound costs one harmless upsert.
 */
const logged: Set<string> = ((globalThis as any).__osContextLogged ??=
  new Set());
const LOGGED_MAX = 5_000;

function remember(id: string): boolean {
  if (logged.has(id)) return false;
  if (logged.size >= LOGGED_MAX) logged.clear();
  logged.add(id);
  return true;
}

/** Deterministic, content-derived id: the same payload in the same turn is the
 *  same row, whichever call site logs it and however many times a turn is
 *  retried. */
function entryId(
  sessionId: string,
  turnId: string,
  source: string,
  body: string,
): string {
  const h = createHash("sha256")
    .update(`${sessionId}\u0000${turnId}\u0000${source}\u0000${body}`)
    .digest("hex");
  return `ctx-${h.slice(0, 32)}`;
}

/** Test seam: record instead of writing, so a test can assert the calls
 *  without a store. Null (the default) = the real store path. */
let sinkForTest:
  | ((rec: {
      sessionId: string;
      source: ContextSource | string;
      turnId: string;
      body: string;
    }) => void)
  | null = null;
export function __setContextLogSinkForTest(fn: typeof sinkForTest): void {
  sinkForTest = fn;
}

/**
 * Record every model-visible injected payload in `input`. Never throws: a
 * failed audit write must not fail the turn (the store helper already warns
 * once per session on failure).
 */
export function logInjectedContext(input: InjectedContextInput): void {
  const sessionId = input.sessionId || "";
  if (!sessionId) return;
  const turnId = input.turnId || "";
  const blocks: Array<{ source: ContextSource | string; body: string }> =
    parseContextBlocks(input.prompt || "");
  // The system-channel note (repos discipline + repo/user/team memory) is
  // model-visible without ever appearing in the prompt body, so it is logged
  // beside the fenced blocks rather than through them.
  const note = input.reposNote?.trim();
  if (note) blocks.push({ source: "repos-note", body: note });
  if (!blocks.length) return;

  for (const block of blocks) {
    const id = entryId(sessionId, turnId, block.source, block.body);
    if (!remember(id)) continue;
    if (sinkForTest) {
      sinkForTest({
        sessionId,
        source: block.source,
        turnId,
        body: block.body,
      });
      continue;
    }
    // The ordinary entry path — same helper the intake user line uses, so
    // the import-first gate, the 32KB blob split and the bus publish all
    // behave exactly as they do for any other entry.
    void storeAppendUserLineEarly(
      sessionId,
      transcriptLineContextInjection(
        block.body,
        { source: block.source, ...(turnId ? { turnId } : {}) },
        id,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Standing context
// ---------------------------------------------------------------------------

/**
 * What a standing record describes. A closed taxonomy for the same reason
 * `ContextSource` is one: the log is only queryable if the labels are.
 */
export type StandingContextSource =
  /** The run's tool scoping as the harness decided it, engine-neutral: the
   *  MCP allowlist, the in-process servers, the tool denials, the mode.
   *  Written at the runOnModel choke point, so every engine has one. */
  | "tools"
  /** The MCP servers an engine actually mounted for the run, plus the tool
   *  strips applied to them — the resolution of the scoping above, known
   *  only inside the runner. */
  | "mcp-servers"
  /** The standing instruction text the engine was given (pi's
   *  instructions file or the shared server's per-prompt `system`), which
   *  already folds in AGENTS.local.md / CLAUDE.local.md. Written wherever
   *  that text is final. */
  | "instructions"
  /** The first run's complete effective provider input: Pi's final system
   *  prompt after AGENTS.md, skills and tool guidance have been applied, plus
   *  the schemas of the active tools. This is the source the session viewer
   *  exposes as its collapsed, lazy-loaded "Session context" row. */
  | "session-start";

export interface StandingContextInput {
  /** Unified session id. No session ⇒ nothing to log against. */
  sessionId?: string | null;
  /** The turn that first saw this version, for grouping. */
  turnId?: string | null;
  source: StandingContextSource;
  /** The full content, recorded verbatim. */
  content?: string | null;
}

export interface SessionStartTool {
  name: string;
  description: string;
  parameters: unknown;
}

/** Build the exact, human-readable snapshot shown at the start of a session.
 * Kept here beside the writer so the audit record and the UI can never drift
 * into two reconstructions of what the provider received. */
export function sessionStartContext(
  systemPrompt: string,
  tools: SessionStartTool[],
): string {
  return [
    "# System prompt",
    systemPrompt,
    "# Tools",
    canonicalJson(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    ),
  ].join("\n\n");
}

/**
 * Content hash per (session, source) already recorded in this process. The
 * whole point of the standing-context record: a source is written when it
 * CHANGES, never per turn. A restart clears this, so the first turn after one
 * re-records each source — which is exactly when the run config could have
 * moved under the session, so it is a feature rather than a leak.
 */
const standing: Map<string, string> = ((
  globalThis as any
).__osStandingContext ??= new Map());
const STANDING_MAX = 5_000;

/** Stable JSON for hashing and for reading: keys sorted at every level, so a
 *  record's hash tracks its content and not the order a producer built its
 *  object in. Array order is left alone — the caller sorts where order carries
 *  no meaning. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort())
        out[k] = sorted((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sorted(value), null, 2);
}

/**
 * Record one standing model-visible input, if it changed.
 *
 * Never throws, and the try/catch is load-bearing rather than defensive
 * decoration: this runs inside `runOnModel`, so anything that escapes it kills
 * the turn it was only supposed to describe. It did, once, within an hour of
 * landing — `[...opts.mcpServers]` on a create-path run whose scope was
 * undefined despite the required type (2026-08-16). An audit record is never
 * worth a turn.
 */
export async function logStandingContext(
  input: StandingContextInput,
): Promise<void> {
  try {
    await appendStandingContext(input);
  } catch (e) {
    console.warn(
      `[context-log] standing "${input.source}" not recorded: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * The same, for a record built from structured values: the serialization
 * happens INSIDE the guard, which is where a producer's own bad input (a
 * missing field, a circular object) would otherwise escape.
 */
export async function logStandingJson(
  input: Omit<StandingContextInput, "content"> & { value: unknown },
): Promise<void> {
  try {
    await appendStandingContext({
      ...input,
      content: canonicalJson(input.value),
    });
  } catch (e) {
    console.warn(
      `[context-log] standing "${input.source}" not recorded: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function appendStandingContext(
  input: StandingContextInput,
): Promise<void> {
  const sessionId = input.sessionId || "";
  const content = input.content?.trim();
  if (!sessionId || !content) return;
  const hash = createHash("sha256").update(content).digest("hex");
  const key = `${sessionId}\u0000${input.source}`;
  if (standing.get(key) === hash) return;
  if (standing.size >= STANDING_MAX) standing.clear();
  standing.set(key, hash);
  const turnId = input.turnId || "";
  // Content-addressed, and deliberately NOT keyed by turn: one version of one
  // source is one row for the life of the session, so re-recording it upserts
  // in place instead of appending. The map above already skips the common
  // case; this is what covers the case it cannot see, a server restart, which
  // on this instance happens many times a day and would otherwise append
  // another copy of a 273KB instructions record per session per restart
  // (measured 2026-08-16).
  //
  // The cost is a source that changes A → B → A: the returning version
  // upserts A's original row rather than earning a later one, so the
  // timeline reads as if B were still in force. Rare, and cheap next to
  // unbounded duplication of the biggest record we write.
  const id = `std-${createHash("sha256")
    .update(`${sessionId}\u0000${input.source}\u0000${hash}`)
    .digest("hex")
    .slice(0, 32)}`;
  await storeAppendUserLineEarly(
    sessionId,
    transcriptLineStandingContext(
      content,
      {
        source: input.source,
        hash,
        bytes: Buffer.byteLength(content, "utf8"),
        ...(turnId ? { turnId } : {}),
      },
      id,
    ),
  );
}
