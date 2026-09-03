const COMPLETE_BOLD_HEADING = /^\s*\*\*([^*\n][^\n]*?)\*\*\s*$/;
const LEADING_BOLD_HEADING = /^\s*\*\*([^*\n][^\n]*?)\*\*(?:\r?\n+|\s*$)/;
const STRUCTURED_MARKDOWN_LINE = /^\s*(?:[-+*] |\d+[.)] |#{1,6} |>|```|~~~)/;

/**
 * Some reasoning-summary providers terminate tiny token fragments as separate
 * summary parts. Pi preserves those boundaries as blank lines, and marked's
 * hard-break mode would otherwise render a sentence one or two words per row.
 * Repair only that pathological shape. Ordinary paragraphs, wrapped prose,
 * lists, and fenced code keep their authored whitespace.
 */
export function normalizeFragmentedReasoning(content: string): string {
  const trimmed = content.trim();
  const lineBreaks = trimmed.match(/\r?\n/g)?.length ?? 0;
  if (lineBreaks < 8 || /^\s*(?:```|~~~)/m.test(trimmed)) return trimmed;

  const lines = trimmed.split(/\r?\n/);
  const nonEmptyLines = lines.filter((line) => line.trim());
  const words = trimmed.match(/\S+/g)?.length ?? 0;
  const shortLines = nonEmptyLines.filter(
    (line) => (line.match(/\S+/g)?.length ?? 0) <= 4,
  ).length;
  const structuredLines = nonEmptyLines.filter((line) =>
    STRUCTURED_MARKDOWN_LINE.test(line),
  ).length;

  const fragmented =
    words > 0 &&
    lineBreaks / words >= 0.2 &&
    shortLines / nonEmptyLines.length >= 0.7 &&
    structuredLines / nonEmptyLines.length < 0.2;
  if (!fragmented) return trimmed;

  return trimmed
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?%)\]}])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/([\p{L}\p{N}])\s+(-[\p{L}\p{N}])/gu, "$1$2")
    .replace(/\s+(['’][\p{L}])/gu, "$1");
}

/** Providers may batch several status headings into one thinking block. */
function boldOnlyHeadings(content: string): string[] | null {
  const blocks = content.trim().split(/\r?\n\s*\r?\n|\r?\n/);
  const headings: string[] = [];
  for (const block of blocks) {
    const heading = block.match(COMPLETE_BOLD_HEADING)?.[1]?.trim();
    if (!heading) return null;
    headings.push(heading);
  }
  return headings.length > 0 ? headings : null;
}

/** Older Pi transcript rows predate `isReasoning`. A single bold-only message
 * before later model output/tool work is the provider's reasoning-summary
 * heading shape, not answer prose. */
export function isLegacyReasoningHeading(content: string): boolean {
  return boldOnlyHeadings(content) !== null;
}

/** Codex Desktop treats a leading `**…**` as summary chrome, not markdown in
 * the reasoning body. Split it out so the title stays regular-weight while any
 * real summary prose keeps its markdown structure. */
export function reasoningDisplay(content: string) {
  const normalized = normalizeFragmentedReasoning(content);
  const headings = boldOnlyHeadings(normalized);
  if (headings) return { title: headings.join("\n"), body: "" };
  const match = normalized.match(LEADING_BOLD_HEADING);
  if (!match) return { title: "", body: normalized };
  return {
    title: match[1]!.trim(),
    body: normalized.slice(match[0].length).trim(),
  };
}

/** Re-run the display transform when a clamped reasoning entry hydrates. */
export function reasoningBody(content: string): string {
  return reasoningDisplay(content).body;
}

/** During a streamed heading, the closing `**` may not have arrived yet. This
 * powers the live shimmer without ever handing markdown's bold marker to the
 * renderer. Multiline content is a normal model response instead. */
export function liveReasoningHeading(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("**") || trimmed.includes("\n")) return null;
  const heading = trimmed
    .slice(2)
    .replace(/\*\*\s*$/, "")
    .trim();
  return heading || null;
}
