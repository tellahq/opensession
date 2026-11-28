/**
 * Slack API helpers for the Slack agent.
 *
 * Wraps common Slack Web API calls (chat.postMessage, reactions, etc.)
 * using fetch() + SLACK_BOT_TOKEN from process.env.
 */

import { MAX_PROMPT_IMAGES } from "@tellahq/opensession-protocol/session";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import { personaName } from "../../server/config";
import type { ImageInput } from "../../server/run-events";
import { sanitizeAttachmentName } from "../../server/prompt-attachments";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "path";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
export const MAX_SLACK_UPLOAD_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// File attachments
// ---------------------------------------------------------------------------

/**
 * A file attached to a Slack message. Queued messages carry these small refs
 * (id/name/url — never the bytes, so the persisted queue stays tiny) and the
 * actual download happens right before the run starts, so images land in the
 * opening prompt as native image parts and other files reach the run on disk,
 * instead of the agent having to fetch them afterwards.
 */
export interface SlackFileRef {
  id: string;
  name: string;
  mimetype: string;
  /** Authenticated download URL (url_private_download / url_private). */
  url: string;
  size: number;
}

export function slackFileRefs(files: any[] | undefined): SlackFileRef[] {
  return (files || [])
    .filter((f: any) => f && (f.url_private_download || f.url_private))
    .map((f: any) => ({
      id: String(f.id || ""),
      name: String(f.name || f.title || "file"),
      mimetype: String(f.mimetype || ""),
      url: String(f.url_private_download || f.url_private),
      size: Number(f.size || 0),
    }));
}

// Anthropic caps images at 5MB; stay under it, and bound the total payload.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Largest non-image attachment downloaded for a run (a contract PDF, a
 *  spreadsheet). The same cap a composer upload read whole has. */
export const MAX_SLACK_FILE_BYTES = 50 * 1024 * 1024;

export interface SlackAttachments {
  images: ImageInput[];
  /** Non-image files on disk, as the {name, path} refs a composer upload
   *  produces, so a run receives them the same way. */
  files: { name: string; path: string }[];
  note: string;
}

/**
 * Download the attachments among `files` (bot-token auth). Images become
 * prompt-ready image parts; any other file is streamed to its own directory
 * under `fileDir` and returned as a file ref, so a PDF or document reaches the
 * run by path instead of being dropped. The note lists every attachment,
 * including anything skipped, so the agent knows what came with the message.
 * Without `fileDir`, non-image files are only listed.
 */
export async function downloadSlackAttachments(
  files: SlackFileRef[],
  fileDir?: string,
): Promise<SlackAttachments> {
  const images: ImageInput[] = [];
  const staged: { name: string; path: string }[] = [];
  const lines: string[] = [];
  for (const f of files) {
    const type = f.mimetype || "unknown type";
    if (!f.mimetype.startsWith("image/")) {
      if (!fileDir) {
        lines.push(`- ${f.name} (${type}) — not inlined`);
        continue;
      }
      if (f.size > MAX_SLACK_FILE_BYTES) {
        lines.push(`- ${f.name} (${type}) — skipped, too large to download`);
        continue;
      }
      try {
        staged.push(await downloadSlackFile(f, fileDir));
        lines.push(`- ${f.name} (${type}) — saved to disk, path below`);
      } catch (e) {
        console.warn(`[slack] Failed to download attachment ${f.name}:`, e);
        lines.push(`- ${f.name} (${type}) — download failed`);
      }
      continue;
    }
    if (images.length >= MAX_PROMPT_IMAGES) {
      lines.push(`- ${f.name} (${f.mimetype}) — skipped, image limit reached`);
      continue;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      lines.push(`- ${f.name} (${f.mimetype}) — skipped, too large to inline`);
      continue;
    }
    try {
      const resp = await fetchSlackFile(f);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("too large");
      images.push({
        mediaType: f.mimetype,
        data: Buffer.from(buf).toString("base64"),
      });
      lines.push(`- ${f.name} (${f.mimetype}) — attached below as an image`);
    } catch (e) {
      console.warn(`[slack] Failed to download attachment ${f.name}:`, e);
      lines.push(`- ${f.name} (${f.mimetype}) — download failed`);
    }
  }
  const note = lines.length ? `Attached files:\n${lines.join("\n")}` : "";
  return { images, files: staged, note };
}

async function fetchSlackFile(f: SlackFileRef): Promise<Response> {
  const resp = await fetchWithTimeout(f.url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  // Slack serves an HTML login page (not the file) when auth fails. A real
  // HTML attachment is reported as text/html by Slack itself, so only treat
  // HTML as a login page when the file was not supposed to be HTML.
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html") && !f.mimetype.includes("html"))
    throw new Error("auth redirect");
  return resp;
}

/** Stream one file to `<fileDir>/slack-<file id>/<name>`. Keyed by the Slack
 *  file id, so a retried delivery rewrites the same path. */
async function downloadSlackFile(
  f: SlackFileRef,
  fileDir: string,
): Promise<{ name: string; path: string }> {
  const resp = await fetchSlackFile(f);
  const dir = join(
    fileDir,
    `slack-${sanitizeAttachmentName(f.id || randomUUID())}`,
  );
  await mkdir(dir, { recursive: true });
  const path = join(dir, sanitizeAttachmentName(f.name));
  const written = await Bun.write(path, resp);
  if (written === 0 || written > MAX_SLACK_FILE_BYTES) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(written ? "too large" : "empty file");
  }
  return { name: f.name, path };
}

// ---------------------------------------------------------------------------
// Status messages
// ---------------------------------------------------------------------------

export const MESSAGES = {
  received: "Got it, let me think about this...",
  thinking: "I'm analyzing the situation...",
  worktreeCreating: "Setting up a worktree for this task...",
  worktreeReady: "Worktree ready! Running Claude Code...",
  complete: "Done!",
  error: "Oops, something went wrong.",
};

// ---------------------------------------------------------------------------
// Core API call helper
// ---------------------------------------------------------------------------

export async function slackApiCall(
  method: string,
  params: Record<string, any>,
  /** Act as a specific user (xoxp- grant token) instead of the bot. */
  tokenOverride?: string,
): Promise<any> {
  const resp = await fetchWithTimeout(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenOverride || SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!(data as any).ok) {
    console.warn(`[slack] Slack API ${method} error:`, (data as any).error);
  }
  return data;
}

/**
 * GET variant for Slack's read methods (conversations.list/history/replies):
 * they want query params — a JSON POST body is silently ignored, which
 * surfaces as invalid_arguments/missing filters.
 */
export async function slackApiGet(
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  tokenOverride?: string,
): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const resp = await fetchWithTimeout(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${tokenOverride || SLACK_BOT_TOKEN}` },
  });
  const data = await resp.json();
  if (!(data as any).ok) {
    console.warn(`[slack] Slack API ${method} error:`, (data as any).error);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

export async function sendSlackMessage(
  channel: string,
  text: string,
  threadTs?: string,
  tokenOverride?: string,
): Promise<any> {
  const response = await fetchWithTimeout(
    "https://slack.com/api/chat.postMessage",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenOverride || SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        text,
        thread_ts: threadTs,
        mrkdwn: true,
      }),
    },
  );
  return response.json();
}

/**
 * Public link to a message we just posted. Best effort on purpose: the message
 * is already in Slack, so a failed lookup must not fail the send.
 */
export async function slackPermalink(
  channel: string,
  ts: string,
  tokenOverride?: string,
): Promise<string | undefined> {
  try {
    const data = await slackApiGet(
      "chat.getPermalink",
      { channel, message_ts: ts },
      tokenOverride,
    );
    return data?.ok && typeof data.permalink === "string"
      ? data.permalink
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The message timestamp a file was shared into `channel` on. A file reports
 * its shares per channel rather than as a top-level ts.
 */
export function slackFileShareTs(
  file: any,
  channel: string,
): string | undefined {
  const shares = file?.shares;
  for (const scope of [shares?.public, shares?.private]) {
    const ts = scope?.[channel]?.[0]?.ts;
    if (typeof ts === "string") return ts;
  }
  return undefined;
}

/**
 * The message an upload landed in. files.completeUploadExternal answers with
 * `{ id, title }` and no shares, so the share normally has to be read back off
 * the file. Best effort, like slackPermalink.
 */
export async function slackUploadTs(
  completed: any,
  channel: string,
  tokenOverride?: string,
): Promise<string | undefined> {
  const posted = completed?.files?.[0];
  const ts = slackFileShareTs(posted, channel);
  if (ts) return ts;
  if (typeof posted?.id !== "string") return undefined;
  try {
    const info = await slackApiGet(
      "files.info",
      { file: posted.id },
      tokenOverride,
    );
    return slackFileShareTs(info?.file, channel);
  } catch {
    return undefined;
  }
}

/** Link to the message an upload landed in. Best effort, like slackPermalink. */
export async function slackUploadPermalink(
  completed: any,
  channel: string,
  tokenOverride?: string,
): Promise<string | undefined> {
  const ts = await slackUploadTs(completed, channel, tokenOverride);
  return ts ? slackPermalink(channel, ts, tokenOverride) : undefined;
}

/**
 * Remove a message from Slack: the undo offered after a reviewed draft is
 * sent. The bot token deletes the bot's own messages, so callers must check
 * the message is one they recorded sending for this person.
 */
export async function deleteSlackMessage(
  channel: string,
  ts: string,
  tokenOverride?: string,
): Promise<void> {
  const data = await slackApiCall(
    "chat.delete",
    { channel, ts },
    tokenOverride,
  );
  if (!data?.ok) {
    throw new Error(
      data?.error === "cant_delete_message" ||
        data?.error === "message_not_found"
        ? "Slack would not delete that message"
        : data?.error || "Slack would not delete that message",
    );
  }
}

export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string,
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, ts, text, mrkdwn: true }),
  });
  return response.json();
}

export async function addReaction(
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  await fetchWithTimeout("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
  });
}

export async function removeReaction(
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  await fetchWithTimeout("https://slack.com/api/reactions.remove", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
  });
}

export async function postSlackBlocks(
  channel: string,
  fallbackText: string,
  blocks: any[],
  threadTs?: string,
  opts?: { unfurlLinks?: boolean; unfurlMedia?: boolean; clientMsgId?: string },
): Promise<any> {
  const response = await fetchWithTimeout(
    "https://slack.com/api/chat.postMessage",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        text: fallbackText,
        blocks,
        thread_ts: threadTs,
        ...(opts?.clientMsgId ? { client_msg_id: opts.clientMsgId } : {}),
        ...(opts?.unfurlLinks !== undefined
          ? { unfurl_links: opts.unfurlLinks }
          : {}),
        ...(opts?.unfurlMedia !== undefined
          ? { unfurl_media: opts.unfurlMedia }
          : {}),
      }),
    },
  );
  return response.json();
}

async function slackFormCall(
  method: string,
  params: Record<string, string | number>,
  tokenOverride?: string,
): Promise<any> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    body.set(key, String(value));
  const response = await fetchWithTimeout(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Authorization: `Bearer ${tokenOverride || SLACK_BOT_TOKEN}`,
    },
    body,
  });
  const data = await response.json();
  if (!(data as any).ok) {
    console.warn(`[slack] Slack API ${method} error:`, (data as any).error);
  }
  return data;
}

/**
 * Upload a local file and share it as one Slack message. Slack retired the
 * single-call files.upload endpoint, so this follows its external-upload
 * handshake: reserve an upload URL, send the bytes, then complete and share.
 */
export async function postSlackFile(
  channel: string,
  path: string,
  initialComment: string,
  opts?: SlackUploadOptions,
  tokenOverride?: string,
): Promise<any> {
  return postSlackFiles(channel, [path], initialComment, opts, tokenOverride);
}

export interface SlackUploadOptions {
  title?: string;
  altText?: string;
  /** Share into a thread rather than at the top of the channel. */
  threadTs?: string;
}

/**
 * Slack's external upload, step one and two: reserve an upload URL for one
 * file, then send its bytes. Returns the file id to share with
 * `completeSlackUpload`. A grant without files:write throws
 * SLACK_RECONNECT_REQUIRED.
 */
export async function reserveSlackUpload(
  filename: string,
  bytes: Uint8Array<ArrayBuffer>,
  altText?: string,
  tokenOverride?: string,
): Promise<string> {
  const length = bytes.byteLength;
  if (!length || length > MAX_SLACK_UPLOAD_BYTES)
    throw new Error(
      `Slack upload must be between 1 byte and 20 MB: ${filename}`,
    );
  const reserved = await slackFormCall(
    "files.getUploadURLExternal",
    {
      filename,
      length,
      ...(altText ? { alt_txt: altText.slice(0, 1000) } : {}),
    },
    tokenOverride,
  );
  if (!reserved?.ok || !reserved.upload_url || !reserved.file_id) {
    if (reserved?.error === "missing_scope")
      throw new Error("SLACK_RECONNECT_REQUIRED");
    throw new Error(
      `Slack upload reservation failed: ${reserved?.error || "invalid response"}`,
    );
  }
  const uploaded = await fetchWithTimeout(reserved.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!uploaded.ok)
    throw new Error(`Slack file upload failed: HTTP ${uploaded.status}`);
  return String(reserved.file_id);
}

/** Slack's external upload, last step: share reserved files as one message. */
export async function completeSlackUpload(
  channel: string,
  files: Array<{ id: string; title: string }>,
  initialComment: string,
  threadTs?: string,
  tokenOverride?: string,
): Promise<any> {
  const completed = await slackFormCall(
    "files.completeUploadExternal",
    {
      files: JSON.stringify(files),
      channel_id: channel,
      // An empty comment is not "no comment" to Slack: it posts the share with a
      // blank line above the files.
      ...(initialComment ? { initial_comment: initialComment } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
    tokenOverride,
  );
  if (!completed?.ok) {
    throw new Error(
      `Slack upload completion failed: ${completed?.error || "invalid response"}`,
    );
  }
  return completed;
}

/** Upload several local images and share them together as one Slack message. */
export async function postSlackFiles(
  channel: string,
  paths: string[],
  initialComment: string,
  opts?: SlackUploadOptions,
  tokenOverride?: string,
): Promise<any> {
  const files: Array<{ id: string; title: string }> = [];
  for (const [index, path] of paths.entries()) {
    const filename = basename(path);
    const info = await stat(path);
    if (!info.isFile())
      throw new Error(`Slack upload path is not a regular file: ${path}`);
    if (!info.size || info.size > MAX_SLACK_UPLOAD_BYTES) {
      throw new Error(`Slack upload must be between 1 byte and 20 MB: ${path}`);
    }
    const id = await reserveSlackUpload(
      filename,
      new Uint8Array(await readFile(path)),
      opts?.altText,
      tokenOverride,
    );
    files.push({
      id,
      // Numbered only when the caller named the set. Without a title the
      // filename is the better label: a batch can be a screenshot, a frame
      // and a clip, and "Screenshot 3" is wrong for two of them.
      title: opts?.title
        ? paths.length === 1
          ? opts.title
          : `${opts.title} ${index + 1}`
        : filename,
    });
  }
  return completeSlackUpload(
    channel,
    files,
    initialComment,
    opts?.threadTs,
    tokenOverride,
  );
}

export async function updateSlackBlocks(
  channel: string,
  ts: string,
  text: string,
  blocks: any[],
  opts?: { unfurlLinks?: boolean; unfurlMedia?: boolean; clientMsgId?: string },
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel,
      ts,
      text,
      blocks,
      ...(opts?.unfurlLinks !== undefined
        ? { unfurl_links: opts.unfurlLinks }
        : {}),
      ...(opts?.unfurlMedia !== undefined
        ? { unfurl_media: opts.unfurlMedia }
        : {}),
    }),
  });
  return response.json();
}

export async function openSlackModal(
  triggerId: string,
  questionId: string,
  questionText: string,
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: `askq-modal-${questionId}`,
        title: { type: "plain_text", text: "Custom Answer", emoji: true },
        submit: { type: "plain_text", text: "Submit", emoji: true },
        close: { type: "plain_text", text: "Cancel", emoji: true },
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: questionText },
          },
          {
            type: "input",
            block_id: "answer_block",
            element: {
              type: "plain_text_input",
              action_id: "answer_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "Type your answer...",
              },
            },
            label: { type: "plain_text", text: "Your answer", emoji: true },
          },
        ],
      },
    }),
  });
  return response.json();
}

/**
 * Open the "Other…" free-text modal for a human-in-the-loop ask (mirrors
 * openSlackModal, but with the humanask callback prefix so the interactivity
 * endpoint routes the submission to the human-asks registry).
 */
export async function openHumanAskModal(
  triggerId: string,
  askId: string,
  questionText: string,
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: `humanask-modal-${askId}`,
        title: { type: "plain_text", text: "Your answer", emoji: true },
        submit: { type: "plain_text", text: "Send", emoji: true },
        close: { type: "plain_text", text: "Cancel", emoji: true },
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: questionText } },
          {
            type: "input",
            block_id: "answer_block",
            element: {
              type: "plain_text_input",
              action_id: "answer_input",
              multiline: true,
              placeholder: { type: "plain_text", text: "Type your answer…" },
            },
            label: { type: "plain_text", text: "Your answer", emoji: true },
          },
        ],
      },
    }),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Context fetchers
// ---------------------------------------------------------------------------

export interface ThreadContext {
  /** Transcript text, one `[user]: text` line per message (files annotated). */
  text: string;
  /** File attachments found on the thread's messages, in message order. */
  files: SlackFileRef[];
}

export async function fetchThreadContext(
  channel: string,
  threadTs: string,
): Promise<ThreadContext> {
  const response = await fetchWithTimeout(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=20`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
  );
  const data = (await response.json()) as any;

  if (!data.ok || !data.messages) {
    console.error("[slack] Failed to fetch thread:", data.error);
    return { text: "", files: [] };
  }

  const files: SlackFileRef[] = [];
  const text = data.messages
    .map((msg: any) => {
      const refs = slackFileRefs(msg.files);
      files.push(...refs);
      const fileNote = refs.length
        ? ` [attached: ${refs.map((f) => f.name).join(", ")}]`
        : "";
      return `[${msg.user || "bot"}]: ${msg.text}${fileNote}`;
    })
    .join("\n\n");
  return { text, files };
}

// ---------------------------------------------------------------------------
// Channel info / kind (for memory scoping)
// ---------------------------------------------------------------------------

export async function getChannelInfo(
  channelId: string,
): Promise<{ is_private?: boolean; is_im?: boolean; name?: string } | null> {
  const data = await slackApiCall("conversations.info", { channel: channelId });
  if (data.ok && data.channel) return data.channel;
  return null;
}

const channelKindCache = new Map<
  string,
  { isDM: boolean; isPrivate: boolean; name?: string; at: number }
>();
const CHANNEL_KIND_TTL_MS = 60 * 60 * 1000;

/**
 * Resolve whether a channel is a DM / private channel. Cached for an hour —
 * modern Slack uses "C…" ids for both public and private channels, so we can't
 * tell them apart from the id alone and must ask conversations.info.
 */
export async function getChannelKind(
  channelId: string,
): Promise<{ isDM: boolean; isPrivate: boolean; name?: string }> {
  if (channelId.startsWith("D")) return { isDM: true, isPrivate: false };
  const cached = channelKindCache.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_KIND_TTL_MS) {
    return {
      isDM: cached.isDM,
      isPrivate: cached.isPrivate,
      name: cached.name,
    };
  }
  const info = await getChannelInfo(channelId);
  const kind = {
    isDM: !!info?.is_im,
    isPrivate: !!info?.is_private,
    name: typeof info?.name === "string" && info.name ? info.name : undefined,
  };
  channelKindCache.set(channelId, { ...kind, at: Date.now() });
  return kind;
}

// ---------------------------------------------------------------------------
// User info
// ---------------------------------------------------------------------------

/**
 * Open (or fetch the existing) DM channel with a user and return its channel id,
 * so we can post a message into a teammate's DM. Used by the human-in-the-loop
 * asks (src/server/human-asks.ts). Returns null if Slack refuses.
 */
export async function openDirectMessage(
  slackUserId: string,
): Promise<string | null> {
  const data = await slackApiCall("conversations.open", { users: slackUserId });
  return data.ok && data.channel?.id ? data.channel.id : null;
}

export async function getUserInfo(
  userId: string,
): Promise<{ name: string; real_name: string } | null> {
  const response = await fetchWithTimeout(
    `https://slack.com/api/users.info?user=${userId}`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
  );
  const data = (await response.json()) as any;
  if (data.ok && data.user) {
    return {
      name: data.user.name,
      real_name: data.user.real_name || data.user.name,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Linked-channel chat (opensession Slack panel)
// ---------------------------------------------------------------------------

import { SLACK_ID_TO_NAME } from "../../server/shared/user-mappings";

export interface SlackHistoryMessage {
  ts: string;
  userId: string | null;
  userName: string;
  avatarUrl?: string;
  text: string;
  isBot: boolean;
}

/** Turn raw Slack mention tokens `<@U…>` into readable `@First` for display. */
export function prettifyMentions(text: string): string {
  return text.replace(/<@(U[A-Z0-9]+)>/g, (_m, id) => {
    const name = SLACK_ID_TO_NAME[id];
    return name ? `@${name.split(" ")[0]}` : "@someone";
  });
}

// Cache resolved user name + avatar for an hour (history renders many messages).
const userProfileCache = new Map<
  string,
  { name: string; avatarUrl?: string; at: number }
>();
const USER_PROFILE_TTL_MS = 60 * 60 * 1000;

/** Resolve a Slack user id → display name + avatar (cached). */
export async function resolveSlackUser(
  userId: string,
): Promise<{ name: string; avatarUrl?: string }> {
  const cached = userProfileCache.get(userId);
  if (cached && Date.now() - cached.at < USER_PROFILE_TTL_MS) {
    return { name: cached.name, avatarUrl: cached.avatarUrl };
  }
  let name = SLACK_ID_TO_NAME[userId];
  let avatarUrl: string | undefined;
  try {
    const resp = await fetchWithTimeout(
      `https://slack.com/api/users.info?user=${userId}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
    );
    const data = (await resp.json()) as any;
    if (data.ok && data.user) {
      name = name || data.user.real_name || data.user.name;
      avatarUrl = data.user.profile?.image_72 || data.user.profile?.image_48;
    }
  } catch {}
  name = name || userId;
  userProfileCache.set(userId, { name, avatarUrl, at: Date.now() });
  return { name, avatarUrl };
}

/**
 * Read recent messages from a channel (chronological). Includes human messages
 * and bot posts (our own "post as you" + bot replies); skips join/leave/topic
 * system subtypes. Needs `channels:history` + the bot in the channel.
 */
export async function fetchChannelHistory(
  channelId: string,
  limit = 50,
): Promise<SlackHistoryMessage[]> {
  const data = await slackApiCall("conversations.history", {
    channel: channelId,
    limit,
  });
  if (!data.ok || !Array.isArray(data.messages)) return [];
  const chronological = [...data.messages].reverse();
  const out: SlackHistoryMessage[] = [];
  for (const m of chronological) {
    if (m.type !== "message") continue;
    if (m.subtype && m.subtype !== "bot_message") continue;
    if (!m.text) continue;
    // A bot post (our "post as you" override or an agent reply) carries bot_id
    // and the bot's own user id — so check bot-ness first and use the override
    // username, otherwise a real human message resolves via the user id.
    if (m.bot_id || m.subtype === "bot_message") {
      out.push({
        ts: m.ts,
        userId: null,
        userName: m.username || personaName(),
        avatarUrl: m.icons?.image_72 || m.icons?.image_48,
        text: prettifyMentions(m.text),
        isBot: true,
      });
    } else if (m.user) {
      const u = await resolveSlackUser(m.user);
      out.push({
        ts: m.ts,
        userId: m.user,
        userName: u.name,
        avatarUrl: u.avatarUrl,
        text: prettifyMentions(m.text),
        isBot: false,
      });
    }
  }
  return out;
}
