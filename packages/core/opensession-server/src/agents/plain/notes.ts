/**
 * Note length limits for Plain.
 *
 * Plain caps an internal note at 10,000 characters, for the text body and the
 * markdown body alike, and it rejects the whole `createNote` mutation past
 * that rather than truncating. So a long note is not a cosmetic problem: the
 * agent's investigation is simply never posted, and the only trace is an error
 * line in the server log. Everything that writes a note goes through
 * `postNote` in api.ts, which splits an over-long body here instead.
 */

/** Plain's per-note limit, for both the text and the markdown body. */
export const PLAIN_NOTE_MAX_CHARS = 10_000;

/** Room reserved in each part for the "(2/3)" marker and a re-opened fence. */
const PART_OVERHEAD = 32;

/** True when this part ends inside an unclosed fenced code block. */
function endsInsideFence(part: string): boolean {
  let open = false;
  for (const line of part.split("\n")) {
    if (line.startsWith("```")) open = !open;
  }
  return open;
}

/**
 * Split a note body into parts Plain will accept, cutting at the nicest
 * boundary available (blank line, then line, then word, then a hard cut) and
 * numbering the parts so a reader knows one note continues into the next.
 *
 * A body that already fits is returned unchanged and unnumbered.
 */
export function splitNoteText(
  text: string,
  max: number = PLAIN_NOTE_MAX_CHARS,
): string[] {
  if (text.length <= max) return [text];

  const budget = Math.max(1, max - PART_OVERHEAD);
  const parts: string[] = [];
  let rest = text;

  while (rest.length > budget) {
    let cut = 0;
    for (const sep of ["\n\n", "\n", " "]) {
      const at = rest.lastIndexOf(sep, budget);
      // Only honour a boundary that still fills most of the part, so one
      // early newline in a wall of text cannot produce 40 tiny notes.
      if (at > budget / 2) {
        cut = at + sep.length;
        break;
      }
    }
    if (!cut) cut = budget;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) parts.push(rest);

  // Close and re-open a code fence the cut landed inside, so each part still
  // renders as its own valid markdown.
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? "";
    if (endsInsideFence(part)) {
      parts[i] = `${part}\n\`\`\``;
      parts[i + 1] = `\`\`\`\n${parts[i + 1] ?? ""}`;
    }
  }

  return parts.map((part, i) => `${part}\n\n(${i + 1}/${parts.length})`);
}
