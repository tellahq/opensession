/**
 * The channels a person can post to from the Slack composer.
 *
 * `integrations.slack.channelNames` is a short, operator-curated list; it is
 * the suggestion set, not the universe. The composer posts as the signed-in
 * person with their own grant, so the channels they can actually reach are
 * whatever `users.conversations` returns for that token: every public and
 * private channel they are a member of. That list is fetched with their token,
 * cached briefly per caller, and merged after the configured channels so the
 * curated ones stay at the top of the picker.
 */
import { slackApiGet } from "./slack-api";

export interface SlackChannelOption {
  id: string;
  name: string;
}

const DIRECTORY_TTL_MS = 5 * 60 * 1000;
/** users.conversations pages at up to 1000; five pages covers any workspace
 *  a person is realistically a member of without an unbounded walk. */
const MAX_PAGES = 5;

interface DirectoryEntry {
  token: string;
  at: number;
  channels: SlackChannelOption[];
  pending?: Promise<SlackChannelOption[]>;
}

const g = globalThis as {
  __slackChannelDirectory?: Map<string, DirectoryEntry>;
};
const directory: Map<string, DirectoryEntry> = (g.__slackChannelDirectory ??=
  new Map());

export function isSlackChannelId(value: string): boolean {
  return /^[CG][A-Z0-9]{6,}$/.test(value);
}

export function normalizeSlackChannelName(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

async function fetchUserChannels(token: string): Promise<SlackChannelOption[]> {
  const channels: SlackChannelOption[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await slackApiGet(
      "users.conversations",
      {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1000,
        cursor: cursor || undefined,
      },
      token,
    );
    if (!data?.ok) {
      // A grant issued before channels:read was requested, or a revoked
      // token: the configured list still works, so this is not an error.
      if (page === 0) return [];
      break;
    }
    for (const channel of data.channels || []) {
      if (typeof channel?.id !== "string" || typeof channel?.name !== "string")
        continue;
      if (!channel.name) continue;
      channels.push({ id: channel.id, name: channel.name });
    }
    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }
  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every channel `caller` is a member of, as seen by their own grant. Cached
 * for a few minutes per caller and coalesced, so a composer that mounts twice
 * (or a send right after a load) does not page Slack twice.
 */
export function slackChannelsForUser(
  caller: string,
  token: string,
): Promise<SlackChannelOption[]> {
  const entry = directory.get(caller);
  const now = Date.now();
  if (entry && entry.token === token) {
    if (entry.pending) return entry.pending;
    if (now - entry.at < DIRECTORY_TTL_MS)
      return Promise.resolve(entry.channels);
  }
  const next: DirectoryEntry = {
    token,
    at: now,
    channels: entry?.token === token ? entry.channels : [],
  };
  next.pending = fetchUserChannels(token)
    .then((channels) => {
      next.channels = channels;
      next.at = Date.now();
      return channels;
    })
    .catch(() => next.channels)
    .finally(() => {
      next.pending = undefined;
    });
  directory.set(caller, next);
  return next.pending;
}

export function forgetSlackChannelsForUser(caller?: string): void {
  if (caller) directory.delete(caller);
  else directory.clear();
}

/**
 * Configured channels first, in their configured order, then the rest of the
 * person's channels alphabetically. An id that appears in both keeps the
 * configured name.
 */
export function mergeSlackChannels(
  configured: SlackChannelOption[],
  directoryChannels: SlackChannelOption[],
): SlackChannelOption[] {
  const seen = new Set(configured.map((channel) => channel.id));
  const merged = [...configured];
  for (const channel of directoryChannels) {
    if (seen.has(channel.id)) continue;
    seen.add(channel.id);
    merged.push(channel);
  }
  return merged;
}

export function findSlackChannel(
  channels: SlackChannelOption[],
  wanted: string,
): SlackChannelOption | undefined {
  const name = normalizeSlackChannelName(wanted);
  return channels.find(
    (channel) =>
      channel.id === wanted.trim() || channel.name.toLowerCase() === name,
  );
}

/**
 * Turn what the composer sent (an id, or a `#name`) into a channel the
 * person can post to. Configured channels resolve without a grant; anything
 * else has to be in the caller's directory, or be an id `conversations.info`
 * confirms with their token.
 */
export async function resolveSlackChannel(
  wanted: unknown,
  configured: SlackChannelOption[],
  auth?: { caller: string; token: string },
): Promise<SlackChannelOption | undefined> {
  if (typeof wanted !== "string" || !wanted.trim()) return undefined;
  const fromConfig = findSlackChannel(configured, wanted);
  if (fromConfig) return fromConfig;
  if (!auth) return undefined;
  const fromDirectory = findSlackChannel(
    await slackChannelsForUser(auth.caller, auth.token),
    wanted,
  );
  if (fromDirectory) return fromDirectory;
  const id = wanted.trim();
  if (!isSlackChannelId(id)) return undefined;
  const info = await slackApiGet(
    "conversations.info",
    { channel: id },
    auth.token,
  ).catch(() => null);
  const name = info?.ok ? info.channel?.name : undefined;
  return typeof name === "string" && name ? { id, name } : undefined;
}
