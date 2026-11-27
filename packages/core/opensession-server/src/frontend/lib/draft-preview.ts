import type { ComposerDraft } from "./drafts";

/** How long a draft's text can run in its sidebar hover before it trims. */
const PREVIEW_MAX = 280;

function countLabel(count: number, one: string): string | null {
  if (count === 0) return null;
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/** What a draft holds, as the sidebar pencil's hover reads it: the text on
 *  one line, trimmed past a few lines' worth, and what is attached. */
export function draftPreview(d: ComposerDraft) {
  const flat = d.text.replace(/\s+/g, " ").trim();
  const text =
    flat.length > PREVIEW_MAX
      ? `${flat.slice(0, PREVIEW_MAX).trimEnd()}…`
      : flat;
  const parts = [
    countLabel(d.images.length, "image"),
    countLabel(d.files.length + d.pastedTexts.length, "attachment"),
  ].filter((part): part is string => part !== null);
  return { text, attachments: parts.length ? parts.join(", ") : null };
}
