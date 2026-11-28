// "Open at this message": a search result asks the conversation it opens
// to scroll to one message and mark it for a moment. The request waits here
// until that message list mounts and takes it.

const pending = new Map<string, string>();

/** The key a message list answers to: a channel, or a thread in it. */
export function jumpKey(channelId: string, thread?: string): string {
  return thread ? `${channelId}:${thread}` : channelId;
}

export function requestJump(key: string, ts: string): void {
  pending.set(key, ts);
}

/** The message to open `key` at, once: taking it clears it. */
export function takeJump(key: string): string | undefined {
  const ts = pending.get(key);
  pending.delete(key);
  return ts;
}

/** Whether to load an older page to reach `ts`: it is older than every
 *  loaded message, there is more, and the budget of pages is not spent. */
export function needsOlder(
  loaded: readonly { ts: string }[],
  ts: string,
  hasMore: boolean,
  pagesLeft: number,
): boolean {
  if (!hasMore || pagesLeft <= 0 || !loaded.length) return false;
  if (loaded.some((m) => m.ts === ts)) return false;
  return Number(ts) < Number(loaded[0]!.ts);
}
