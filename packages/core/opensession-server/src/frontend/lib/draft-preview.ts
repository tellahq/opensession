import type { ComposerDraft } from "./drafts";

/** A cap for a first "sentence" that never ends, such as a pasted log. The
 *  tooltip trims to its own width well before this. */
const PREVIEW_MAX = 200;

function countLabel(count: number, one: string): string | null {
  if (count === 0) return null;
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/** What a draft holds, as the sidebar pencil's hover reads it: its first
 *  sentence on one line, and what is attached. */
export function draftPreview(d: ComposerDraft) {
  const flat = d.text.replace(/\s+/g, " ").trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  const text =
    sentence.length > PREVIEW_MAX
      ? `${sentence.slice(0, PREVIEW_MAX).trimEnd()}…`
      : sentence;
  const parts = [
    countLabel(d.images.length, "image"),
    countLabel(d.files.length + d.pastedTexts.length, "attachment"),
  ].filter((part): part is string => part !== null);
  return { text, attachments: parts.length ? parts.join(", ") : null };
}
