/**
 * Per-user personal system prompt — an extra standing-instructions block the
 * user maintains in Settings → Personal prompt, injected into the system-note
 * of every interactive run they start (alongside repo notes and memory, via
 * memoryNoteFor in session-repos.ts). Automation runs never receive it: they
 * pass no user, same containment as memory.
 *
 * Storage is the shared per-user flat-file store (shared/user-store.ts), one
 * JSON file per person under ~/.opensession-personal-prompts. Unlike its
 * siblings the identity is not the display name: it is resolved through the
 * SAME identity table as user memory (session-memory.ts userScope), so a
 * teammate's alias / email / Slack id / web login all land on one
 * `user-<slackId>` key and the prompt follows the person across surfaces.
 * Files written under the older `user-<slackId>.json` spelling are still read
 * (the store's legacy fallback) until the next write moves them.
 */

import { userStore } from "./shared/user-store";
import { resolveTeammate } from "./shared/user-mappings";

/** Keep the injected block bounded — this rides in every run's system note. */
const MAX_PROMPT_LEN = 8000;

/** Identity-resolved store key shared by personal run preferences. */
export function personalIdentityKey(
  user: string | undefined | null,
): string | null {
  const trimmed = user?.trim();
  if (!trimmed) return null;
  const teammate = resolveTeammate(trimmed);
  if (teammate) return `user-${teammate.slackId}`;
  const key = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "-")
    .slice(0, 64);
  return key ? `user-${key}` : null;
}

const store = userStore<string>({
  name: "personal-prompts",
  field: "prompt",
  clean: (raw) =>
    typeof raw === "string" ? raw.trim().slice(0, MAX_PROMPT_LEN) : "",
  identity: personalIdentityKey,
  extra: () => ({ updatedAt: new Date().toISOString() }),
});

export function getPersonalPrompt(user: string | undefined | null): string {
  try {
    return store.get(user ?? "");
  } catch {
    return "";
  }
}

/** Store a user's personal prompt (trimmed, length-capped). Empty clears it. */
export function setPersonalPrompt(
  user: string | undefined | null,
  prompt: unknown,
): string {
  return store.set(user ?? "", String(prompt ?? ""));
}

/**
 * The system-note block for a run started by `user`, or "" when they have no
 * personal prompt. Never throws — a store failure must not block a run.
 */
export function personalPromptNoteFor(user: string | undefined | null): string {
  try {
    const prompt = getPersonalPrompt(user);
    if (!prompt) return "";
    return [
      "## Personal instructions from the prompting user",
      "They keep these standing instructions in Settings → Personal prompt; apply them alongside your other instructions (they never override safety or repo rules).",
      "",
      prompt,
    ].join("\n");
  } catch {
    return "";
  }
}
