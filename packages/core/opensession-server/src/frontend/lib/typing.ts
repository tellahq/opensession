import { personKey } from "./review-queue";

/** How much of a draft rides along with the typing lease. Mirrors
 * TYPING_PREVIEW_MAX in server/ws-hub.ts, which trims it again. */
export const TYPING_PREVIEW_MAX = 500;

export interface TypingPresence {
  /** Other people who are actively composing, once per person. */
  users: string[];
  /** user → the head of their draft, when their lease carried one. */
  drafts: Record<string, string>;
}

export const NO_TYPING: TypingPresence = { users: [], drafts: {} };

/** Other people who are actively composing, once per person. */
export function otherTypingUsers(
  users: string[],
  me?: string | null,
): string[] {
  const mine = personKey(me || "");
  const seen = new Set<string>();
  return users.filter((user) => {
    const key = personKey(user);
    if (!key || key === mine || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A `typing` frame from this person's point of view. */
export function otherTyping(
  frame: { users: string[]; drafts?: Record<string, string> },
  me?: string | null,
): TypingPresence {
  const users = otherTypingUsers(frame.users, me);
  const drafts: Record<string, string> = {};
  for (const user of users) {
    const text = frame.drafts?.[user];
    if (text?.trim()) drafts[user] = text;
  }
  return { users, drafts };
}

export function typingLabel(users: string[]): string | null {
  if (users.length === 0) return null;
  if (users.length === 1) return `${users[0]} is typing…`;
  return "Several people are typing…";
}

/** One preview row per person whose draft is known, in indicator order. */
export function typingPreviews({
  users,
  drafts,
}: TypingPresence): Array<{ user: string; text: string }> {
  return users.flatMap((user) => {
    const text = drafts[user];
    return text ? [{ user, text }] : [];
  });
}
