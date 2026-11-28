import { z } from "zod";
import type { RichAttachment, RichBlock } from "../../../shared/slack-rich";
import { BASE_PATH } from "../base";
import { BASE, request } from "./request";

// The Channels place's Slack calls (server/routes/slack-channels.ts). Reads
// and posts go through the signed-in person's own Slack grant.

export type ConversationKind = "channel" | "private" | "dm" | "group";

export interface Conversation {
  id: string;
  name: string;
  kind: ConversationKind;
  userId?: string;
  avatarUrl?: string;
  unread?: boolean;
  unreadCount?: number;
  latestTs?: string;
}

export interface ConversationsPayload {
  /** The person has connected their Slack account. */
  connected: boolean;
  conversations: Conversation[];
  /** False for a grant from before direct messages were asked for. */
  directMessages: boolean;
}

export interface ConversationInfo {
  id: string;
  name: string;
  kind: ConversationKind;
  avatarUrl?: string;
  topic: string;
  memberCount?: number;
}

export interface MessageReaction {
  name: string;
  count: number;
  /** Unicode char for standard emoji. */
  emoji?: string;
  /** Image URL for custom workspace emoji. */
  url?: string;
  /** The person reacted with this one. */
  mine?: boolean;
}

export interface MessageFile {
  name: string;
  /** Root-relative API path of an image's preview. */
  thumb?: string;
  width?: number;
  height?: number;
  permalink?: string;
}

export interface ChannelMessage {
  ts: string;
  userId?: string;
  userName: string;
  avatarUrl?: string;
  text: string;
  isBot: boolean;
  replyCount?: number;
  latestReply?: string;
  replyUsers?: { name: string; avatarUrl?: string }[];
  reactions?: MessageReaction[];
  files?: MessageFile[];
  edited?: boolean;
  /** A thread reply also sent to the channel. */
  broadcast?: boolean;
  /** An app's own layout, shown in place of the text. */
  blocks?: RichBlock[];
  /** App cards, link previews and shared messages under the text. */
  attachments?: RichAttachment[];
  /** The reader wrote it, so they may edit or delete it. */
  mine?: boolean;
  /** For an own message: its Slack markup, to edit from. */
  source?: string;
}

export interface MessagesPage {
  messages: ChannelMessage[];
  hasMore: boolean;
  /** Read with the person's own grant (they can post). */
  asUser: boolean;
}

const channelPath = (id: string) => `/slack/channels/${encodeURIComponent(id)}`;

export function fetchConversations(): Promise<ConversationsPayload> {
  return request("/slack/conversations", {
    label: "Couldn't load your Slack channels",
  });
}

export function fetchConversationInfo(id: string): Promise<ConversationInfo> {
  return request(channelPath(id), { label: "Couldn't load this channel" });
}

export function fetchMessages(
  id: string,
  opts: { before?: string; thread?: string } = {},
): Promise<MessagesPage> {
  const params = new URLSearchParams();
  if (opts.before) params.set("before", opts.before);
  if (opts.thread) {
    params.set("thread_ts", opts.thread);
    params.set("limit", "100");
  }
  const query = params.size ? `?${params}` : "";
  return request(`${channelPath(id)}/messages${query}`, {
    label: "Couldn't load messages",
  });
}

/** A file uploaded to Slack, waiting for the message that shares it. */
export interface UploadedFile {
  id: string;
  title: string;
}

/** What the server takes to post: a reply names its thread's parent. */
export interface PostMessageBody {
  text: string;
  thread_ts?: string;
  /** A reply also sent to the channel. */
  broadcast?: boolean;
  /** Uploaded files to share with the text as their comment. */
  files?: UploadedFile[];
}

export function postMessage(
  id: string,
  text: string,
  thread?: { ts: string; broadcast?: boolean },
  files: UploadedFile[] = [],
): Promise<{ ok: boolean; ts?: string }> {
  const body: PostMessageBody = { text };
  if (thread) {
    body.thread_ts = thread.ts;
    body.broadcast = !!thread.broadcast;
  }
  if (files.length) body.files = files;
  return request(`${channelPath(id)}/messages`, {
    method: "POST",
    body,
    label: "Couldn't send the message",
  });
}

/** Slack's limit for one uploaded file. */
export const SLACK_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const uploadResponse = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
});

/** Send one file to Slack; the next message shares it. The body is the file
 *  itself, so a large one is not read into the page first. */
export async function uploadFile(
  id: string,
  file: File,
): Promise<UploadedFile> {
  if (file.size > SLACK_UPLOAD_MAX_BYTES)
    throw new Error(`${file.name} is too large (20 MB max)`);
  const res = await fetch(`${BASE}${channelPath(id)}/uploads`, {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(file.name || "file"),
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  const parsed = uploadResponse.safeParse(await res.json().catch(() => null));
  const body = parsed.success ? parsed.data : null;
  if (!res.ok || !body?.id)
    throw new Error(body?.error || `Couldn't upload ${file.name}`);
  return { id: body.id, title: body.title || file.name };
}

export function editMessage(
  id: string,
  ts: string,
  text: string,
): Promise<{ ok: boolean; text: string; source: string }> {
  return request(`${channelPath(id)}/messages`, {
    method: "PATCH",
    body: { ts, text },
    label: "Couldn't save the edit",
  });
}

export function deleteMessage(
  id: string,
  ts: string,
): Promise<{ ok: boolean }> {
  return request(`${channelPath(id)}/messages?ts=${encodeURIComponent(ts)}`, {
    method: "DELETE",
    label: "Couldn't delete the message",
  });
}

export function markRead(id: string, ts: string): Promise<{ ok: boolean }> {
  return request(`${channelPath(id)}/read`, {
    method: "POST",
    body: { ts },
    label: "Couldn't mark the channel read",
  });
}

export function setReaction(
  id: string,
  ts: string,
  name: string,
  remove: boolean,
): Promise<{ ok: boolean }> {
  return request(`${channelPath(id)}/reactions`, {
    method: "POST",
    body: { ts, name, remove },
    label: "Couldn't react",
  });
}

export function fetchPermalink(
  id: string,
  ts: string,
): Promise<{ url: string }> {
  return request(`${channelPath(id)}/permalink?ts=${encodeURIComponent(ts)}`, {
    label: "Couldn't get the message link",
  });
}

/** A thread you are in, as the Threads page shows it. */
export interface ThreadSummary {
  channelId: string;
  /** The conversation's name, or the person's for a direct message. */
  channelName: string;
  isDirect: boolean;
  parent: ChannelMessage;
  /** The latest replies, oldest first. */
  latest: ChannelMessage[];
  replyCount: number;
  latestReply: string;
}

/** A message you sent, as Drafts & sent lists it. */
export interface SentMessage {
  channelId: string;
  channelName: string;
  isDirect: boolean;
  ts: string;
  /** The thread it replied in. */
  threadTs?: string;
  text: string;
}

export function fetchThreads(fresh = false): Promise<{
  threads: ThreadSummary[];
}> {
  return request(`/slack/threads${fresh ? "?fresh=1" : ""}`, {
    label: "Couldn't load your threads",
  });
}

export function fetchSent(): Promise<{ messages: SentMessage[] }> {
  return request("/slack/sent", { label: "Couldn't load sent messages" });
}

/** A message file's preview as an <img> source. */
export function fileSrc(thumb: string): string {
  return `${BASE_PATH}${thumb}`;
}

/** A message Search found, with the conversation it is in. */
export interface SearchResult {
  channelId: string;
  channelName: string;
  isDirect: boolean;
  /** The thread it replied in. */
  threadTs?: string;
  message: ChannelMessage;
}

export interface SearchResultsPage {
  results: SearchResult[];
  total: number;
  page: number;
  pages: number;
}

export function searchMessages(
  query: string,
  opts: { page?: number; sort?: "score" | "timestamp" } = {},
): Promise<SearchResultsPage> {
  const params = new URLSearchParams({ q: query });
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  if (opts.sort === "timestamp") params.set("sort", "timestamp");
  return request(`/slack/search?${params}`, { label: "Couldn't search Slack" });
}
