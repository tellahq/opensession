/**
 * Per-user personal system prompt — an extra standing-instructions block the
 * user maintains in Settings → Personal prompt, injected into the system-note
 * of every interactive run they start (alongside repo notes and memory, via
 * memoryNoteFor in session-repos.ts). Automation runs never receive it: they
 * pass no user, same containment as memory.
 *
 * Storage is the worker-owned application catalog. Legacy per-user JSON is
 * imported at boot and retained as an async export. The key resolves through the
 * SAME identity table as user memory (session-memory.ts userScope), so a
 * teammate's alias / email / Slack id / web login all land on one
 * `user-<slackId>` key and the prompt follows the person across surfaces.
 * Files written under the older `user-<slackId>.json` spelling are still read
 * (the store's legacy fallback) until the next write moves them.
 */

import { catalogUserStore } from "./shared/catalog-user-store";
import { resolveTeammate } from "./shared/user-mappings";

/** Keep the injected block bounded — this rides in every run's system note. */
export const MAX_PERSONAL_PROMPT_LENGTH = 8000;

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

const store = catalogUserStore<string>({
  name: "personal-prompts",
  field: "prompt",
  clean: (raw) =>
    typeof raw === "string"
      ? raw.trim().slice(0, MAX_PERSONAL_PROMPT_LENGTH)
      : "",
});

export async function getPersonalPrompt(
  user: string | undefined | null,
): Promise<string> {
  const identity = personalIdentityKey(user);
  return identity ? store.get(identity) : "";
}

/** Store a user's personal prompt (trimmed, length-capped). Empty clears it. */
export async function setPersonalPrompt(
  user: string | undefined | null,
  prompt: unknown,
): Promise<string> {
  const identity = personalIdentityKey(user);
  return identity ? store.set(identity, String(prompt ?? "")) : "";
}

/** Keep append and conditional replacement inside the catalog's CAS. */
export async function updatePersonalPrompt(
  user: string,
  mutate: (current: string) => string,
): Promise<string> {
  const identity = personalIdentityKey(user);
  if (!identity) throw new Error("Personal settings require a prompting user.");
  return store.update(identity, mutate);
}

/**
 * The system-note block for a run started by `user`, or "" when they have no
 * personal prompt. Never throws — a store failure must not block a run.
 */
export async function personalPromptNoteFor(
  user: string | undefined | null,
): Promise<string> {
  try {
    const prompt = await getPersonalPrompt(user);
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
