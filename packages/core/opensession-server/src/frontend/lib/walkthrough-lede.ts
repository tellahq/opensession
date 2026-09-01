/**
 * The line a FOLDED walkthrough says above its pictures: the first paragraph of
 * the writeup, as plain text.
 *
 * The publish contract asks for a writeup whose first paragraph says what
 * changed and why it matters, so that paragraph is the whole point of the card
 * and the one thing worth reading without opening it. Folded, the card used to
 * show a strip of screenshots with nothing to say what they were of.
 *
 * Markdown is reduced to text rather than rendered: the lede is clamped to a
 * few lines inside a card that is itself a fold, where a heading, a list or an
 * image would break the line box it is clamped to. Headings and code fences at
 * the top of a writeup are skipped for a second reason: "What changed" is not a
 * lede. The native card derives the same line (`SessionWalkthrough.lede`).
 */
export function walkthroughLede(summary: string | undefined): string {
  for (const block of (summary || "").split(/\n[ \t]*\n/)) {
    if (/^\s{0,3}(#{1,6}\s|```|~~~)/.test(block)) continue;
    const text = ledeText(block);
    if (text) return text;
  }
  return "";
}

/** One paragraph, flattened: its lines joined, its markup taken off. */
function ledeText(block: string): string {
  return (
    block
      .split("\n")
      .map((line) =>
        // A quote, a bullet or a number is punctuation of the block, not of
        // the sentence: the words after it are what the paragraph says.
        line.replace(/^\s{0,3}(>\s?|[-*+]\s+|\d+[.)]\s+)/, "").trim(),
      )
      .join(" ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      // Single-marker emphasis only where a marker actually opens and closes a
      // run, so an identifier like some_field_name keeps its underscores.
      .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}
