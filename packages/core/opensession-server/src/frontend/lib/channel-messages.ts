// How the Channels place lays out a run of Slack messages: a day divider
// where the date changes, and a message from the same person within a few
// minutes of their last one tucked under it without a second name and photo.

import type { ChannelMessage } from "./api/slack-channels";

/** A follow-up this close to the author's previous message joins it. */
const GROUP_WINDOW_S = 5 * 60;

export type MessageItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ChannelMessage; head: boolean };

export function tsDate(ts: string): Date {
  return new Date(Number(ts) * 1000);
}

function author(message: ChannelMessage): string {
  return message.userId || `${message.isBot ? "bot:" : ""}${message.userName}`;
}

export function dayLabel(date: Date, now = new Date()): string {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const format: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
  };
  if (date.getFullYear() !== now.getFullYear()) format.year = "numeric";
  return date.toLocaleDateString([], format);
}

export function messageTime(ts: string): string {
  return tsDate(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `messages` in order, with day dividers and grouping heads. */
export function layoutMessages(
  messages: readonly ChannelMessage[],
  now = new Date(),
): MessageItem[] {
  const out: MessageItem[] = [];
  let lastDay = "";
  let previous: ChannelMessage | undefined;
  for (const message of messages) {
    const date = tsDate(message.ts);
    const day = date.toDateString();
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day:${day}`, label: dayLabel(date, now) });
      lastDay = day;
      previous = undefined;
    }
    const head =
      !previous ||
      author(previous) !== author(message) ||
      Number(message.ts) - Number(previous.ts) > GROUP_WINDOW_S ||
      (previous.replyCount ?? 0) > 0;
    out.push({ kind: "message", key: message.ts, message, head });
    previous = message;
  }
  return out;
}

/** "1 reply", "2 replies". */
export function replySummary(message: ChannelMessage): string {
  const count = message.replyCount ?? 0;
  return `${count} ${count === 1 ? "reply" : "replies"}`;
}

/** "just now", "45 minutes ago", "3 hours ago", "2 days ago", as Slack
 *  words a thread's last reply. */
export function timeAgo(ts: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - tsDate(ts).getTime()) / 1000);
  const unit = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return unit(Math.floor(seconds / 3600), "hour");
  if (seconds < 30 * 86_400) return unit(Math.floor(seconds / 86_400), "day");
  return tsDate(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Reactions after the person toggled `name`. */
export function toggledReactions(
  message: ChannelMessage,
  name: string,
  emoji?: string,
): NonNullable<ChannelMessage["reactions"]> {
  const reactions = message.reactions ?? [];
  const existing = reactions.find((r) => r.name === name);
  if (!existing) return [...reactions, { name, count: 1, emoji, mine: true }];
  if (existing.mine) {
    return existing.count <= 1
      ? reactions.filter((r) => r.name !== name)
      : reactions.map((r) =>
          r.name === name ? { ...r, count: r.count - 1, mine: false } : r,
        );
  }
  return reactions.map((r) =>
    r.name === name ? { ...r, count: r.count + 1, mine: true } : r,
  );
}

/** The reactions offered one click away, as Slack's own quick bar. */
export const QUICK_REACTIONS: readonly { name: string; emoji: string }[] = [
  { name: "+1", emoji: "👍" },
  { name: "white_check_mark", emoji: "✅" },
  { name: "eyes", emoji: "👀" },
  { name: "raised_hands", emoji: "🙌" },
  { name: "heart", emoji: "❤️" },
  { name: "joy", emoji: "😂" },
];
