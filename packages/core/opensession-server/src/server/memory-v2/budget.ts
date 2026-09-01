/** Pure UTF-8 byte budgeting shared by ambient and retrieved memory. */

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export interface BudgetedText<T> {
  items: T[];
  text: string;
  bytes: number;
  omitted: number;
}

/**
 * Render whole items without ever exceeding the byte ceiling. An item that
 * does not fit is skipped, not truncated, so a memory cannot become a
 * plausible half-fact. The header is charged only when at least one item fits.
 */
export function renderWithinByteBudget<T>(
  items: readonly T[],
  opts: {
    budgetBytes: number;
    header: string;
    limit: number;
    renderItem: (item: T) => string;
  },
): BudgetedText<T> {
  const budgetBytes = Math.max(0, Math.floor(opts.budgetBytes));
  const limit = Math.max(0, Math.floor(opts.limit));
  if (!budgetBytes || !limit || !items.length) {
    return { items: [], text: "", bytes: 0, omitted: items.length };
  }

  const selected: T[] = [];
  const lines: string[] = [];
  let text = "";
  for (const item of items) {
    if (selected.length >= limit) break;
    const line = opts.renderItem(item);
    const candidate = selected.length
      ? `${text}\n${line}`
      : `${opts.header}\n${line}`;
    if (utf8Bytes(candidate) > budgetBytes) continue;
    selected.push(item);
    lines.push(line);
    text = candidate;
  }

  return {
    items: selected,
    text: selected.length ? `${opts.header}\n${lines.join("\n")}` : "",
    bytes: selected.length
      ? utf8Bytes(`${opts.header}\n${lines.join("\n")}`)
      : 0,
    omitted: items.length - selected.length,
  };
}
