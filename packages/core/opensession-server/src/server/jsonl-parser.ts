import { readFileSync, statSync } from "fs";
import { openSync, readSync, closeSync, fstatSync } from "fs";
import { existsSync } from "fs";
import type { TranscriptEntry } from "./types";
import {
  classifyEntries,
  parseAnsweredAskData,
} from "@tellahq/opensession-protocol/notices";
import { withToolPresentations } from "@tellahq/opensession-protocol/tool-presentation";
import { SLACK_ID_TO_NAME } from "./shared/user-mappings";
import { stripContext } from "./prompt-context";
import { configuredIntegration } from "./config";
import { extractAssistantVideos, toolResultMedia } from "./transcript-media";
import { transcriptEntryMatchSnippet } from "./transcript-search";
export {
  extractAssistantVideos,
  extractImageMarkers,
  extractImplicitMedia,
  extractVideoMarkers,
  isFileReadOutput,
  isGrepResultOutput,
  isReservedMediaHost,
  sanitizeTranscriptMediaEntry,
  toolResultMedia,
} from "./transcript-media";

const SLACK_USERS = SLACK_ID_TO_NAME;

const slackConfig = configuredIntegration("slack");
const SLACK_CHANNELS: Record<string, string> =
  slackConfig.channelNames &&
  typeof slackConfig.channelNames === "object" &&
  !Array.isArray(slackConfig.channelNames)
    ? (slackConfig.channelNames as Record<string, string>)
    : {};
const SLACK_WORKSPACE =
  typeof slackConfig.workspaceId === "string" ? slackConfig.workspaceId : "";

function resolveSlackIds(text: string): string {
  // Replace <@USERID> with **Name**
  text = text.replace(/<@(U[A-Z0-9]+)>/g, (_match, id) => {
    const name = SLACK_USERS[id];
    return name ? `**@${name}**` : `@${id}`;
  });
  // Replace [USERID]: at start of lines with **Name**:
  text = text.replace(/\[(U[A-Z0-9]+)\]:/g, (_match, id) => {
    const name = SLACK_USERS[id];
    return name ? `**${name}**:` : `[${id}]:`;
  });
  // Replace <#CHANNELID|name> or <#CHANNELID> channel references
  text = text.replace(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id, name) => {
    const channelName = name || SLACK_CHANNELS[id] || id;
    return SLACK_WORKSPACE
      ? `[#${channelName}](https://app.slack.com/client/${SLACK_WORKSPACE}/${id})`
      : `#${channelName}`;
  });
  // Ensure --- separators have blank lines around them (prevents setext heading)
  text = text.replace(/([^\n])\n---(\n)/g, "$1\n\n---$2");
  text = text.replace(/\n---\n([^\n])/g, "\n---\n\n$1");
  return text;
}

interface RawJsonlEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  sourceMessageIds?: string[];
  // Open Session's Pi normalizer marks provider thinking blocks so they keep
  // their quiet activity presentation after the JSONL normalization round-trip.
  isReasoning?: boolean;
  // Structured companion to an <ask-record> text block. Older parsers ignore
  // the extra line field and keep the markdown fallback in the message.
  ask?: unknown;
  // Harness-injected user lines (skill bodies, command output) — not typed by the user
  isMeta?: boolean;
  // Present on a Task/Agent tool_result line: carries the spawned sub-agent's id
  // (and its type/description), used to link the call to its sub-agent transcript.
  toolUseResult?: {
    agentId?: string;
    agentType?: string;
    description?: string;
  };
  message?: {
    role?: string;
    content?: any;
    // Assistant lines: the model that produced the message (Claude SDK writes
    // this natively; our pi transcript writer mirrors it).
    model?: string;
  };
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text || "")
      .join("\n");
  }
  return "";
}

/** Pull renderable image srcs out of content blocks (base64 → data URL, or a
 *  direct url). Covers Read-of-image tool results and pasted images. */
function extractImages(content: any): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (b?.type !== "image" || !b.source) continue;
    const src = b.source;
    if (src.type === "base64" && src.media_type && src.data) {
      out.push(`data:${src.media_type};base64,${src.data}`);
    } else if (src.type === "url" && src.url) {
      out.push(src.url);
    }
  }
  return out;
}

// Composer file attachments (non-image) are staged to disk and announced to
// the agent via a note withUploadsNote() appends to the prompt. Parse the note
// back out so the user bubble renders the attachments — inline for media the
// /media route can stream, a file chip otherwise — instead of the
// raw plumbing text.
const UPLOADS_NOTE_RE =
  /\s*\[The user attached \d+ file\(s\), saved to disk — read them with your file tools if relevant:\n([\s\S]*?)\n\]\s*$/;
const UPLOAD_VIDEO_EXT_RE = /\.(mp4|webm|mov)$/i;
const UPLOAD_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function extractUploadsNote(text: string): {
  text: string;
  files: { name: string; path: string }[];
} {
  const m = text.match(UPLOADS_NOTE_RE);
  if (!m) return { text, files: [] };
  const files: { name: string; path: string }[] = [];
  for (const line of m[1].split("\n")) {
    if (!line.startsWith("- ")) continue;
    // "- <name>: <abs path>" — the name may itself contain ": /", so split at
    // the LAST occurrence (paths are always absolute).
    const idx = line.lastIndexOf(": /");
    if (idx <= 2) continue;
    files.push({ name: line.slice(2, idx), path: line.slice(idx + 2) });
  }
  if (!files.length) return { text, files: [] };
  return { text: text.slice(0, m.index).trimEnd(), files };
}

/** Hang parsed uploads on a user entry: streamable media inline, chips otherwise. */
function attachUploads(
  entry: TranscriptEntry,
  files: { name: string; path: string }[],
): void {
  for (const f of files) {
    const url = `/media?path=${encodeURIComponent(f.path)}`;
    if (UPLOAD_VIDEO_EXT_RE.test(f.path)) {
      entry.videos = [...(entry.videos || []), url];
    } else if (UPLOAD_IMAGE_EXT_RE.test(f.path)) {
      entry.images = [...(entry.images || []), url];
    } else {
      entry.files = [...(entry.files || []), f];
    }
  }
}

/**
 * Harness-injected user turns (not typed by a person). Task notifications get
 * a system line built from their <summary>; system-reminders are dropped.
 */
// Steered messages released at the same turn boundary — and queued messages
// drained as one batch — are joined into a SINGLE engine turn ("\n\n"-
// separated, each part carrying its "[Name] " attribution; see claude-runner's
// steer batching and opensession's drainQueue combine). Split those back into
// per-sender entries so the UI shows them as the separate messages they were
// (and steer receipts reconcile by exact match instead of containment). Only
// fires when the turn itself STARTS with an attribution, so an ordinary paste
// containing bracketed lines ("[ERROR] …") can't split.
const ATTRIBUTION_PREFIX_RE = /^\[[^\]\n{}]{1,40}\] /;
const ATTRIBUTED_JOIN_RE = /\n\n(?=\[[^\]\n{}]{1,40}\] )/;
function splitAttributedParts(text: string): string[] {
  if (!ATTRIBUTION_PREFIX_RE.test(text)) return [text];
  return text.split(ATTRIBUTED_JOIN_RE);
}

/** Push a user turn, splitting a steer-joined composite into one entry per
 *  attributed part. Delivery identities survive normalization so optimistic
 *  clients never have to correlate repeated text or client/server clocks. */
function pushUserEntries(
  entries: TranscriptEntry[],
  id: string,
  text: string,
  ts: string,
  sourceMessageIds?: string[],
): void {
  const parts = splitAttributedParts(text);
  const sources = sourceMessageIds?.filter(
    (source): source is string =>
      typeof source === "string" && source.length > 0,
  );
  parts.forEach((part, i) => {
    const partSources =
      sources?.length === parts.length
        ? [sources[i]!]
        : i === 0
          ? sources
          : undefined;
    entries.push({
      id: i === 0 ? id : `${id}-j${i + 1}`,
      type: "user",
      content: resolveSlackIds(part),
      timestamp: ts,
      ...(partSources?.length ? { sourceMessageIds: partSources } : {}),
    });
  });
}

/** Deterministic id for a harness/system entry (transcript-v2 §1a): derived
 *  from the raw line's uuid so re-parsing the same line always yields the same
 *  id — `sys-<uuid>`, with a `-b<i>` suffix when a multi-block line fans out.
 *  Lines with no uuid fall back to a content+timestamp hash, never
 *  crypto.randomUUID() (which minted a fresh id per parse, so system chips had
 *  no stable dedup key — duplicate chips on watcher restarts, and no usable
 *  upsert key for the v2 transcript store). */
function harnessEntryId(
  raw: RawJsonlEntry,
  text: string,
  ts: string,
  blockIndex = 0,
): string {
  const base = raw.uuid
    ? `sys-${raw.uuid}`
    : `sys-h${fnv1a36(`${ts}|${text}`)}`;
  return blockIndex > 0 ? `${base}-b${blockIndex}` : base;
}

function harnessEntryFor(
  text: string,
  ts: string,
  id: string,
  structuredAsk?: unknown,
): TranscriptEntry[] | null {
  const t = text.trimStart();
  if (t.startsWith("<task-notification>")) {
    const summary = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    const status = t.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
    return [
      {
        id,
        type: "system",
        content: summary
          ? `Background task ${status || "update"}: ${summary}`
          : `Background task ${status || "update"}`,
        timestamp: ts,
      },
    ];
  }
  if (t.startsWith("<system-reminder>")) return [];
  // Runner-injected operational notice (account rotation, transient-error
  // retry — transcriptLineRunnerNotice in pi-transcript.ts): render as a
  // system chip, never as a user bubble.
  if (t.startsWith("<runner-notice>")) {
    const body = t
      .match(/<runner-notice>([\s\S]*?)<\/runner-notice>/)?.[1]
      ?.trim();
    return body ? [{ id, type: "system", content: body, timestamp: ts }] : [];
  }
  // An answered question card (transcriptLineAskRecord in
  // transcript-persistence.ts, written by asks.ts when the ask resolves). The
  // card is transient, so this is the transcript's only trace of what was
  // asked and what was picked. A system entry tagged `noticeKind: "ask"`,
  // whose content is the record's title line plus its markdown body. New lines
  // also carry exact structured data beside the text; old lines keep working
  // through the protocol classifier's conservative markdown parser.
  if (t.startsWith("<ask-record>")) {
    const body = t.match(/<ask-record>([\s\S]*?)<\/ask-record>/)?.[1]?.trim();
    const ask = parseAnsweredAskData(structuredAsk);
    return body
      ? [
          {
            id,
            type: "system",
            content: body,
            timestamp: ts,
            noticeKind: "ask",
            ...(ask ? { ask } : {}),
          },
        ]
      : [];
  }
  // Engine context-compaction summary (transcriptLineCompactionSummary in
  // pi-transcript.ts): the handoff the model wrote when its history was
  // summarized to fit the context window. A system entry with `compaction`
  // set, so the UI shows a collapsed "context compacted" chip instead of the
  // model apparently dumping a status report mid-conversation.
  if (t.startsWith("<compaction-summary>")) {
    const body = t
      .match(/<compaction-summary>([\s\S]*?)<\/compaction-summary>/)?.[1]
      ?.trim();
    return body
      ? [
          {
            id,
            type: "system",
            content: body,
            timestamp: ts,
            noticeKind: "compaction",
          },
        ]
      : [];
  }
  // Session recap (transcriptLineRecap in pi-transcript.ts): the
  // away-summary recap.ts writes when a viewer returns to a session whose turn
  // finished while nobody was watching. A system entry with `recap` set, so
  // the UI renders a "recap:" line instead of a generic system chip.
  if (t.startsWith("<recap>")) {
    const body = t.match(/<recap>([\s\S]*?)<\/recap>/)?.[1]?.trim();
    return body
      ? [
          {
            id,
            type: "system",
            content: body,
            timestamp: ts,
            noticeKind: "recap",
          },
        ]
      : [];
  }
  // A model-visible payload the harness injected into a prompt
  // (transcriptLineContextInjection in pi-transcript.ts, written by
  // context-log.ts): the "model-visible means logged" record. A system entry
  // tagged `context-injection`, which every client-bound projection drops —
  // it exists for replay/eval/debugging, not for the conversation.
  if (t.startsWith("<context-injection")) {
    const open = t.match(/^<context-injection([^>]*)>/)?.[1] || "";
    const body = t
      .match(/<context-injection[^>]*>([\s\S]*?)<\/context-injection>/)?.[1]
      ?.trim();
    if (!body) return [];
    const source = open.match(/source="([^"]*)"/)?.[1] || "unknown";
    const turnId = open.match(/turn="([^"]*)"/)?.[1];
    return [
      {
        id,
        type: "system",
        content: body,
        timestamp: ts,
        noticeKind: "context-injection",
        contextInjection: { source, ...(turnId ? { turnId } : {}) },
      },
    ];
  }
  // Model-visible input that stands between turns rather than riding one — the
  // run's tool surface, the engine's standing instructions
  // (transcriptLineStandingContext, written by context-log.ts). Tagged
  // `standing-context`, which the same projections drop as an injection
  // record. The close tag is matched GREEDILY: the body is a whole
  // instructions file or config document, which may quote this marker, and an
  // audit row that silently truncates is worse than one that is long.
  if (t.startsWith("<standing-context")) {
    const open = t.match(/^<standing-context([^>]*)>/)?.[1] || "";
    const body = t
      .match(/<standing-context[^>]*>([\s\S]*)<\/standing-context>/)?.[1]
      ?.trim();
    if (!body) return [];
    const source = open.match(/source="([^"]*)"/)?.[1] || "unknown";
    const turnId = open.match(/turn="([^"]*)"/)?.[1];
    const hash = open.match(/hash="([^"]*)"/)?.[1];
    const bytes = Number(open.match(/bytes="(\d+)"/)?.[1]);
    return [
      {
        id,
        type: "system",
        content: body,
        timestamp: ts,
        noticeKind: "standing-context",
        contextInjection: {
          source,
          ...(turnId ? { turnId } : {}),
          ...(hash ? { hash } : {}),
          ...(Number.isFinite(bytes) ? { bytes } : {}),
        },
      },
    ];
  }
  // The SDK writes this marker into the jsonl whenever a turn is interrupted
  // ("… for tool use" when the abort landed on a pending tool call).
  // Interrupt-and-redirect is the default send-while-busy now, so this would
  // otherwise post on nearly every follow-up message — drop it as noise.
  if (/^\[Request interrupted by user( for tool use)?\]$/.test(t.trimEnd()))
    return [];
  return null;
}

function parseEntry(raw: RawJsonlEntry): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  if (!raw.message?.content) return entries;

  const ts = raw.timestamp || new Date().toISOString();

  if (raw.type === "user") {
    const content = raw.message.content;

    // Check for tool_result blocks
    if (Array.isArray(content)) {
      // Same multi-text-block id fan-out guard as the assistant branch (§1a):
      // the 2nd+ renderable text block on one line gets a -t<n> suffix so it
      // never collides with the first as an upsert key. Only blocks that
      // actually produce user entries count, so the suffix is stable across
      // re-parses (harness/empty blocks don't shift it).
      let userTextCount = 0;
      for (let bi = 0; bi < content.length; bi++) {
        const block = content[bi];
        if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : "";
          // Markers, implicit mentions and the Read image block, derived the
          // same way on every engine — see toolResultMedia.
          const media = toolResultMedia(
            resultText,
            extractImages(block.content),
          );
          // A Task/Agent result carries the spawned sub-agent's id on the line's
          // toolUseResult; attach it so the UI can open the sub-agent transcript.
          const agentId = raw.toolUseResult?.agentId;
          entries.push({
            // Keyed on the tool_use id: one jsonl line can carry several
            // tool_result blocks (parallel calls), and the live-stream copy
            // of the same result must upsert rather than duplicate.
            id: block.tool_use_id
              ? `tr-${block.tool_use_id}`
              : raw.uuid || crypto.randomUUID(),
            type: "tool_result",
            content: resultText,
            timestamp: ts,
            toolUseId: block.tool_use_id,
            ...(block.is_error ? { isError: true } : {}),
            ...(agentId ? { agentId } : {}),
            ...media,
          });
        } else if (block.type === "text" && !raw.isMeta) {
          const harness = harnessEntryFor(
            block.text || "",
            ts,
            harnessEntryId(raw, block.text || "", ts, bi),
            raw.ask,
          );
          if (harness) {
            entries.push(...harness);
            continue;
          }
          // Fenced injected context (e.g. an engine-switch handoff prepended to
          // the turn) is plumbing — show only the human's message.
          const stripped = stripContext(block.text || "");
          const { text, files } = extractUploadsNote(stripped);
          if (!text.trim() && !files.length) continue;
          const baseId = raw.uuid || crypto.randomUUID();
          const id =
            userTextCount === 0 ? baseId : `${baseId}-t${userTextCount}`;
          userTextCount++;
          pushUserEntries(entries, id, text, ts, raw.sourceMessageIds);
          if (files.length) {
            // The note rides the end of the turn — attach to its last user entry
            // (or a bare one when the message was attachments-only).
            const lastUser = [...entries]
              .reverse()
              .find((e) => e.type === "user");
            if (lastUser) attachUploads(lastUser, files);
            else {
              const bare: TranscriptEntry = {
                id,
                type: "user",
                content: "",
                timestamp: ts,
              };
              attachUploads(bare, files);
              entries.push(bare);
            }
          }
        }
      }

      // Images pasted into a user message ride alongside its text blocks
      const pastedImages = extractImages(content);
      if (pastedImages.length > 0) {
        const lastUser = [...entries].reverse().find((e) => e.type === "user");
        if (lastUser) {
          lastUser.images = [...(lastUser.images || []), ...pastedImages];
        } else {
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "user",
            content: "",
            timestamp: ts,
            images: pastedImages,
          });
        }
      }
    } else if (!raw.isMeta) {
      const stripped = stripContext(extractText(content));
      if (stripped) {
        const harness = harnessEntryFor(
          stripped,
          ts,
          harnessEntryId(raw, stripped, ts),
          raw.ask,
        );
        if (harness) {
          entries.push(...harness);
        } else {
          const { text, files } = extractUploadsNote(stripped);
          pushUserEntries(
            entries,
            raw.uuid || crypto.randomUUID(),
            text,
            ts,
            raw.sourceMessageIds,
          );
          if (files.length) {
            const lastUser = [...entries]
              .reverse()
              .find((e) => e.type === "user");
            if (lastUser) attachUploads(lastUser, files);
          }
        }
      }
    }
  }

  if (raw.type === "assistant") {
    const content = raw.message.content;
    const model =
      typeof raw.message.model === "string" ? raw.message.model : undefined;
    if (Array.isArray(content)) {
      // One line can carry several renderable text blocks; sharing the bare
      // line uuid would collide them as upsert/React keys (and as v2 store
      // uuids, where the later block silently overwrites the earlier — §1a).
      // First entry keeps the bare id for back compat; 2nd+ get a
      // deterministic -t<n> suffix (sibling of the harness -b<i> convention).
      let textBlockCount = 0;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          const assistant = extractAssistantVideos(block.text);
          const baseId = raw.uuid || crypto.randomUUID();
          entries.push({
            id: textBlockCount === 0 ? baseId : `${baseId}-t${textBlockCount}`,
            type: "assistant",
            content: assistant.content,
            timestamp: ts,
            requestId: raw.requestId,
            ...(model ? { model } : {}),
            ...(raw.isReasoning ? { isReasoning: true } : {}),
            ...(assistant.videos.length > 0
              ? { videos: assistant.videos }
              : {}),
            ...(assistant.images.length > 0
              ? { images: assistant.images }
              : {}),
          });
          textBlockCount++;
        }
        if (block.type === "tool_use") {
          entries.push({
            id: block.id || crypto.randomUUID(),
            type: "tool_use",
            content: summarizeToolUse(block.name, block.input),
            timestamp: ts,
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            requestId: raw.requestId,
          });
        }
      }
    } else {
      const text = extractText(content);
      if (text) {
        const assistant = extractAssistantVideos(text);
        entries.push({
          id: raw.uuid || crypto.randomUUID(),
          type: "assistant",
          content: assistant.content,
          timestamp: ts,
          requestId: raw.requestId,
          ...(model ? { model } : {}),
          ...(raw.isReasoning ? { isReasoning: true } : {}),
          ...(assistant.videos.length > 0 ? { videos: assistant.videos } : {}),
          ...(assistant.images.length > 0 ? { images: assistant.images } : {}),
        });
      }
    }
  }

  return entries;
}

function summarizeToolUse(name: string, input: any): string {
  if (!input) return `Using ${name}`;
  switch (name) {
    case "Read":
      return `Read ${input.file_path || "file"}`;
    case "Edit":
      return `Edit ${input.file_path || "file"}`;
    case "Write":
      return `Write ${input.file_path || "file"}`;
    case "Bash":
      return `$ ${(input.command || "").split("\n")[0].slice(0, 80)}`;
    case "Grep":
      return `Grep: ${input.pattern || ""} ${input.glob || ""}`;
    case "Glob":
      return `Glob: ${input.pattern || ""}`;
    case "WebFetch":
      return `Fetch ${input.url || ""}`;
    case "WebSearch":
      return `Search: ${input.query || ""}`;
    case "Agent":
    case "Task":
      return `Agent: ${input.description || input.prompt?.slice(0, 60) || ""}`;
    default:
      return `Using ${name}`;
  }
}

// ── Codex rollout transcripts ────────────────────────────────
// Codex threads persist as rollout-<ts>-<threadId>.jsonl under a CODEX_HOME's
// sessions/YYYY/MM/DD/ tree. Lines are { timestamp, type, payload }. Messages
// are read from event_msg payloads (response_item message lines duplicate
// them and additionally carry harness-injected developer/AGENTS.md content);
// tool calls only exist as response_item lines.

function isCodexRolloutPath(path: string): boolean {
  return path.includes("/rollout-") || path.includes("\\rollout-");
}

/** FNV-1a 32-bit hash rendered base36 — deterministic id material for lines
 *  that carry no usable native id (Codex rollout lines, uuid-less harness
 *  lines). */
function fnv1a36(source: string): string {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableCodexId(
  prefix: string,
  raw: any,
  p: any,
  extra?: unknown,
): string {
  const source = JSON.stringify({
    ts: raw?.timestamp || "",
    rawType: raw?.type || "",
    payloadType: p?.type || "",
    payloadId: p?.id || p?.call_id || "",
    extra,
  });
  return `${prefix}-${fnv1a36(source)}`;
}

function parseCodexEntry(raw: any): TranscriptEntry[] {
  const ts = raw.timestamp || new Date().toISOString();
  const p = raw.payload;
  if (!p || typeof p !== "object") return [];

  if (raw.type === "event_msg") {
    if (
      p.type === "user_message" &&
      typeof p.message === "string" &&
      p.message.trim()
    ) {
      // Strip fenced injected context (system preamble, repos note, engine
      // handoff — all of which ride on the Codex user turn) plus legacy
      // harness-appended run-policy/fallback notes, so the rendered prompt is
      // just what the human typed.
      const message = stripContext(p.message)
        .split("\n\n[Run policy:")[0]
        .split("\n\n[Note: a previous attempt")[0];
      if (!message.trim()) return [];
      return [
        {
          id: p.id || stableCodexId("codex-user", raw, p, message),
          type: "user",
          content: resolveSlackIds(message),
          timestamp: ts,
        },
      ];
    }
    if (
      p.type === "agent_message" &&
      typeof p.message === "string" &&
      p.message.trim()
    ) {
      const assistant = extractAssistantVideos(p.message);
      return [
        {
          id: p.id || stableCodexId("codex-assistant", raw, p, p.message),
          type: "assistant",
          content: assistant.content,
          timestamp: ts,
          ...(assistant.videos.length > 0 ? { videos: assistant.videos } : {}),
        },
      ];
    }
    return [];
  }

  if (raw.type === "response_item") {
    const parseArgs = (v: unknown): unknown => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };
    const outputText = (v: unknown): string => {
      const parsed = parseArgs(v) as any;
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.output === "string") return parsed.output;
        return JSON.stringify(parsed, null, 2);
      }
      return String(v ?? "");
    };

    // MCP / custom tool calls
    if (
      (p.type === "function_call" || p.type === "custom_tool_call") &&
      p.name
    ) {
      const input = parseArgs(p.arguments ?? p.input);
      return [
        {
          id: p.call_id || crypto.randomUUID(),
          type: "tool_use",
          content: `Using ${p.name}`,
          timestamp: ts,
          toolName: p.name,
          toolInput: input,
          toolUseId: p.call_id,
        },
      ];
    }
    if (
      p.type === "function_call_output" ||
      p.type === "custom_tool_call_output"
    ) {
      const content = outputText(p.output);
      return [
        {
          id: p.call_id
            ? `tr-${p.call_id}`
            : stableCodexId("tr-codex", raw, p, content),
          type: "tool_result",
          content,
          timestamp: ts,
          toolUseId: p.call_id,
          // Codex hands over no attachment media, but the markers and implicit
          // mentions in the text render exactly as on the other engines.
          ...toolResultMedia(content),
        },
      ];
    }
    if (p.type === "file_change") {
      return [
        {
          id: p.id || stableCodexId("codex-file-change", raw, p, p.changes),
          type: "tool_use",
          content: `Changed ${(p.changes || []).length || ""} file(s)`.trim(),
          timestamp: ts,
          toolName: "FileChange",
          toolInput: { changes: Array.isArray(p.changes) ? p.changes : [] },
          toolUseId: p.id,
        },
      ];
    }
    // Shell commands
    if (p.type === "local_shell_call") {
      const command = Array.isArray(p.action?.command)
        ? p.action.command.join(" ")
        : String(p.action?.command || "");
      return [
        {
          id: p.call_id || crypto.randomUUID(),
          type: "tool_use",
          content: `$ ${command.split("\n")[0].slice(0, 80)}`,
          timestamp: ts,
          toolName: "Bash",
          toolInput: { command },
          toolUseId: p.call_id,
        },
      ];
    }
    if (p.type === "local_shell_call_output") {
      const content = outputText(p.output);
      return [
        {
          id: p.call_id
            ? `tr-${p.call_id}`
            : stableCodexId("tr-codex", raw, p, content),
          type: "tool_result",
          content,
          timestamp: ts,
          toolUseId: p.call_id,
          ...toolResultMedia(content),
        },
      ];
    }
    if (p.type === "web_search_call") {
      const toolUseId = p.call_id || p.id;
      return [
        {
          id: toolUseId || stableCodexId("codex-web", raw, p, p.action),
          type: "tool_use",
          content: `Search: ${p.action?.query || ""}`,
          timestamp: ts,
          toolName: "WebSearch",
          toolInput: p.action,
          ...(toolUseId ? { toolUseId } : {}),
        },
      ];
    }
    return [];
  }

  return [];
}

function parseCodexLines(lines: string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(...parseCodexEntry(JSON.parse(line)));
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Parse a set of already-split Claude-shape jsonl lines, deduplicating
 * assistant messages that share a requestId (the SDK rewrites a streamed turn
 * under one requestId; keep the last). Shared by the full parse and the tail
 * parse, and exported as the transcript-v2 (§1a) line→entry helper: the store
 * keys rows on the parsed entry ids this produces, so live appends, legacy
 * imports, and wire upserts all agree on identity.
 */
export function parseJsonlLines(lines: string[]): TranscriptEntry[] {
  const acc = makeJsonlAccumulator();
  for (const line of lines) acc.push(line);
  return acc.entries;
}

/**
 * Line-by-line state shared by the sync and async jsonl parses: entry
 * accumulation plus the assistant-requestId dedupe (keep last). Both variants
 * MUST produce identical output for the same lines — the async one only
 * differs in yielding to the event loop between chunks.
 */
function makeJsonlAccumulator(): {
  entries: TranscriptEntry[];
  push(line: string): void;
} {
  const entries: TranscriptEntry[] = [];
  const seenRequestIds = new Map<string, number>(); // requestId → last index in entries
  return {
    entries,
    push(line: string): void {
      let parsed: RawJsonlEntry;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      // Skip non-message types
      if (parsed.type !== "user" && parsed.type !== "assistant") return;

      const newEntries = parseEntry(parsed);
      for (const entry of newEntries) {
        // Deduplicate assistant messages with same requestId (keep last)
        if (entry.type === "assistant" && entry.requestId) {
          const prevIdx = seenRequestIds.get(entry.requestId);
          if (prevIdx !== undefined) {
            entries[prevIdx] = entry;
            continue;
          }
          seenRequestIds.set(entry.requestId, entries.length);
        }
        entries.push(entry);
      }
    },
  };
}

/**
 * parseJsonlLines that yields to the event loop every `yieldEveryLines`
 * lines. The per-line JSON.parse is the CPU cost of a transcript parse — a
 * 30 MB legacy import used to hold the loop for seconds; chunking keeps HTTP
 * and WebSocket traffic flowing underneath it.
 */
export async function parseJsonlLinesAsync(
  lines: string[],
  yieldEveryLines = 1000,
): Promise<TranscriptEntry[]> {
  const acc = makeJsonlAccumulator();
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % yieldEveryLines === 0) await Bun.sleep(0);
    acc.push(lines[i]);
  }
  return acc.entries;
}

// Cache full parses keyed by (mtimeMs, size): re-opening an unchanged transcript
// is the common case (every WebSocket re-watch, every "load older history" click,
// SpinOff, terminal view), and a 31 MB transcript costs ~5 s to read+parse cold.
// Bounded to a handful of recent transcripts so a few large ones can't blow up
// the VPS's (swapless) memory. Entries are returned by reference — no current
// caller mutates the array in place (they spread / slice / JSON-serialize).
interface ParseCacheEntry {
  mtimeMs: number;
  size: number;
  entries: TranscriptEntry[];
}
const parseCache = new Map<string, ParseCacheEntry>();
const PARSE_CACHE_MAX = 24;
// Entry count alone is a poor bound — parsed entries keep base64 screenshot
// data-URLs, so 24 fat transcripts could pin hundreds of MB on a swapless box.
// Also cap cumulative bytes (estimated via the source file size at parse time),
// evicting oldest-first.
const PARSE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

function pruneParseCache(): void {
  let totalBytes = 0;
  for (const e of parseCache.values()) totalBytes += e.size;
  while (
    (parseCache.size > PARSE_CACHE_MAX || totalBytes > PARSE_CACHE_MAX_BYTES) &&
    parseCache.size > 1 // always keep the entry just inserted
  ) {
    const oldest = parseCache.keys().next().value;
    if (oldest === undefined) break;
    totalBytes -= parseCache.get(oldest)?.size ?? 0;
    parseCache.delete(oldest);
  }
}

// Read only the last `maxBytes` of a file straight off disk (positional read,
// not a full readFileSync) so opening a huge transcript doesn't pay to load the
// whole history. `truncated` is true when earlier bytes were skipped.
const DEFAULT_TAIL_BYTES = 256 * 1024;
function readTailBytes(
  path: string,
  maxBytes: number,
): { buf: Buffer; truncated: boolean; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    return { buf, truncated: start > 0, size };
  } finally {
    closeSync(fd);
  }
}

/** File size right now, 0 when it can't be stat'd. */
function fileSizeSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function parseTranscript(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return [];

  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
    const hit = parseCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      // Refresh LRU position
      parseCache.delete(path);
      parseCache.set(path, hit);
      return hit.entries;
    }
  } catch {
    // stat failed — fall through to an uncached parse
  }

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries = isCodexRolloutPath(path)
    ? parseCodexLines(lines)
    : parseJsonlLines(lines);

  if (mtimeMs) {
    parseCache.set(path, { mtimeMs, size, entries });
    pruneParseCache();
  }

  return entries;
}

/**
 * parseTranscript for bulk/background paths (legacy v2 imports, the
 * session-index sweep): async file read + chunk-yielding line parse so a big
 * transcript never wedges the event loop. Same cache as parseTranscript
 * (same key, same LRU), so the two variants serve each other's hits. Codex
 * rollouts still parse synchronously — they're small and the format isn't
 * safe to interleave.
 */
export async function parseTranscriptAsync(
  path: string,
): Promise<TranscriptEntry[]> {
  if (!existsSync(path)) return [];

  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
    const hit = parseCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      parseCache.delete(path);
      parseCache.set(path, hit);
      return hit.entries;
    }
  } catch {
    // stat failed — fall through to an uncached parse
  }

  const raw = await Bun.file(path).text();
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries = isCodexRolloutPath(path)
    ? parseCodexLines(lines)
    : await parseJsonlLinesAsync(lines);

  if (mtimeMs) {
    parseCache.set(path, { mtimeMs, size, entries });
    pruneParseCache();
  }

  return entries;
}

/**
 * Parse only the tail of a transcript for a fast initial render. Reads at most
 * `maxBytes` off the end of the file (so even a cold 30 MB transcript opens in
 * milliseconds) and returns `truncated: true` when earlier history was skipped,
 * which the UI surfaces as a "load earlier history" affordance that falls back
 * to the full `parseTranscript`. Codex rollouts parse in full (small, and the
 * format isn't safe to start mid-stream).
 *
 * Bytes are a poor proxy for messages: a couple of fat tool results can fill
 * the window while contributing two visible entries, hiding the opening prompt
 * behind "load earlier" even on a small transcript. So the window grows
 * (4× per pass, up to `MAX_TAIL_BYTES`) until it yields at least `minEntries`
 * parsed entries or spans the whole file; only genuinely huge transcripts stay
 * truncated.
 *
 * `endOffset` is the file size the returned entries cover, for handing to
 * `startWatching` as its initial offset — otherwise bytes appended between
 * this parse and the watch starting are never sent. Taken before/at the read,
 * so at worst the watcher re-sends an overlap, never skips.
 */
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
export function parseTranscriptTail(
  path: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
  minEntries = 40,
): {
  entries: TranscriptEntry[];
  truncated: boolean;
  endOffset: number;
  startOffset: number;
} {
  if (!existsSync(path))
    return { entries: [], truncated: false, endOffset: 0, startOffset: 0 };
  if (isCodexRolloutPath(path)) {
    const endOffset = fileSizeSafe(path);
    return {
      entries: parseTranscript(path),
      truncated: false,
      endOffset,
      startOffset: 0,
    };
  }

  let win = maxBytes;
  for (;;) {
    let buf: Buffer;
    let truncated: boolean;
    let size: number;
    try {
      ({ buf, truncated, size } = readTailBytes(path, win));
    } catch {
      const endOffset = fileSizeSafe(path);
      return {
        entries: parseTranscript(path),
        truncated: false,
        endOffset,
        startOffset: 0,
      };
    }

    // Drop the leading partial line so we never start mid-JSON-object.
    let chunk = buf;
    if (truncated) {
      const nl = buf.indexOf(0x0a);
      chunk = nl !== -1 ? buf.subarray(nl + 1) : Buffer.alloc(0);
    }
    // Where the parsed window begins — the "load earlier" pagination cursor
    // (parseTranscriptWindow reads the bytes before this offset).
    const startOffset = size - chunk.length;
    // If the read caught the writer mid-line, the tail after the last newline
    // is half an entry. Point endOffset at the last complete line so the
    // watcher re-reads the whole line once it's finished, instead of starting
    // mid-line and dropping the entry as unparseable.
    const lastNl = buf.lastIndexOf(0x0a);
    const endOffset = size - (buf.length - (lastNl + 1));
    const lines = chunk
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const entries = parseJsonlLines(lines);

    if (!truncated || entries.length >= minEntries)
      return { entries, truncated, endOffset, startOffset };
    if (win >= MAX_TAIL_BYTES) {
      // A single line larger than the cap (e.g. a huge embedded tool result)
      // would leave the tail empty — fall back to the full parse so the viewer
      // is never blank.
      if (entries.length === 0) {
        return {
          entries: parseTranscript(path),
          truncated: false,
          endOffset,
          startOffset: 0,
        };
      }
      return { entries, truncated, endOffset, startOffset };
    }
    win = Math.min(win * 4, MAX_TAIL_BYTES);
  }
}

/**
 * One "load earlier history" page: parse the byte window ENDING at
 * `beforeOffset` (a `startOffset` from parseTranscriptTail or a previous call
 * here), growing backwards until it yields `minEntries` entries or reaches the
 * start of the file. Same partial-line discipline as the tail parse. Replaces
 * the old full-file resend, whose wire payload hit ~15MB on big transcripts.
 */
export function parseTranscriptWindow(
  path: string,
  beforeOffset: number,
  maxBytes: number = DEFAULT_TAIL_BYTES,
  minEntries = 80,
  /** Soft window cap: once the window reaches this size, a partial page is
   *  returned rather than growing further — a fat tool-result region
   *  otherwise balloons one click to a multi-MB page. "Partial" still has an
   *  entry floor (a quarter of `minEntries`): per-entry wire clamping bounds
   *  the payload regardless of window size, so a 2-entry page only saves
   *  server read time while costing the reader a click (and an auto-load
   *  storm — the infinite-scroll sentinel stays in range after a tiny
   *  prepend). Past the floor the cap wins; below it the window keeps
   *  growing to MAX_TAIL_BYTES, so a click never returns a near-empty page. */
  maxWindowBytes: number = MAX_TAIL_BYTES,
): { entries: TranscriptEntry[]; startOffset: number; truncated: boolean } {
  if (!existsSync(path) || beforeOffset <= 0)
    return { entries: [], startOffset: 0, truncated: false };

  let win = maxBytes;
  for (;;) {
    const start = Math.max(0, beforeOffset - win);
    const len = beforeOffset - start;
    let buf: Buffer;
    try {
      const fd = openSync(path, "r");
      try {
        buf = Buffer.allocUnsafe(len);
        if (len > 0) readSync(fd, buf, 0, len, start);
      } finally {
        closeSync(fd);
      }
    } catch {
      return { entries: [], startOffset: beforeOffset, truncated: false };
    }

    let chunk = buf;
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      chunk = nl !== -1 ? buf.subarray(nl + 1) : Buffer.alloc(0);
    }
    const startOffset = beforeOffset - chunk.length;
    const lines = chunk
      .toString("utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const entries = parseJsonlLines(lines);

    if (start === 0 || entries.length >= minEntries) {
      // A growth pass can overshoot hard — a 4× window jump through a dense
      // region parses hundreds of entries where `minEntries` were asked, and
      // one click then renders a wall of bubbles. Trim leading lines back to
      // ~1.5× the target; byte-summing the dropped lines keeps the
      // pagination cursor exact. (Entries-per-line is only locally uniform,
      // so estimate then verify — halving the cut until the page still
      // clears `minEntries`, shipping the untrimmed window if none does.)
      if (start !== 0 && entries.length > minEntries * 2) {
        const rawLines = chunk.toString("utf-8").split("\n");
        const frac = (minEntries * 1.5) / entries.length;
        let cut = Math.floor(rawLines.length * (1 - frac));
        while (cut > 0) {
          const page = parseJsonlLines(
            rawLines.slice(cut).filter((l) => l.trim()),
          );
          if (page.length >= minEntries) {
            const droppedBytes = rawLines
              .slice(0, cut)
              .reduce((a, l) => a + Buffer.byteLength(l, "utf-8") + 1, 0);
            return {
              entries: page,
              startOffset: startOffset + droppedBytes,
              truncated: true,
            };
          }
          cut = Math.floor(cut / 2);
        }
      }
      return { entries, startOffset, truncated: startOffset > 0 };
    }
    if (
      win >= maxWindowBytes &&
      entries.length >= Math.max(1, Math.ceil(minEntries / 4))
    )
      return { entries, startOffset, truncated: startOffset > 0 };
    if (win >= MAX_TAIL_BYTES)
      return { entries, startOffset, truncated: startOffset > 0 };
    win = Math.min(win * 4, MAX_TAIL_BYTES);
  }
}

/**
 * Clamp giant entry contents before they go over the UI WebSocket. Some
 * entries carry megabyte contents (automation prompts embedding a full PR
 * diff, huge pasted logs) — shipped whole they make transcript_init/append
 * payloads cost seconds of transfer + JSON.parse, and the client's markdown
 * renderer (marked, superlinear) minutes. The UI shows the clamped head with
 * a "Show full message" affordance that fetches the real thing via
 * GET /api/sessions/:id/entry/:entryId. Server-side consumers (search,
 * engineUserTexts, fork/spin-off) keep reading the unclamped parse — this is
 * a wire concern only, applied at the serialization sites.
 */
export const WIRE_CLAMP_BYTES = 32 * 1024;
/**
 * Tighter clamp for the transcript-open payload (initial tail + history
 * pages): the UI eagerly renders only ~6KB of markdown per bubble
 * (EAGER_MD_CHARS) and fetches the full entry on "Show more" anyway, so
 * shipping 32KB per entry there only buys transfer + JSON.parse time — an
 * entry-heavy tail hit 1.7MB on the wire. Live appends keep the fatter clamp
 * (no extra fetch mid-conversation for a merely-large message).
 */
export const INIT_WIRE_CLAMP_BYTES = 8 * 1024;
function clampEntryForWire(e: TranscriptEntry, max: number): TranscriptEntry {
  if ((e.content?.length ?? 0) <= max) return e;
  return {
    ...e,
    content: e.content.slice(0, max),
    contentClamped: true,
    contentLength: e.content.length,
  };
}

/** Wire-clamp a batch; returns the same array when nothing needed clamping. */
export function clampEntriesForWire(
  entries: TranscriptEntry[],
  maxBytes: number = WIRE_CLAMP_BYTES,
): TranscriptEntry[] {
  if (!entries.some((e) => (e.content?.length ?? 0) > maxBytes)) return entries;
  return entries.map((e) => clampEntryForWire(e, maxBytes));
}

/** Strip injected context from already-stored user entries. New parser output
 * is clean before persistence, but old transcript-store rows can contain the
 * pre-fence pinned-goal suffix. An injection-only row has no conversation to
 * render; media-bearing rows stay so an attachment cannot disappear with it. */
function stripStoredUserContext(entries: TranscriptEntry[]): TranscriptEntry[] {
  let changed = false;
  const shown: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "user") {
      shown.push(entry);
      continue;
    }
    const content = stripContext(entry.content);
    if (content === entry.content) {
      shown.push(entry);
      continue;
    }
    changed = true;
    if (content.trim() || entry.images?.length || entry.files?.length) {
      shown.push({ ...entry, content });
    }
  }
  return changed ? shown : entries;
}

/** Hide model-only context while preserving the one structural fact a reader
 * needs: a background wait starts another agent turn. The payload stays
 * private; clients receive only a content-free boundary carrying the original
 * sequence identity, so old stored waits gain the fix without migration. */
function projectContextForWire(entries: TranscriptEntry[]): TranscriptEntry[] {
  const projected: TranscriptEntry[] = [];
  for (const entry of entries) {
    const contextRecord =
      entry.noticeKind === "context-injection" ||
      entry.noticeKind === "standing-context";
    if (!contextRecord) {
      projected.push(entry);
      continue;
    }
    if (entry.contextInjection?.source === "background-wait") {
      projected.push({
        id: entry.id,
        type: "user",
        content: "",
        timestamp: entry.timestamp,
        turnBoundary: true,
        ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
        ...(entry.changeSeq !== undefined
          ? { changeSeq: entry.changeSeq }
          : {}),
      });
    }
  }
  return projected;
}

/** Parser and persistence metadata has done its job by this point. Keeping it
 * on every assistant and tool row repeats opaque ids a client never reads. */
function stripInternalWireFields(
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  let changed = false;
  const projected = entries.map((entry) => {
    if (
      entry.requestId === undefined &&
      entry.noticeKind === undefined &&
      entry.contextInjection === undefined
    )
      return entry;
    changed = true;
    const clean = { ...entry };
    delete clean.requestId;
    delete clean.noticeKind;
    delete clean.contextInjection;
    return clean;
  });
  return changed ? projected : entries;
}

/**
 * Everything a batch of entries needs before it leaves the server: strip
 * injected context, classify how each entry reads (notices.ts), say what each
 * tool call is (tool-presentation.ts), and remove server-only metadata before
 * the caller clamps what's left.
 *
 * That order is load-bearing. The context pass strips fenced and legacy
 * injections; the classifier strips delivery plumbing such as "[Name] "
 * prefixes and the "💬 X answered" header. Clamping afterwards therefore
 * measures the text a reader will actually see. Running both on the way out is
 * why history needs no migration, even for rows persisted before the markers.
 *
 * Use this at every send site; `clampEntriesForWire` alone would ship raw
 * plumbing to a client that no longer knows how to parse it.
 */
export function prepareEntriesForWire(
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  return stripInternalWireFields(
    withToolPresentations(
      classifyEntries(stripStoredUserContext(projectContextForWire(entries))),
    ),
  );
}

export function entriesForWire(
  entries: TranscriptEntry[],
  maxBytes: number = WIRE_CLAMP_BYTES,
): TranscriptEntry[] {
  return clampEntriesForWire(prepareEntriesForWire(entries), maxBytes);
}

/**
 * Find the first transcript entry whose *visible* text (a message, a tool
 * result, or a tool call's serialized input) contains `query`
 * (case-insensitive) and return a short snippet with the match in context.
 * Returns null when the query only appears in transcript metadata/structure
 * (base64 image data, JSON keys, tool-use ids) that we never render — so this
 * doubles as a false-positive filter for a cheap ripgrep pre-pass over the raw
 * jsonl. Uses the shared parse cache.
 */
export function transcriptMatchSnippet(
  path: string,
  query: string,
  ctx: number = 60,
): string | null {
  for (const entry of parseTranscript(path)) {
    const snippet = transcriptEntryMatchSnippet(entry, query, ctx);
    if (snippet) return snippet;
  }
  return null;
}

export function parseTranscriptFrom(
  path: string,
  byteOffset: number,
): { entries: TranscriptEntry[]; newOffset: number; ok: boolean } {
  if (!existsSync(path))
    return { entries: [], newOffset: byteOffset, ok: false };

  // Positional read of just [byteOffset, EOF) — this runs every second per
  // watched session (file-watcher poll), and a full readFileSync of a 30 MB
  // transcript per tick is exactly the kind of load the swapless VPS can't eat.
  let buf: Buffer;
  let size: number;
  try {
    const fd = openSync(path, "r");
    try {
      size = fstatSync(fd).size;
      if (size <= byteOffset)
        return { entries: [], newOffset: byteOffset, ok: true };
      const len = size - byteOffset;
      buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, byteOffset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { entries: [], newOffset: byteOffset, ok: false };
  }
  // Consume only complete (newline-terminated) lines. The writer appends big
  // jsonl lines non-atomically, so a poll can catch the last line half-written;
  // advancing the offset to EOF would strand its remainder as unparseable
  // garbage on the next poll — silently losing the entry (a lost *user* line
  // has no other live delivery path, so the sender's bubble never reconciles).
  // Leave the partial tail for the next poll instead.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return { entries: [], newOffset: byteOffset, ok: true };
  const consumed = lastNl + 1;
  const chunk = buf.subarray(0, consumed).toString("utf-8");
  const newOffset = byteOffset + consumed;
  const lines = chunk.split("\n").filter((l) => l.trim());

  if (isCodexRolloutPath(path)) {
    return { entries: parseCodexLines(lines), newOffset, ok: true };
  }

  const entries: TranscriptEntry[] = [];

  for (const line of lines) {
    let parsed: RawJsonlEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    entries.push(...parseEntry(parsed));
  }

  return { entries, newOffset, ok: true };
}
