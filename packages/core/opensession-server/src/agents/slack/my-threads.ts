/**
 * The Channels place's Threads and Sent views. Slack's own Threads list and
 * its Drafts & sent page sit behind APIs only its client may call, so both
 * are rebuilt from what a user token can read: `search.messages` for the
 * person's own recent messages (Sent), and the threads those messages belong
 * to, read with `conversations.replies` (Threads).
 *
 * Both are cached per person for a minute and coalesced, and a refresh reads
 * at most a bounded number of threads, so a poll costs a handful of calls.
 */
import { slackApiGet } from "./slack-api";
import { slackSelfId } from "./conversations";

const TTL_MS = 60 * 1000;
/** Threads read per refresh: replies is a tier 3 method (50 a minute). */
const MAX_THREADS = 15;
/** Top-level messages of yours checked for replies once threads run out. */
const MAX_OWN_PARENTS = 5;
const REPLY_PREVIEW = 2;

export interface SearchedMessage {
  channelId: string;
  /** Slack's channel name: a user id for a direct message. */
  channelName: string;
  isDirect: boolean;
  ts: string;
  /** The thread it is a reply in, when it is one. */
  threadTs?: string;
  /** Raw Slack markup. */
  text: string;
  permalink?: string;
}

/** The thread a search match replied in, read off its permalink. */
export function threadTsOf(permalink: unknown): string | undefined {
  if (typeof permalink !== "string") return undefined;
  const match = /[?&]thread_ts=(\d+\.\d+)/.exec(permalink);
  return match?.[1];
}

export function searchedMessage(match: any): SearchedMessage | null {
  const channelId = match?.channel?.id;
  if (typeof channelId !== "string" || typeof match?.ts !== "string")
    return null;
  const threadTs = threadTsOf(match.permalink);
  return {
    channelId,
    channelName: String(match.channel?.name || channelId),
    isDirect: !!(match.channel?.is_im || match.channel?.is_mpim),
    ts: match.ts,
    ...(threadTs && threadTs !== match.ts ? { threadTs } : {}),
    text: String(match.text || ""),
    ...(typeof match.permalink === "string"
      ? { permalink: match.permalink }
      : {}),
  };
}

/**
 * The threads to read, newest activity of yours first: every thread you
 * replied in, then a few of your own top-level messages, which may have
 * drawn replies. One entry per thread.
 */
export function threadCandidates(
  sent: readonly SearchedMessage[],
): ThreadCandidate[] {
  const seen = new Set<string>();
  const replies: ThreadCandidate[] = [];
  const parents: ThreadCandidate[] = [];
  for (const message of sent) {
    const ts = message.threadTs ?? message.ts;
    const key = `${message.channelId}:${ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: ThreadCandidate = {
      channelId: message.channelId,
      ts,
      channelName: message.channelName,
      isDirect: message.isDirect,
    };
    if (message.threadTs) replies.push(entry);
    else parents.push(entry);
  }
  return [
    ...replies.slice(0, MAX_THREADS),
    ...parents.slice(0, MAX_OWN_PARENTS),
  ].slice(0, MAX_THREADS);
}

export interface ThreadCandidate {
  channelId: string;
  ts: string;
  channelName: string;
  isDirect: boolean;
}

export interface RawThread {
  channelId: string;
  channelName: string;
  isDirect: boolean;
  parent: any;
  /** The latest replies, oldest first. */
  latest: any[];
  replyCount: number;
  latestReply: string;
}

interface Entry {
  token: string;
  at: number;
  sent: SearchedMessage[];
  threads: RawThread[];
  pending?: Promise<void>;
}

const g = globalThis as { __slackMyThreads?: Map<string, Entry> };
const cache: Map<string, Entry> = (g.__slackMyThreads ??= new Map());

async function searchSent(
  caller: string,
  token: string,
): Promise<SearchedMessage[]> {
  const self = await slackSelfId(caller, token);
  if (!self) throw new Error("Slack did not say who you are");
  const data = await slackApiGet(
    "search.messages",
    {
      query: `from:<@${self}>`,
      sort: "timestamp",
      sort_dir: "desc",
      count: 100,
    },
    token,
  );
  if (!data?.ok) throw new Error(data?.error || "search failed");
  return (data.messages?.matches || [])
    .map(searchedMessage)
    .filter((m: SearchedMessage | null): m is SearchedMessage => !!m);
}

async function readThread(
  candidate: ThreadCandidate,
  token: string,
): Promise<RawThread | null> {
  const data = await slackApiGet(
    "conversations.replies",
    { channel: candidate.channelId, ts: candidate.ts, limit: 200 },
    token,
  ).catch(() => null);
  const messages: any[] = data?.ok ? data.messages || [] : [];
  const parent = messages[0];
  if (!parent || parent.ts !== candidate.ts) return null;
  const replies = messages.slice(1);
  if (!replies.length) return null;
  return {
    channelId: candidate.channelId,
    channelName: candidate.channelName,
    isDirect: candidate.isDirect,
    parent,
    latest: replies.slice(-REPLY_PREVIEW),
    replyCount: parent.reply_count || replies.length,
    latestReply: parent.latest_reply || replies.at(-1)?.ts || parent.ts,
  };
}

async function refresh(entry: Entry, caller: string): Promise<void> {
  const sent = await searchSent(caller, entry.token);
  const candidates = threadCandidates(sent);
  const threads: RawThread[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const thread = await readThread(candidates[next++]!, entry.token);
      if (thread) threads.push(thread);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(5, candidates.length) }, worker),
  );
  threads.sort((a, b) => Number(b.latestReply) - Number(a.latestReply));
  entry.sent = sent;
  entry.threads = threads;
  entry.at = Date.now();
}

/** The person's sent messages and the threads they are in, cached. */
export async function myThreadsAndSent(
  caller: string,
  token: string,
  opts: { fresh?: boolean } = {},
): Promise<{ sent: SearchedMessage[]; threads: RawThread[] }> {
  let entry = cache.get(caller);
  if (!entry || entry.token !== token) {
    entry = { token, at: 0, sent: [], threads: [] };
    cache.set(caller, entry);
  }
  const current = entry;
  const stale = opts.fresh || Date.now() - current.at > TTL_MS;
  if (stale && !current.pending)
    current.pending = refresh(current, caller).finally(() => {
      current.pending = undefined;
    });
  if (current.pending) await current.pending;
  return { sent: current.sent, threads: current.threads };
}
