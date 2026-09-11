/**
 * Desk voice mode — shared pieces for the standing Desk session's voice
 * engines (src/server/desk.ts): the instance API key, the tool facade, and
 * the transcript mirror + handoff buffer.
 *
 * Two engines share them:
 * - GPT-Live (desk-voice-live.ts): the web Desk. The server creates the Live
 *   session, holds a sideband WebSocket, executes tool calls itself, and
 *   mirrors transcripts from the sideband. The browser only carries audio.
 * - GPT Realtime (mintVoiceSecret below): the native iOS app. The device
 *   talks to OpenAI directly with an ephemeral secret and relays tool calls
 *   and transcripts back over routes/desk-voice.ts.
 *
 * The Desk session stays the durable identity either way: voice turns are
 * mirrored into its transcript as they finalize, and a handoff note (consumed
 * by run-session.ts on the next text turn) bridges them into the text engine's
 * context — the transcript file and the engine's own conversation state are
 * separate stores, so without the handoff the next text turn would be
 * amnesiac about the call.
 *
 * The tool surface is a deliberately narrow facade over SessionControl and
 * todos plus the Desk's interactive MCP inventory. The server-side session
 * config (not the client) fixes the tool list, so a client can't expand what
 * OpenAI may call.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { ensureDeskSession } from "./desk";
import { getSessionControl } from "./session-control";
import { appendTranscriptEvents } from "./actor-transcript";
import type { InProcessMcpServer } from "./inprocess-mcp";
import type { TranscriptEntry } from "./types";

// Resolved per call rather than pinned at load, like sessionsDir() in
// paths.ts: a test (or a repointed state root) sets OPENSESSION_STATE_DIR
// after this module is imported and still gets its own store.
const dir = () => stateDir("desk");
const keyPath = () => `${dir()}/voice.json`;
const handoffDir = () => `${dir()}/voice-handoff`;

/** Realtime model for native (iOS) Desk voice calls. The web Desk runs on
 * GPT-Live instead; see desk-voice-live.ts. */
const DESK_VOICE_MODEL = "gpt-realtime";

/** Semantic endpointing avoids treating a short mid-sentence pause as the end
 * of the user's turn. Low eagerness is OpenAI's longest-waiting preset. */
export const DESK_VOICE_TURN_DETECTION = {
  type: "semantic_vad",
  eagerness: "low",
  create_response: true,
  interrupt_response: true,
} as const;

// ---------------------------------------------------------------------------
// API key store — instance-wide, set from Settings → Desk voice. Same contract
// as the model-provider key store: 0600 file, only ever returned masked. The
// web call's backend model choice lives in the same file: it is the other
// instance-wide voice setting, and one 0600 file is one thing to back up.

/** Reasoning + tool selection models a GPT-Live call may delegate to. Terra
 * is OpenAI's recommended default for Live backends; Luna is the
 * cost-sensitive option. Anything else is refused, not passed through. */
export const DESK_LIVE_BACKEND_MODELS = [
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export type LiveBackendModel = (typeof DESK_LIVE_BACKEND_MODELS)[number];
export const DESK_LIVE_BACKEND_MODEL: LiveBackendModel = "gpt-5.6-terra";

export function isLiveBackendModel(value: unknown): value is LiveBackendModel {
  return value === "gpt-5.6-terra" || value === "gpt-5.6-luna";
}

interface VoiceKeyFile {
  openaiApiKey?: string;
  liveBackendModel?: string;
}

async function readKeyFile(): Promise<VoiceKeyFile> {
  try {
    const value: unknown = JSON.parse(await readFile(keyPath(), "utf-8"));
    if (!value || typeof value !== "object")
      throw new Error("Invalid voice settings");
    return {
      openaiApiKey:
        "openaiApiKey" in value && typeof value.openaiApiKey === "string"
          ? value.openaiApiKey
          : undefined,
      liveBackendModel:
        "liveBackendModel" in value &&
        typeof value.liveBackendModel === "string"
          ? value.liveBackendModel
          : undefined,
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return {};
    throw error;
  }
}

// Serialize read-modify-write operations so simultaneous key/backend saves
// preserve each other. The temporary file is private before any key is written.
let settingsWrite: Promise<void> = Promise.resolve();
function updateKeyFile(
  update: (current: VoiceKeyFile) => VoiceKeyFile,
): Promise<void> {
  const path = keyPath();
  const operation = settingsWrite.then(async () => {
    const next = update(await readKeyFile());
    await mkdir(dir(), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  settingsWrite = operation.catch(() => {});
  return operation;
}

export async function voiceKeyConfigured(): Promise<boolean> {
  return !!(await readKeyFile()).openaiApiKey;
}

/** The configured key, or a thrown error pointing at Settings. */
export async function requireVoiceApiKey(): Promise<string> {
  const key = (await readKeyFile()).openaiApiKey;
  if (!key)
    throw new Error(
      "No OpenAI API key configured for Desk voice. Set one in Settings → Desk voice.",
    );
  return key;
}

export async function voiceKeyMasked(): Promise<string | undefined> {
  const key = (await readKeyFile()).openaiApiKey;
  return key ? `sk-…${key.slice(-4)}` : undefined;
}

/** Empty string clears the key without changing the backend. */
export function setVoiceKey(apiKey: string): Promise<void> {
  return updateKeyFile((current) => ({
    ...current,
    openaiApiKey: apiKey.trim() || undefined,
  }));
}

export async function voiceBackendModel(): Promise<LiveBackendModel> {
  const stored = (await readKeyFile()).liveBackendModel;
  return isLiveBackendModel(stored) ? stored : DESK_LIVE_BACKEND_MODEL;
}

/** Refuse unsupported ids before writing anything. */
export async function setVoiceBackendModel(
  model: unknown,
): Promise<LiveBackendModel> {
  if (!isLiveBackendModel(model))
    throw new Error(
      `Voice backend must be one of ${DESK_LIVE_BACKEND_MODELS.join(", ")}`,
    );
  await updateKeyFile((current) => ({ ...current, liveBackendModel: model }));
  return model;
}

// ---------------------------------------------------------------------------
// Ephemeral secret mint — the OpenAI API key never reaches the browser.

const VOICE_INSTRUCTIONS = `You are the user's Desk — their standing concierge for the Open Session workspace — currently on a voice call. You are the same Desk they type to; this call is one conversation with that Desk, not a separate assistant.

Voice discipline:
- Spoken register: short, natural sentences. One or two per reply. No markdown, no lists, no IDs read aloud unless asked — refer to sessions by title.
- You are an orchestrator, not the worker. For anything beyond a quick answer or a list edit, start a scoped worker session (start_session) and say you did.
- Use the tools for anything about real state — sessions, todos — never guess or invent. If a tool fails, say so plainly.
- Capture todos the moment the user mentions wanting or needing to do something. Never drop a todo unprompted.
- Before steering or starting sessions, a one-line confirmation of what you're about to do is enough; don't over-confirm reads.`;

export const VOICE_TOOLS = [
  {
    type: "function",
    name: "list_current_work",
    description:
      "List the user's sessions: what's running, waiting for input, queued, or recently active. Call this before answering any 'what's happening' question.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "inspect_session",
    description:
      "Look at one session: its state and the tail of its transcript.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session id" },
      },
      required: ["session_id"],
    },
  },
  {
    type: "function",
    name: "start_session",
    description:
      "Start a new work session with an opening prompt. Use mode 'code' when it should edit files or open a PR, 'ask' for read-only investigation.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Self-contained opening prompt: scope, constraints, what to report back.",
        },
        repo: {
          type: "string",
          description: "Registered repo id (omit for the default)",
        },
        mode: { type: "string", enum: ["ask", "code"] },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "steer_session",
    description:
      "Send a message into an existing session — steering a running one or starting its next turn.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["session_id", "message"],
    },
  },
];

async function voiceMcpServers(
  user: string,
  sessionId: string,
): Promise<Array<{ name: string; server: InProcessMcpServer }>> {
  const { interactiveMcpServers } = await import("./interactive-mcp");
  return Object.entries(interactiveMcpServers(user, sessionId))
    .filter((entry): entry is [string, InProcessMcpServer] =>
      Boolean((entry[1] as InProcessMcpServer | undefined)?.instance),
    )
    .map(([name, server]) => ({ name, server }));
}

function voiceToolName(server: string, tool: string): string {
  // Keep the existing concise names for the two original voice surfaces.
  // Other interactive servers are namespaced exactly like normal Desk tools,
  // avoiding collisions such as admin.list_memory vs memory.list_memory.
  return server === "opensession-sessions" || server === "opensession-todos"
    ? tool
    : `${server}_${tool}`;
}

export async function listVoiceMcpTools(user: string, sessionId: string) {
  const tools: Array<Record<string, unknown>> = [];
  for (const { name: serverName, server } of await voiceMcpServers(
    user,
    sessionId,
  )) {
    const client = new Client({ name: "desk-voice", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const { $schema: _schema, ...parameters } = tool.inputSchema;
        tools.push({
          type: "function",
          name: voiceToolName(serverName, tool.name),
          description: tool.description,
          parameters,
        });
      }
    } finally {
      await client.close();
      await server.instance.close();
    }
  }
  return tools;
}

/** Execute one of the normal Desk's interactive MCP tools under the verified
 * voice caller's identity. Exported for the voice/MCP contract test. */
export async function callVoiceMcpTool(
  user: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ found: boolean; result?: unknown }> {
  for (const { name: serverName, server } of await voiceMcpServers(
    user,
    sessionId,
  )) {
    const client = new Client({ name: "desk-voice", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find(
        (candidate) => voiceToolName(serverName, candidate.name) === name,
      );
      if (!tool) continue;
      return {
        found: true,
        result: await client.callTool({ name: tool.name, arguments: args }),
      };
    } finally {
      await client.close();
      await server.instance.close();
    }
  }
  return { found: false };
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Recent Desk text-mode turns, compacted for a voice engine's context so the
 *  call picks the conversation up mid-thread instead of starting blank. */
export async function recentDeskTurns(
  sessionId: string,
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  try {
    const tail = await getSessionControl().transcriptTail(sessionId, 12);
    return tail
      .filter((e) => (e.type === "user" || e.type === "assistant") && e.content)
      .map((e) => ({
        role: e.type === "user" ? ("user" as const) : ("assistant" as const),
        text: truncate(e.content.replace(/\s+/g, " "), 300),
      }));
  } catch {
    return [];
  }
}

async function recentDeskContext(sessionId: string): Promise<string> {
  const turns = await recentDeskTurns(sessionId);
  if (!turns.length) return "";
  const lines = turns.map(
    (t) => `${t.role === "user" ? "User" : "Desk"}: ${t.text}`,
  );
  return `\n\nRecent Desk conversation (text mode, continue from it):\n${lines.join("\n")}`;
}

/** Server-owned Realtime session policy. Exported for contract tests so a
 * client cannot silently fall back to OpenAI's default endpointing. */
export async function buildVoiceSessionConfig(
  sessionId: string,
  user = "Open Session",
) {
  return {
    type: "realtime",
    model: DESK_VOICE_MODEL,
    instructions: VOICE_INSTRUCTIONS + (await recentDeskContext(sessionId)),
    tools: [...VOICE_TOOLS, ...(await listVoiceMcpTools(user, sessionId))],
    tool_choice: "auto",
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: DESK_VOICE_TURN_DETECTION,
        // Near-field: tuned for phone/laptop mics — strips speaker bleed
        // and room noise before the VAD sees it (phone speakers leak
        // the assistant's own answer back into the mic).
        noise_reduction: { type: "near_field" },
      },
      output: { voice: "marin" },
    },
  };
}

export async function mintVoiceSecret(user: string): Promise<{
  clientSecret: string;
  expiresAt: number;
  model: string;
  sessionId: string;
}> {
  const key = await requireVoiceApiKey();
  const { sessionId } = ensureDeskSession(user);
  const session = await buildVoiceSessionConfig(sessionId, user);
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI rejected the voice session (${res.status}): ${truncate(text, 300)}`,
    );
  }
  const data = (await res.json()) as { value?: string; expires_at?: number };
  if (!data.value) throw new Error("OpenAI returned no client secret");
  return {
    clientSecret: data.value,
    expiresAt: data.expires_at ?? 0,
    model: DESK_VOICE_MODEL,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// Tool facade — executes as the verified user, same underlying operations as
// the Desk's interactive tools. Results are compact: they get spoken, not read.

export async function executeVoiceTool(
  user: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const control = getSessionControl();
  const desk = ensureDeskSession(user);
  const mcp = await callVoiceMcpTool(user, desk.sessionId, name, args);
  if (mcp.found) return mcp.result;
  switch (name) {
    case "list_current_work": {
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const sessions = control
        .listSessions()
        .filter(
          (s) =>
            !s.desk &&
            s.state !== "archived" &&
            (s.state !== "idle" ||
              (s.lastActivity && Date.parse(s.lastActivity) > dayAgo)),
        )
        .slice(0, 15)
        .map((s) => ({
          id: s.id,
          title: s.title || "(untitled)",
          state: s.state,
          repo: s.repo,
          // The PR a session opened, so a spoken "six four seven four" can
          // be linked back to it in the transcript (desk-voice-refs.ts).
          ...(s.prNumber ? { prNumber: s.prNumber } : {}),
          lastActivity: s.lastActivity,
        }));
      return { sessions };
    }
    case "inspect_session": {
      const id = String(args.session_id ?? "");
      const s = control.getSession(id);
      if (!s) return { error: `no session ${id}` };
      return {
        id: s.id,
        title: s.title,
        state: s.state,
        repo: s.repo,
        branch: s.branch,
        ...(s.prNumber ? { prNumber: s.prNumber } : {}),
        pendingQuestion: s.pendingQuestion,
        recent: (await control.transcriptTail(id, 10)).map((e) => ({
          type: e.type,
          tool: e.toolName,
          content: truncate((e.content || "").replace(/\s+/g, " "), 300),
        })),
      };
    }
    case "start_session": {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { error: "start_session needs a prompt" };
      const mode = args.mode === "code" ? "code" : "ask";
      const { id } = await control.createSession({
        prompt,
        repo: typeof args.repo === "string" ? args.repo : undefined,
        mode,
        user,
        createdByLogin: control.getSession(desk.sessionId)?.createdByLogin,
        parentSessionId: desk.sessionId,
      });
      return { id, started: true, mode };
    }
    case "steer_session": {
      const id = String(args.session_id ?? "");
      const message = String(args.message ?? "").trim();
      if (!id || !message)
        return { error: "steer_session needs session_id and message" };
      return await control.deliverToSession(id, message, user);
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Call diagnostics. A voice call fails on the user's device, silently and with
// nothing to inspect afterwards — "it just says Listening" is all a report can
// say. Clients post one audio-free line of counters when a call ends (never
// audio, never transcript text), which is what makes such a report answerable:
// whether the socket ever came up, whether the microphone produced anything,
// how often the capture path had to be rebuilt.

const diagPath = () => `${dir()}/voice-diag.jsonl`;
/** Keep the tail bounded — this is a debugging aid, not a data store. */
const DIAG_MAX_BYTES = 256 * 1024;

// Serialize trimming and appending without blocking the gateway.
let diagWrite: Promise<void> = Promise.resolve();
export function recordVoiceDiag(
  user: string,
  report: Record<string, unknown>,
): Promise<void> {
  const { user: _user, ...rest } = report;
  const line = JSON.stringify({ ...rest, at: new Date().toISOString(), user });
  const path = diagPath();
  console.log(`[desk-voice] call diagnostics ${line}`);
  diagWrite = diagWrite
    .then(async () => {
      await mkdir(dir(), { recursive: true });
      const info = await stat(path).catch(() => null);
      if (info && info.size > DIAG_MAX_BYTES) {
        const kept = (await readFile(path, "utf-8")).split("\n").slice(-200);
        await writeFile(path, kept.join("\n"));
      }
      await appendFile(path, `${line}\n`);
    })
    .catch((error) =>
      console.error("[desk-voice] failed to record diagnostics:", error),
    );
  return diagWrite;
}

// ---------------------------------------------------------------------------
// Transcript mirroring + handoff buffer. Mirrored entries land in the Desk's
// transcript store (which broadcasts to overlay watchers live); the handoff
// buffer is the separate copy the NEXT TEXT TURN's engine context needs,
// consumed by takeVoiceHandoff() in run-session.ts. Entries upsert by id so a
// re-sent final refines in place instead of duplicating.

interface HandoffEntry {
  id: string;
  role: "user" | "assistant" | "action";
  text: string;
}

function handoffPath(sessionId: string): string {
  return `${handoffDir()}/${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

function appendHandoff(sessionId: string, entries: HandoffEntry[]): void {
  try {
    mkdirSync(handoffDir(), { recursive: true });
    const path = handoffPath(sessionId);
    let existing: HandoffEntry[] = [];
    try {
      if (existsSync(path))
        existing = JSON.parse(readFileSync(path, "utf-8")) as HandoffEntry[];
    } catch {}
    for (const e of entries) {
      const i = existing.findIndex((x) => x.id === e.id);
      if (i >= 0) existing[i] = e;
      else existing.push(e);
    }
    writeJsonAtomic(path, existing.slice(-80));
  } catch (e) {
    console.error("[desk-voice] failed to buffer handoff:", e);
  }
}

/** Consume the pending voice handoff for a session (one-shot), formatted as a
 *  context note for the next text turn. Undefined when no voice turns landed. */
export function takeVoiceHandoff(sessionId: string): string | undefined {
  const path = handoffPath(sessionId);
  let entries: HandoffEntry[] = [];
  try {
    if (!existsSync(path)) return undefined;
    entries = JSON.parse(readFileSync(path, "utf-8")) as HandoffEntry[];
    rmSync(path, { force: true });
  } catch {
    return undefined;
  }
  if (!entries.length) return undefined;
  const lines = entries.map((e) =>
    e.role === "action"
      ? `Action: ${e.text}`
      : `${e.role === "user" ? "User" : "Desk"} (voice): ${e.text}`,
  );
  return `## Voice conversation handoff\nWhile in voice mode, you (the Desk) had this spoken conversation through a voice model. It is already in the visible transcript — don't repeat or re-answer it; continue with full awareness of what was said and done:\n\n${lines.join("\n")}`;
}

export function mirrorVoiceEntries(
  user: string,
  entries: { id: string; role: "user" | "assistant"; text: string }[],
): void {
  if (!entries.length) return;
  const { sessionId } = ensureDeskSession(user);
  const now = new Date().toISOString();
  const tes: TranscriptEntry[] = entries.map((e) => ({
    id: e.id,
    type: e.role,
    content: e.text,
    timestamp: now,
  }));
  void appendTranscriptEvents(sessionId, tes).catch((error) => {
    console.error(
      `[desk-voice] Failed to mirror voice entries for ${sessionId}:`,
      error,
    );
  });
  appendHandoff(
    sessionId,
    entries.map((e) => ({
      id: e.id,
      role: e.role,
      text: truncate(e.text, 1000),
    })),
  );
}

export function mirrorVoiceToolCall(
  user: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  const { sessionId } = ensureDeskSession(user);
  void appendTranscriptEvents(
    sessionId,
    voiceToolTranscriptEntries(callId, name, args, result),
  ).catch((error) => {
    console.error(
      `[desk-voice] Failed to mirror tool call for ${sessionId}:`,
      error,
    );
  });
  appendHandoff(sessionId, [
    {
      id: `voice-act-${callId}`,
      role: "action",
      text: `${name}(${truncate(JSON.stringify(args), 200)}) → ${truncate(JSON.stringify(result) ?? "", 300)}`,
    },
  ]);
}

export function voiceToolTranscriptEntries(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  timestamp = new Date().toISOString(),
): TranscriptEntry[] {
  const toolUseId = `voice-tu-${callId}`;
  const failed =
    result !== null &&
    typeof result === "object" &&
    ((result as { isError?: unknown }).isError === true ||
      typeof (result as { error?: unknown }).error === "string");
  return [
    {
      id: toolUseId,
      type: "tool_use",
      toolName: name,
      toolUseId,
      toolInput: args,
      content: `Using ${name}`,
      timestamp,
    },
    {
      id: `voice-tr-${callId}`,
      type: "tool_result",
      toolName: name,
      toolUseId,
      content: JSON.stringify(result) ?? "",
      timestamp,
      ...(failed ? { isError: true } : {}),
    },
  ];
}
