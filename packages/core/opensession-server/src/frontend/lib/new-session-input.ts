import type { NewSessionCreateDraft } from "./new-session-state";

/** Attachments alone still start a turn; a truly empty create only prepares the chat. */
export function hasNewSessionOpeningInput(
  draft: Pick<
    NewSessionCreateDraft,
    "prompt" | "images" | "files" | "pastedTexts"
  >,
): boolean {
  return !!(
    draft.prompt.trim() ||
    draft.images?.length ||
    draft.files?.length ||
    draft.pastedTexts?.length
  );
}
