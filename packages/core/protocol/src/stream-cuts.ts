/**
 * Where mid-write markdown can safely be cut.
 *
 * A model writes markdown, and markdown mid-write does not render as itself:
 * a paragraph stops mid-word, a code fence has no closing fence, a backtick
 * has no partner. Two consumers share that problem and this module answers
 * both:
 *
 * - `safeFlushLength` decides what a sender may SHIP: block-level boundaries
 *   (a completed line, a finished sentence), so a viewer only ever holds text
 *   that renders as itself. The server's pi runner cuts its stream
 *   frames with it.
 * - `advanceReveal` decides what a viewer may SHOW of what it holds: the same
 *   safety rule at word granularity, so a bubble can type a shipped block out
 *   a few words per frame instead of pasting a sentence per network frame.
 */

/** A fence opener/closer, indented up to three spaces like CommonMark allows. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The end of the last sentence in `line`, or 0 when it holds none. A sentence
 * ends at `.`, `!`, `?` or `:` followed by a space — the cut lands after the
 * space, so the next frame starts a word rather than continuing one.
 */
function lastSentenceEnd(line: string): number {
  for (let i = line.length - 1; i >= 1; i--) {
    if (line[i] !== " ") continue;
    const punctuation = line[i - 1];
    if (
      punctuation !== "." &&
      punctuation !== "!" &&
      punctuation !== "?" &&
      punctuation !== ":"
    ) {
      continue;
    }
    // "e.g. " and friends are not the end of anything worth cutting at.
    if (punctuation === "." && /\b[a-z]$/i.test(line.slice(0, i - 1))) continue;
    return i + 1;
  }
  return 0;
}

/**
 * Whether the inline markdown in `text` is closed: every code span, link and
 * bold run finished. An open one is exactly what makes a half-written reply
 * render wrong — a lone backtick shows as a backtick, `[` swallows the words
 * after it — so text with one open is held back rather than sent.
 *
 * Underscores are not counted: `snake_case` is not emphasis in CommonMark,
 * and treating it as an open run would hold most code-flavoured prose back to
 * its paragraph end.
 */
function inlineClosed(text: string): boolean {
  const body = text.replace(/\\./g, "");
  const backticks = body.match(/`+/g);
  if (backticks && backticks.length % 2 !== 0) return false;
  let brackets = 0;
  for (const ch of body) {
    if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    if (brackets < 0) brackets = 0;
  }
  if (brackets > 0) return false;
  // An inline link's destination, opened and not yet closed.
  const lastOpen = body.lastIndexOf("](");
  if (lastOpen !== -1 && body.indexOf(")", lastOpen) === -1) return false;
  const bold = body.match(/\*\*/g);
  if (bold && bold.length % 2 !== 0) return false;
  const stars = body
    .replace(/\*\*/g, "")
    .replace(/^ {0,3}\* /gm, "")
    .match(/\*/g);
  if (stars && stars.length % 2 !== 0) return false;
  return true;
}

/**
 * How much of a block being written can be shipped now.
 *
 * A frame is cut at a boundary where what has been sent stands on its own:
 * the end of a completed line (or of a code line inside a fence), or the end
 * of a sentence when the paragraph's inline constructs are all closed. Text
 * after the last such boundary is held until the next delta, and a block's
 * completion flushes whatever is left.
 */
export function safeFlushLength(text: string): number {
  let cut = 0;
  let inFence = false;
  let fence = "";
  let paragraphStart = 0;
  let i = 0;
  while (i < text.length) {
    const newline = text.indexOf("\n", i);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(i, end);
    if (newline === -1) {
      // The trailing partial line: a sentence inside it is still a boundary.
      if (!inFence) {
        const sentence = lastSentenceEnd(line);
        if (
          sentence > 0 &&
          inlineClosed(text.slice(paragraphStart, i + sentence))
        ) {
          cut = Math.max(cut, i + sentence);
        }
      }
      break;
    }
    const fenceMark = line.match(FENCE_LINE);
    if (inFence) {
      // Inside a fence every complete line is safe, and the closing fence
      // ends the block.
      if (fenceMark && line.trimStart().startsWith(fence)) {
        inFence = false;
        paragraphStart = end;
      }
      cut = end;
    } else if (fenceMark) {
      // Hold the opening fence: on its own it renders as an empty code block.
      inFence = true;
      fence = fenceMark[1];
    } else if (line.trim() === "") {
      cut = end;
      paragraphStart = end;
    } else if (inlineClosed(text.slice(paragraphStart, end))) {
      cut = end;
    }
    i = end;
  }
  return cut;
}

/**
 * The next reveal boundary for a viewer typing held text out.
 *
 * Returns the new shown length: the furthest cut no more than `budget`
 * characters past `from` where the prefix still renders as itself — or the
 * nearest safe cut beyond the budget when a construct refuses to be cut
 * inside (an open code span, a fence opener, a long unbroken word).
 * `text.length` is the fallback and always safe: what a viewer holds ends on
 * a boundary the sender already vetted with `safeFlushLength`.
 *
 * Cuts are word-level: after a space whose paragraph prefix closes its inline
 * constructs, or at a completed line end. Inside a fence only whole code
 * lines qualify (a cut inside one shows a half-typed statement), and a fence
 * opener is revealed together with its first code line so an empty code block
 * never flashes. A space cut also needs a word on the line already — "## "
 * alone renders as an empty heading.
 */
export function advanceReveal(
  text: string,
  from: number,
  budget: number,
): number {
  if (from >= text.length) return text.length;
  const desired = Math.min(from + Math.max(1, budget), text.length);
  if (desired >= text.length) return text.length;

  let best = -1; // furthest safe cut in (from, desired]
  let inFence = false;
  let fence = "";
  let paragraphStart = 0;
  let i = 0;
  while (i < text.length) {
    const newline = text.indexOf("\n", i);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(i, end);
    const fenceMark = line.match(FENCE_LINE);
    const opensFence = !inFence && fenceMark !== null;

    if (end > from && !opensFence) {
      if (!inFence) {
        // Word cuts: after a space, before the next word.
        for (let j = Math.max(i + 1, from + 1); j < end; j++) {
          if (text[j - 1] !== " " || text[j] === " ") continue;
          if (j > desired && best !== -1) return best;
          if (!/[\p{L}\p{N}]/u.test(text.slice(i, j))) continue;
          if (!inlineClosed(text.slice(paragraphStart, j))) continue;
          if (j <= desired) best = j;
          else return j;
        }
      }
      // The line's own end — for the trailing partial line that is
      // text.length, the fallback, not a boundary of its own.
      if (newline !== -1 && end > from) {
        const safe = inFence || inlineClosed(text.slice(paragraphStart, end));
        if (safe) {
          if (end <= desired) best = end;
          else return best !== -1 ? best : end;
        }
      }
    }

    if (inFence) {
      if (fenceMark && line.trimStart().startsWith(fence)) {
        inFence = false;
        paragraphStart = end;
      }
    } else if (opensFence) {
      inFence = true;
      fence = fenceMark![1];
    } else if (line.trim() === "") {
      paragraphStart = end;
    }
    i = end;
  }
  return best !== -1 ? best : text.length;
}
