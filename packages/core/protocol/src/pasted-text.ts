/**
 * Pasted text as an attachment.
 *
 * A composer collapses a large paste into a chip and sends it beside the
 * message as `pastedTexts`, never inside `content`. The server folds each
 * block into the prompt the model sees, AFTER the message and inside a
 * `<pasted-text>` fence, so the instruction leads and the material it applies
 * to is delimited. That folded string is what the transcript stores, which
 * keeps search, bounding, and every existing engine path working on one
 * string. On the way to a client, `classifyEntry` lifts the blocks back out of
 * `content` onto `entry.pastedTexts`, so a reader sees the message they typed
 * and a card per paste rather than pages of log.
 *
 * Lives in the protocol package because the fold and the lift must agree, and
 * three parties run them: the server folds at intake and lifts on the way
 * out, and the web composer lifts an entry an older server did not.
 */

import type { TranscriptEntry } from "./session";

export const PASTED_TEXT_OPEN = "<pasted-text>";
export const PASTED_TEXT_CLOSE = "</pasted-text>";

/** Most a single message may carry. A chip per paste is the UI's shape; more
 *  than this is a client bug rather than a person pasting. */
export const MAX_PASTED_TEXTS = 32;

/** Validate a wire `pastedTexts` payload: strings only, blanks dropped. */
export function pastedTextsFromWire(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return out.length ? out.slice(0, MAX_PASTED_TEXTS) : undefined;
}

/** A literal close tag inside a paste would end the block early on the way
 *  back out. Bend it so the fence stays balanced; the replacement is visible
 *  and rare enough to leave as-is rather than escape and unescape. */
function neutralizeClose(text: string): string {
  return text.split(PASTED_TEXT_CLOSE).join("<\\/pasted-text>");
}

/**
 * The model-visible prompt: the message, then one fence per pasted block.
 * A lone paste with no message still gets its fence, so the lift can tell it
 * from a message someone typed.
 */
export function withPastedTexts(
  text: string,
  pastedTexts: readonly string[] | undefined,
): string {
  const blocks = (pastedTexts ?? [])
    .filter((block) => block.trim() !== "")
    .map(
      (block) =>
        `${PASTED_TEXT_OPEN}\n${neutralizeClose(block)}\n${PASTED_TEXT_CLOSE}`,
    );
  if (!blocks.length) return text;
  const head = text.trimEnd();
  return (head ? [head, ...blocks] : blocks).join("\n\n");
}

const BLOCK_RE = /\n*<pasted-text>\n?([\s\S]*?)\n?<\/pasted-text>/g;

/**
 * Take the pasted blocks back out of a folded string. Returns null when the
 * string carries none, so callers can keep the original reference.
 *
 * A block whose close tag was clamped away (the wire and the store both cut
 * long content from the tail) still lifts, truncated: the message before it
 * is complete either way, which is what lets the bubble show the message
 * unclamped and put the "show more" on the card.
 */
export function splitPastedTexts(
  content: string,
): { content: string; pastedTexts: string[] } | null {
  if (!content.includes(PASTED_TEXT_OPEN)) return null;
  const pastedTexts: string[] = [];
  let rest = content.replace(BLOCK_RE, (_match, body: string) => {
    pastedTexts.push(body);
    return "";
  });
  const openAt = rest.indexOf(PASTED_TEXT_OPEN);
  if (openAt >= 0) {
    pastedTexts.push(
      rest.slice(openAt + PASTED_TEXT_OPEN.length).replace(/^\n/, ""),
    );
    rest = rest.slice(0, openAt);
  }
  if (!pastedTexts.length) return null;
  return { content: rest.trimEnd(), pastedTexts };
}

/**
 * Move a user entry's folded blocks onto `pastedTexts`. Same reference when
 * there is nothing to lift, so it is free to run on every read.
 */
export function liftPastedTexts<T extends TranscriptEntry>(entry: T): T {
  if (entry.type !== "user") return entry;
  const split = splitPastedTexts(entry.content);
  if (!split) return entry;
  return {
    ...entry,
    content: split.content,
    pastedTexts: [...(entry.pastedTexts ?? []), ...split.pastedTexts],
  };
}

/** How a chip or card summarizes a block. */
export function pastedTextLineLabel(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).length;
  return `+${lines} ${lines === 1 ? "line" : "lines"}`;
}
