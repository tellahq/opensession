// Activity's unread count: mentions newer than the last one you saw.

/** How many of `items` came after `seen` (a Slack ts), capped for a badge. */
export function unseenCount(
  items: readonly { message: { ts: string } }[],
  seen: string | null,
  cap = 99,
): number {
  const after = seen ? Number(seen) : 0;
  const count = items.filter((item) => Number(item.message.ts) > after).length;
  return Math.min(count, cap);
}

/** The newest ts in `items`, which becomes "seen" once Activity is open. */
export function newestTs(
  items: readonly { message: { ts: string } }[],
): string | undefined {
  let newest: string | undefined;
  for (const item of items)
    if (!newest || Number(item.message.ts) > Number(newest))
      newest = item.message.ts;
  return newest;
}
