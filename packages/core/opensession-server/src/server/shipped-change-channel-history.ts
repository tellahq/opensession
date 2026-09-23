/**
 * Where merged-change updates from each repository were posted, so the
 * "Send to Slack" card can suggest the channel a team actually uses for that
 * repository instead of always starting on the configured default.
 *
 * One small JSON file, read once and written asynchronously after a share.
 */
import { readFile } from "node:fs/promises";
import { stateDir } from "./paths";
import { writeJsonAtomicAsync } from "./shared/atomic-write";

export interface ChannelUse {
  channelId: string;
  channelName: string;
  at: string;
  /** The start of the message that was sent, so later picks can match the
   *  kind of change to where the team posted it. */
  summary?: string;
}

/** Longest message excerpt kept per share. */
const SUMMARY_CHARS = 160;

type History = Record<string, ChannelUse[]>;

/** Recent shares kept per repository. */
const PER_REPO = 20;

const g = globalThis as unknown as {
  __shippedChangeChannelHistory?: {
    loaded?: Promise<History>;
    writes: Promise<void>;
  };
};
const state = (g.__shippedChangeChannelHistory ??= {
  writes: Promise.resolve(),
});

function historyPath(): string {
  return `${stateDir("github")}/shipped-change-channels.json`;
}

function load(): Promise<History> {
  return (state.loaded ??= readFile(historyPath(), "utf8")
    .then((text) => {
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as History)
        : {};
    })
    .catch(() => ({})));
}

/** The most recent shares from any repository, newest first: how this team
 *  routes different kinds of change. */
export async function recentChannelUses(
  limit = 8,
): Promise<Array<ChannelUse & { repo: string }>> {
  const history = await load();
  return Object.entries(history)
    .flatMap(([repo, uses]) => uses.map((use) => ({ ...use, repo })))
    .filter((use) => use.summary)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Channels this repository's updates went to, most used first. */
export async function channelsUsedForRepo(
  repo: string,
): Promise<Array<{ id: string; name: string; count: number }>> {
  const uses = (await load())[repo] || [];
  const counts = new Map<string, { id: string; name: string; count: number }>();
  for (const use of uses) {
    const entry = counts.get(use.channelId) || {
      id: use.channelId,
      name: use.channelName,
      count: 0,
    };
    entry.count++;
    entry.name = use.channelName;
    counts.set(use.channelId, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export async function recordChannelUse(
  repo: string,
  use: ChannelUse,
): Promise<void> {
  const history = await load();
  const summary = use.summary
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_CHARS);
  history[repo] = [
    ...(history[repo] || []),
    { ...use, ...(summary ? { summary } : {}) },
  ].slice(-PER_REPO);
  state.writes = state.writes
    .then(() => writeJsonAtomicAsync(historyPath(), history))
    .catch((error) =>
      console.warn("[shipped-change] channel history write failed:", error),
    );
  await state.writes;
}

/** Test hook: start from an in-memory history, never touching disk. */
export function setChannelHistoryForTests(history: History): void {
  state.loaded = Promise.resolve(history);
}
