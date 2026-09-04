/**
 * Inline trigger detection for the composer's "@" and "/" palettes.
 *
 * Both queries may contain spaces, like Notion's slash menu: "/set goal" and
 * "@fix the login" keep filtering instead of closing on the first space. The
 * query ends at a newline. The hook that owns the popup decides when a
 * spaced query is over (no rows, Escape, or a row already inserted) so the
 * rest of the sentence does not keep searching.
 */

export interface TriggerToken {
  start: number;
  query: string;
}

function isLineBreak(ch: string | undefined): boolean {
  return ch === "\n" || ch === "\r";
}

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || isLineBreak(ch);
}

/**
 * Find the active "@"-mention at the caret: the index of the "@" and the
 * text typed after it. The "@" must start the text or follow whitespace, and
 * it must be the nearest "@" on the caret's line.
 */
export function mentionContextAt(
  value: string,
  caret: number,
): TriggerToken | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (isLineBreak(ch)) return null;
    if (ch !== "@") continue;
    if (i > 0 && !isSpace(value[i - 1])) return null;
    return { start: i, query: value.slice(i + 1, caret) };
  }
  return null;
}

/**
 * Find the active "/"-skill being typed. Only triggers when "/" is the very
 * first character of the whole input (like a CLI slash command) and the caret
 * is still on that first line, so a path like `src/foo` mid-text never opens
 * it.
 */
export function slashContextAt(
  value: string,
  caret: number,
): TriggerToken | null {
  if (value[0] !== "/" || caret < 1) return null;
  const query = value.slice(1, caret);
  if (/[\r\n]/.test(query)) return null;
  return { start: 0, query };
}

/** True once the query has run past its first word. */
export function isSpacedQuery(query: string): boolean {
  return /\s/.test(query);
}
