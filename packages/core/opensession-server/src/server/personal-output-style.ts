import { personalIdentityKey } from "./personal-prompts";
import { userStore } from "./shared/user-store";

export type PersonalOutputStyle = "default" | "concise";

const store = userStore<PersonalOutputStyle>({
  name: "personal-output-styles",
  field: "outputStyle",
  clean: (raw) => (raw === "concise" ? "concise" : "default"),
  identity: personalIdentityKey,
  extra: () => ({ updatedAt: new Date().toISOString() }),
});

export function getPersonalOutputStyle(
  user: string | undefined | null,
): PersonalOutputStyle {
  try {
    return store.get(user ?? "");
  } catch {
    return "default";
  }
}

export function setPersonalOutputStyle(
  user: string | undefined | null,
  style: unknown,
): PersonalOutputStyle {
  return store.set(user ?? "", style);
}

/** System-prompt guidance for sessions started by a person who chose Concise. */
export function personalOutputStyleNoteFor(
  user: string | undefined | null,
): string {
  try {
    if (getPersonalOutputStyle(user) !== "concise") return "";
    return [
      "## Personal output style: Concise",
      "The prompting user chose brevity over narration. Follow these rules:",
      "",
      '1. Lead with the result. Your first sentence answers "what happened" or "what is the answer." Do not add preamble or repeat the same result in a closing recap.',
      "2. Cut narration, not substance. Do not restate the request, plan, or each step you took. Report outcomes, decisions, and anything the user must act on.",
      "3. Keep simple answers to 1-3 sentences of plain prose. Use headers, tables, and bullets only when they carry real structure.",
      "4. State things plainly. Include a caveat only when it changes what the user should do next.",
      "5. Give full detail when asked. Conciseness never means withholding requested information.",
      "6. Never trade correctness for brevity. Keep error details, failing test output, security warnings, and confirmations for destructive actions complete.",
      "",
      "Where these rules conflict with general communication or formatting guidance, these rules win. Do the work just as thoroughly.",
    ].join("\n");
  } catch {
    return "";
  }
}
