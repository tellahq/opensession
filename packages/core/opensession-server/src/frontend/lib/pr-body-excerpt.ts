/** The first readable line of a PR description: markdown marks, comments and
 *  checklists are noise in a one-line preview. */
export function prBodyExcerpt(body: string | undefined): string {
  if (!body) return "";
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+\.\s+)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .trim();
    if (line) return line;
  }
  return "";
}
