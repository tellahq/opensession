/** Transcript entry builders and the single-writer owned-store bridge. */
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import type { TranscriptEntry } from "./types";
import type { AnsweredAskData } from "@tellahq/opensession-protocol/notices";
import type { ImageInput } from "./run-events";
import { parseJsonlLines } from "./jsonl-parser";
import { appendTranscriptEvents } from "./actor-transcript";
import { transcriptForwarder } from "./transcript-forward";

let ENGINE_SESSION_MAP_PATH =
  process.env.OPENSESSION_ENGINE_SESSION_MAP ||
  `${OPENSESSION_SESSIONS_DIR}/engine-session-map.json`;

interface OwnerMapState {
  map: Map<string, string>;
  loaded: boolean;
  warned: Set<string>;
}

const ownerState: OwnerMapState = ((
  globalThis as Record<string, unknown> & {
    __osEngineSessionOwners?: OwnerMapState;
  }
).__osEngineSessionOwners ??= {
  map: new Map(),
  loaded: false,
  warned: new Set(),
});

function ownerMap(): Map<string, string> {
  if (ownerState.loaded) return ownerState.map;
  ownerState.loaded = true;
  try {
    if (existsSync(ENGINE_SESSION_MAP_PATH)) {
      const parsed = JSON.parse(readFileSync(ENGINE_SESSION_MAP_PATH, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [engineId, sessionId] of Object.entries(parsed)) {
          if (typeof sessionId === "string" && sessionId) {
            ownerState.map.set(engineId, sessionId);
          }
        }
      }
    }
  } catch (error) {
    console.warn("[transcript] engine-session map read failed:", error);
  }
  return ownerState.map;
}

export function __setEngineSessionMapPathForTest(path: string): string {
  const previous = ENGINE_SESSION_MAP_PATH;
  ENGINE_SESSION_MAP_PATH = path;
  ownerState.map = new Map();
  ownerState.loaded = false;
  ownerState.warned = new Set();
  return previous;
}

const OWNER_MAP_MAX_ENTRIES = 10_000;

export function recordEngineSessionOwner(
  engineSessionId: string,
  sessionId: string,
): void {
  if (!engineSessionId || !sessionId) return;
  try {
    const map = ownerMap();
    if (map.get(engineSessionId) === sessionId) return;
    map.set(engineSessionId, sessionId);
    while (map.size > OWNER_MAP_MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (!oldest || oldest === engineSessionId) break;
      map.delete(oldest);
    }
    writeJsonAtomic(ENGINE_SESSION_MAP_PATH, Object.fromEntries(map));
  } catch (error) {
    console.warn("[transcript] engine-session map write failed:", error);
  }
}

export function sessionForEngineId(
  engineSessionId: string | null | undefined,
): string | undefined {
  return engineSessionId ? ownerMap().get(engineSessionId) : undefined;
}

const degraded: Set<string> = ((
  globalThis as Record<string, unknown> & {
    __osTranscriptStoreDegraded?: Set<string>;
  }
).__osTranscriptStoreDegraded ??= new Set());

export function markTranscriptStoreDegraded(
  id: string | null | undefined,
): void {
  if (id) degraded.add(id);
}

export function isTranscriptStoreDegraded(
  ...ids: Array<string | null | undefined>
): boolean {
  return ids.some((id) => !!id && degraded.has(id));
}

export function clearTranscriptStoreDegraded(
  ...ids: Array<string | null | undefined>
): void {
  for (const id of ids) if (id) degraded.delete(id);
}

const warnedFailures = new Set<string>();
function warnFailureOnce(id: string, message: string, error: unknown): void {
  if (warnedFailures.has(id)) return;
  warnedFailures.add(id);
  console.warn(
    `${message} (further warnings suppressed for this session)`,
    error,
  );
}

async function appendLines(
  engineSessionId: string,
  lines: JsonlLine[],
): Promise<void> {
  const sessionId = sessionForEngineId(engineSessionId);
  if (!sessionId) {
    markTranscriptStoreDegraded(engineSessionId);
    if (!ownerState.warned.has(engineSessionId)) {
      ownerState.warned.add(engineSessionId);
      console.warn(
        `[transcript] no session owner mapped for ${engineSessionId}`,
      );
    }
    return;
  }
  try {
    const entries = parseJsonlLines(lines.map((line) => JSON.stringify(line)));
    if (entries.length) await appendTranscriptEvents(sessionId, entries);
  } catch (error) {
    markTranscriptStoreDegraded(sessionId);
    warnFailureOnce(
      sessionId,
      `[transcript] append failed for ${sessionId}`,
      error,
    );
  }
}

export async function storeAppendUserLineEarly(
  sessionId: string,
  line: Record<string, unknown>,
  options: { required?: boolean } = {},
): Promise<void> {
  if (!sessionId) return;
  const forward = transcriptForwarder();
  if (forward) {
    forward(sessionId, [line]);
    return;
  }
  try {
    const entries = parseJsonlLines([JSON.stringify(line)]);
    if (entries.length) await appendTranscriptEvents(sessionId, entries);
  } catch (error) {
    warnFailureOnce(
      sessionId,
      `[transcript] early user-line persist failed for ${sessionId}`,
      error,
    );
    if (options.required) throw error;
  }
}

type JsonlLine = Record<string, unknown>;

export function transcriptLineUser(
  text: string,
  id?: string,
  ts?: string,
  images?: ImageInput[],
  sourceMessageIds?: string[],
): JsonlLine {
  return {
    type: "user",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    ...(sourceMessageIds?.length ? { sourceMessageIds } : {}),
    message: {
      role: "user",
      content: [
        { type: "text", text },
        // Pasted images ride alongside the text block in the same claude-shape
        // blocks jsonl-parser's extractImages reads — without them the mirror
        // file loses the images the run actually received (they only exist in
        // pi's SQLite as `file` parts, which nothing renders).
        ...(images || []).map((im) => ({
          type: "image",
          source: { type: "base64", media_type: im.mediaType, data: im.data },
        })),
      ],
    },
  };
}

/** Runner operational notice ("usage limit hit; switched account and
 *  retrying") as a durable transcript line. Rides a user-role line — the only
 *  role the runner can inject without claiming the model said something — with
 *  a harness marker the jsonl parser maps to a `system` entry (same pattern as
 *  `<task-notification>`), so it renders as a system chip instead of a user
 *  bubble and never confuses pending-bubble/steer reconciliation. */
export function transcriptLineRunnerNotice(
  text: string,
  id?: string,
  ts?: string,
): JsonlLine {
  return transcriptLineUser(`<runner-notice>${text}</runner-notice>`, id, ts);
}

/** Engine context-compaction summary (engine compaction: a synthetic user
 *  message with a `compaction` part, answered by an assistant message with
 *  `summary: true` whose text is the handoff summary). Same user-role +
 *  harness-marker pattern as runner notices; the jsonl parser maps it to a
 *  system entry tagged `noticeKind: "compaction"` so the UI renders a collapsed
 *  "context compacted" chip instead of an assistant bubble. */
export function transcriptLineCompactionSummary(
  text: string,
  id?: string,
  ts?: string,
): JsonlLine {
  return transcriptLineUser(
    `<compaction-summary>${text}</compaction-summary>`,
    id,
    ts,
  );
}

/** Session recap (away-summary): the one-liner recap.ts generates when a
 *  viewer returns to a session whose turn finished with nobody watching. Same
 *  user-role + harness-marker pattern as runner notices; the jsonl parser maps
 *  it to a system entry tagged `noticeKind: "recap"` so the UI renders a recap line
 *  instead of a user bubble. */
export function transcriptLineRecap(
  text: string,
  id?: string,
  ts?: string,
): JsonlLine {
  return transcriptLineUser(`<recap>${text}</recap>`, id, ts);
}

/** A model-visible payload the harness injected into a prompt — the
 *  "model-visible means logged" record written by context-log.ts. Same
 *  user-role + harness-marker pattern as runner notices; the jsonl parser maps
 *  it to a system entry tagged `noticeKind: "context-injection"` carrying its
 *  source and turn, which every client-bound projection then drops. Riding the
 *  ordinary entry path is the point: blob-splitting bounds a 180KB handoff the
 *  same way it bounds any other oversized entry, and the ws protocol needs no
 *  new frame. */
/** Persist an answered question card after its transient UI card closes.
 *  The ordinary message text is the compatibility record. `ask` is an optional
 *  sibling field in the JSONL line, so old parsers ignore it without losing the
 *  readable fallback and current clients can rebuild the original card. */
export function transcriptLineAskRecord(
  text: string,
  ask?: AnsweredAskData,
  id?: string,
  ts?: string,
): JsonlLine {
  return {
    ...transcriptLineUser(`<ask-record>${text}</ask-record>`, id, ts),
    ...(ask ? { ask } : {}),
  };
}

export function transcriptLineContextInjection(
  body: string,
  meta: { source: string; turnId?: string },
  id?: string,
  ts?: string,
): JsonlLine {
  const attrs = [
    ` source="${meta.source}"`,
    meta.turnId ? ` turn="${meta.turnId}"` : "",
  ].join("");
  return transcriptLineUser(
    `<context-injection${attrs}>${body}</context-injection>`,
    id,
    ts,
  );
}

/** Model-visible input that stands between turns rather than riding one: the
 *  run's tool surface, the engine's standing instructions (context-log.ts).
 *  Same user-role + harness-marker pattern as the injection line above; the
 *  jsonl parser maps it to a system entry tagged `noticeKind:
 *  "standing-context"`, which the same projections drop. `hash` is the sha256
 *  of the body and `bytes` its length, so a reader can tell two records of one
 *  source apart without re-hashing, and the close tag is matched greedily on
 *  the read side — a recorded instructions file that quotes this very marker
 *  must round-trip whole rather than truncate. */
export function transcriptLineStandingContext(
  body: string,
  meta: { source: string; hash: string; bytes: number; turnId?: string },
  id?: string,
  ts?: string,
): JsonlLine {
  const attrs = [
    ` source="${meta.source}"`,
    ` hash="${meta.hash}"`,
    ` bytes="${meta.bytes}"`,
    meta.turnId ? ` turn="${meta.turnId}"` : "",
  ].join("");
  return transcriptLineUser(
    `<standing-context${attrs}>${body}</standing-context>`,
    id,
    ts,
  );
}

export function transcriptLineAssistantText(
  text: string,
  id?: string,
  ts?: string,
  model?: string,
  isReasoning?: boolean,
): JsonlLine {
  return {
    type: "assistant",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    ...(isReasoning ? { isReasoning: true } : {}),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      // Same slot the Claude SDK uses on its assistant lines, so the shared
      // jsonl parser reads both without a special case.
      ...(model ? { model } : {}),
    },
  };
}

export function transcriptLineToolUse(
  toolUseId: string,
  name: string,
  input: unknown,
  ts?: string,
): JsonlLine {
  return {
    type: "assistant",
    uuid: `${toolUseId}-use`,
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input: input ?? {} }],
    },
  };
}

export function transcriptLineToolResult(
  toolUseId: string,
  content: string,
  isError?: boolean,
  ts?: string,
  images?: string[],
): JsonlLine {
  return {
    type: "user",
    uuid: `${toolUseId}-result`,
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: images?.length
            ? [
                { type: "text", text: content },
                ...images.map((url) => ({
                  type: "image",
                  source: { type: "url", url },
                })),
              ]
            : content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

/** Map an already-parsed TranscriptEntry (any engine) back onto a claude-shape
 *  jsonl line, preserving ids so re-parsed copies upsert instead of duplicate.
 *  Since mirror retirement this is internal normalization plumbing only: the
 *  reattach gap-backfill route entries through
 *  transcriptLineForEntry → parseJsonlLines → appendTranscriptEvents so every
 *  writer shares ONE parse/identity path into the store — no file is written. */
export function transcriptLineForEntry(e: TranscriptEntry): JsonlLine | null {
  switch (e.type) {
    case "user": {
      const line = transcriptLineUser(e.content, e.id, e.timestamp);
      if (e.images?.length) {
        // Entry images are ready-to-render srcs (data: or http(s) URLs) — a
        // url-source image block round-trips both through extractImages.
        (line.message as { content: unknown[] }).content.push(
          ...e.images.map((src) => ({
            type: "image",
            source: { type: "url", url: src },
          })),
        );
      }
      return line;
    }
    case "assistant":
      return transcriptLineAssistantText(
        e.content,
        e.id,
        e.timestamp,
        e.model,
        e.isReasoning,
      );
    case "tool_use":
      return transcriptLineToolUse(
        e.toolUseId || e.id,
        e.toolName || "Tool",
        e.toolInput,
        e.timestamp,
      );
    case "tool_result":
      return e.toolUseId
        ? transcriptLineToolResult(
            e.toolUseId,
            e.content,
            e.isError,
            e.timestamp,
            e.images,
          )
        : null;
    case "system":
      // Compaction summaries round-trip (engine transcripts emit them and
      // the reattach gap-backfill must not drop them). The parser derives the
      // entry id as `sys-<line uuid>`, so strip the prefix to keep the upsert
      // key stable. Other system entries stay derived-only.
      return e.noticeKind === "compaction"
        ? transcriptLineCompactionSummary(
            e.content,
            e.id.startsWith("sys-") ? e.id.slice(4) : e.id,
            e.timestamp,
          )
        : null;
    default:
      return null;
  }
}

export async function appendTranscriptEntries(
  engineSessionId: string,
  lines: JsonlLine[],
): Promise<void> {
  if (lines.length) await appendLines(engineSessionId, lines);
}

export async function applyForwardedTranscriptStrict(
  sessionId: string,
  engineSessionId: string,
  lines: JsonlLine[],
): Promise<void> {
  if (!sessionId || !lines.length)
    throw new Error("Invalid forwarded transcript projection");
  if (engineSessionId && engineSessionId !== sessionId)
    recordEngineSessionOwner(engineSessionId, sessionId);
  const entries = parseJsonlLines(lines.map((line) => JSON.stringify(line)));
  if (entries.length) await appendTranscriptEvents(sessionId, entries);
}

export async function applyForwardedTranscript(
  sessionId: string,
  engineSessionId: string,
  lines: JsonlLine[],
): Promise<void> {
  if (!sessionId || !lines.length) return;
  try {
    if (!engineSessionId || engineSessionId === sessionId) {
      const entries = parseJsonlLines(
        lines.map((line) => JSON.stringify(line)),
      );
      if (entries.length) await appendTranscriptEvents(sessionId, entries);
      return;
    }
    recordEngineSessionOwner(engineSessionId, sessionId);
    await appendTranscriptEntries(engineSessionId, lines);
  } catch (error) {
    warnFailureOnce(
      sessionId,
      `[transcript] forwarded append failed for ${sessionId}`,
      error,
    );
  }
}
