import { personKey } from "./review-queue";

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

export function typingLabel(users: string[]): string | null {
  if (users.length === 0) return null;
  if (users.length === 1) return `${users[0]} is typing…`;
  return "Several people are typing…";
}
