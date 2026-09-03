import { randomUUID } from "./random-uuid";

export { pastedTextLineLabel } from "@tellahq/opensession-protocol/pasted-text";

export const PASTED_TEXT_THRESHOLD = 2_500;

/**
 * Past this, a paste goes to the model as a file rather than inside the
 * prompt. A chip's text is folded into the turn verbatim, so a paste of a few
 * megabytes lands the whole thing in context and the request is refused as
 * too long before the model sees a word of it (a single exchange cannot be
 * compacted). 200k characters is roughly 50k tokens: still a quarter of the
 * smallest context in use, and past the point where reading through file
 * tools serves the model better than a wall of text.
 */
export const PASTED_TEXT_FILE_THRESHOLD = 200_000;

export const PASTED_TEXT_FILE_NAME = "pasted-text.txt";

export interface PastedTextAttachment {
  id: string;
  text: string;
}

export function shouldCollapsePastedText(text: string): boolean {
  return text.length >= PASTED_TEXT_THRESHOLD;
}

export function shouldAttachPastedTextAsFile(text: string): boolean {
  return text.length >= PASTED_TEXT_FILE_THRESHOLD;
}

/** The paste as a file the attachment path can stage and hand to the agent. */
export function pastedTextFile(text: string): File {
  return new File([text], PASTED_TEXT_FILE_NAME, { type: "text/plain" });
}

export function createPastedTextAttachment(text: string): PastedTextAttachment {
  return { id: randomUUID(), text };
}

/** Sits between the message and each pasted block. The rule renders as a
 *  divider, and the label says where the message stops and the material
 *  starts. The blank line before the rule matters: directly under a line of
 *  text, `---` would turn it into a heading. */
const PASTED_TEXT_DIVIDER = "---\n\nPasted text:";

/**
 * One string for the surfaces that take no attachments: a team note, and the
 * scheduled-message preview. A prompt never comes through here; it carries
 * the blocks as `pastedTexts` and the server folds them (protocol
 * pasted-text.ts). The message leads, each block follows behind a divider,
 * and a lone block goes out bare.
 */
export function composePastedText(
  text: string,
  pastedTexts: readonly string[],
): string {
  if (pastedTexts.length === 0) return text;
  const parts = text.length > 0 ? [text] : [];
  for (const block of pastedTexts) {
    if (block.length === 0) continue;
    parts.push(parts.length > 0 ? `${PASTED_TEXT_DIVIDER}\n\n${block}` : block);
  }
  return parts.join("\n\n");
}
