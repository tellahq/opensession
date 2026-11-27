/**
 * The conversations a person sees in their own Slack sidebar: the channels
 * they are in, their direct messages and their group messages, each with
 * whether something new waits there. Backs the Channels place, which shows a
 * person's Slack inside Open Session with their own grant.
 *
 * Slack gives a user token no unread counts in one call, so the state of each
 * conversation is read with `conversations.info` (the read cursor, and for a
 * direct message the latest message and an unread count) plus, for a channel
 * whose info carries no latest message, one `conversations.history` call.
 * Those reads are cached per person and refreshed a bounded number at a time,
 * stalest first, so a poll costs a handful of Slack calls however many
 * conversations someone has.
 */
import { resolveSlackUser, slackApiGet } from "./slack-api";

export type SlackConversationKind = "channel" | "private" | "dm" | "group";

export interface SlackConversation {
  id: string;
  /** Channel name without `#`, or the other person's (people's) names. */
  name: string;
  kind: SlackConversationKind;
  /** A direct message: the other person. */
  userId?: string;
  avatarUrl?: string;
  /** Something newer than the person's read cursor. Absent until known. */
  unread?: boolean;
  /** A direct or group message: how many unread messages. */
  unreadCount?: number;
  /** The newest message's ts, when known. */
  latestTs?: string;
}

export interface SlackConversationsPayload {
  conversations: SlackConversation[];
  /** False when the grant predates the direct-message scopes. */
  directMessages: boolean;
}

interface ConversationState {
  at: number;
  lastRead?: string;
  latestTs?: string;
  unreadCount?: number;
  isOpen?: boolean;
}

interface Directory {
  token: string;
  at: number;
  conversations: SlackConversation[];
  directMessages: boolean;
  states: Map<string, ConversationState>;
  pending?: Promise<void>;
}

const LIST_TTL_MS = 5 * 60 * 1000;
const STATE_TTL_MS = 90 * 1000;
/** Slack calls one request may spend refreshing state. */
const REFRESH_BUDGET = 30;
const REFRESH_CONCURRENCY = 5;
const MAX_PAGES = 5;
/** A direct message Slack no longer shows open still lists for this long
 *  after its last message. */
const RECENT_DM_MS = 14 * 24 * 60 * 60 * 1000;

const g = globalThis as {
  __slackConversationDirectory?: Map<string, Directory>;
};
const directories: Map<string, Directory> = (g.__slackConversationDirectory ??=
  new Map());

/** `mpdm-ada--grace--kent-1` → `ada, grace, kent`. */
export function groupMessageName(raw: string): string {
  const inner = raw.replace(/^mpdm-/, "").replace(/-\d+$/, "");
  const names = inner.split("--").filter(Boolean);
  return names.length ? names.join(", ") : raw;
}

export function conversationKind(channel: {
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_group?: boolean;
}): SlackConversationKind {
  if (channel.is_im) return "dm";
  if (channel.is_mpim) return "group";
  if (channel.is_private || channel.is_group) return "private";
  return "channel";
}

function tsNumber(ts: string | undefined): number {
  return ts ? Number(ts) || 0 : 0;
}

/** Whether `state` says something waits past the read cursor. */
export function isUnread(
  kind: SlackConversationKind,
  state: ConversationState | undefined,
): boolean | undefined {
  if (!state) return undefined;
  if ((kind === "dm" || kind === "group") && state.unreadCount !== undefined)
    return state.unreadCount > 0;
  if (!state.latestTs) return false;
  if (!state.lastRead) return false;
  return tsNumber(state.latestTs) > tsNumber(state.lastRead);
}

/**
 * What the sidebar lists: channels alphabetically; direct and group messages
 * Slack keeps open or that had a message in the last two weeks, newest first.
 */
export function visibleConversations(
  conversations: SlackConversation[],
  states: Map<string, ConversationState>,
  now = Date.now(),
): SlackConversation[] {
  const out: SlackConversation[] = [];
  for (const conversation of conversations) {
    const state = states.get(conversation.id);
    const row: SlackConversation = {
      ...conversation,
      ...(state?.latestTs ? { latestTs: state.latestTs } : {}),
    };
    const unread = isUnread(conversation.kind, state);
    if (unread !== undefined) row.unread = unread;
    if (
      (conversation.kind === "dm" || conversation.kind === "group") &&
      state?.unreadCount
    )
      row.unreadCount = state.unreadCount;
    if (conversation.kind === "dm" || conversation.kind === "group") {
      if (!state) continue;
      const recent = now - tsNumber(state.latestTs) * 1000 < RECENT_DM_MS;
      if (!state.isOpen && !recent && !row.unread) continue;
    }
    out.push(row);
  }
  return out.sort((a, b) => {
    const aDm = a.kind === "dm" || a.kind === "group";
    const bDm = b.kind === "dm" || b.kind === "group";
    if (aDm !== bDm) return aDm ? 1 : -1;
    if (aDm) return tsNumber(b.latestTs) - tsNumber(a.latestTs);
    return a.name.localeCompare(b.name);
  });
}

async function pageConversations(
  types: string,
  token: string,
): Promise<{ channels: any[]; error?: string }> {
  const channels: any[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await slackApiGet(
      "users.conversations",
      {
        types,
        exclude_archived: true,
        limit: 1000,
        cursor: cursor || undefined,
      },
      token,
    );
    if (!data?.ok) {
      if (page === 0) return { channels, error: data?.error || "failed" };
      break;
    }
    channels.push(...(data.channels || []));
    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }
  return { channels };
}

async function listConversations(
  token: string,
): Promise<{ conversations: SlackConversation[]; directMessages: boolean }> {
  let directMessages = true;
  let listed = await pageConversations(
    "public_channel,private_channel,mpim,im",
    token,
  );
  if (listed.error === "missing_scope") {
    // A grant from before Channels asked for im/mpim: channels still work.
    directMessages = false;
    listed = await pageConversations("public_channel,private_channel", token);
  }
  if (listed.error) throw new Error(listed.error);
  const conversations: SlackConversation[] = [];
  for (const channel of listed.channels) {
    if (typeof channel?.id !== "string") continue;
    const kind = conversationKind(channel);
    if (kind === "dm") {
      if (typeof channel.user !== "string" || channel.user === "USLACKBOT")
        continue;
      const user = await resolveSlackUser(channel.user).catch(() => ({
        name: channel.user as string,
        avatarUrl: undefined,
      }));
      conversations.push({
        id: channel.id,
        name: user.name,
        kind,
        userId: channel.user,
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      });
      continue;
    }
    if (typeof channel.name !== "string" || !channel.name) continue;
    conversations.push({
      id: channel.id,
      name: kind === "group" ? groupMessageName(channel.name) : channel.name,
      kind,
    });
  }
  return { conversations, directMessages };
}

async function readState(
  conversation: SlackConversation,
  token: string,
): Promise<ConversationState | undefined> {
  const info = await slackApiGet(
    "conversations.info",
    { channel: conversation.id },
    token,
  ).catch(() => null);
  if (!info?.ok) return undefined;
  const channel = info.channel || {};
  const state: ConversationState = {
    at: Date.now(),
    ...(typeof channel.last_read === "string"
      ? { lastRead: channel.last_read }
      : {}),
    ...(typeof channel.latest?.ts === "string"
      ? { latestTs: channel.latest.ts }
      : {}),
    ...(typeof channel.unread_count_display === "number"
      ? { unreadCount: channel.unread_count_display }
      : {}),
    ...(typeof channel.is_open === "boolean"
      ? { isOpen: channel.is_open }
      : {}),
  };
  if (!state.latestTs && conversation.kind !== "dm") {
    const history = await slackApiGet(
      "conversations.history",
      { channel: conversation.id, limit: 1 },
      token,
    ).catch(() => null);
    const latest = history?.ok ? history.messages?.[0]?.ts : undefined;
    if (typeof latest === "string") state.latestTs = latest;
  }
  return state;
}

async function refreshStates(directory: Directory): Promise<void> {
  const now = Date.now();
  const stale = directory.conversations
    .filter((c) => {
      const state = directory.states.get(c.id);
      return !state || now - state.at > STATE_TTL_MS;
    })
    .sort(
      (a, b) =>
        (directory.states.get(a.id)?.at ?? 0) -
        (directory.states.get(b.id)?.at ?? 0),
    )
    .slice(0, REFRESH_BUDGET);
  let next = 0;
  const worker = async () => {
    while (next < stale.length) {
      const conversation = stale[next++]!;
      const state = await readState(conversation, directory.token);
      if (state) directory.states.set(conversation.id, state);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REFRESH_CONCURRENCY, stale.length) }, worker),
  );
}

/**
 * `caller`'s conversations as their own Slack shows them. Coalesced per
 * caller, so two tabs polling at once share one round of Slack calls.
 */
export async function slackConversationsForUser(
  caller: string,
  token: string,
): Promise<SlackConversationsPayload> {
  let directory = directories.get(caller);
  if (!directory || directory.token !== token) {
    directory = {
      token,
      at: 0,
      conversations: [],
      directMessages: true,
      states: new Map(),
    };
    directories.set(caller, directory);
  }
  const current = directory;
  if (!current.pending) {
    current.pending = (async () => {
      if (Date.now() - current.at > LIST_TTL_MS) {
        const listed = await listConversations(token);
        current.conversations = listed.conversations;
        current.directMessages = listed.directMessages;
        current.at = Date.now();
      }
      await refreshStates(current);
    })().finally(() => {
      current.pending = undefined;
    });
  }
  await current.pending;
  return {
    conversations: visibleConversations(current.conversations, current.states),
    directMessages: current.directMessages,
  };
}

/** The person read `channelId` up to `ts`: clear its dot without a refetch. */
export function markConversationRead(
  caller: string,
  channelId: string,
  ts: string,
): void {
  const state = directories.get(caller)?.states.get(channelId);
  if (!state) return;
  state.lastRead = ts;
  if (state.unreadCount !== undefined) state.unreadCount = 0;
}

/** The person's own Slack user id, for telling their reactions apart. */
const selfIds = new Map<string, { token: string; id: string }>();
export async function slackSelfId(
  caller: string,
  token: string,
): Promise<string | undefined> {
  const cached = selfIds.get(caller);
  if (cached?.token === token) return cached.id;
  const auth = await slackApiGet("auth.test", {}, token).catch(() => null);
  if (!auth?.ok || typeof auth.user_id !== "string") return undefined;
  selfIds.set(caller, { token, id: auth.user_id });
  return auth.user_id;
}
