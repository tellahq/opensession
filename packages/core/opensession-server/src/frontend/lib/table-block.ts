/**
 * ```csv, ```tsv and ```table fences as a data grid: sort by a column,
 * filter by substring, copy the rows on screen back out as CSV.
 *
 * The first row is the header. `csv` splits on commas, `tsv` on tabs, and
 * `table` picks the delimiter from the header line (comma, tab, semicolon or
 * pipe). Fields follow RFC 4180: a quoted field may hold the delimiter, a
 * doubled quote and line breaks. A fence with fewer than two rows, a
 * one-column header, or more ragged rows than the tolerance allows keeps
 * the plain code fence, so a half-written table still reads while it streams
 * and a file that is not really a table never renders as one.
 *
 * Everything from the fence is untrusted text: every cell, header and count
 * lands in the DOM through textContent. The only innerHTML is the icon
 * markup from components/icons.tsx.
 *
 * Parsing, numeric detection, sorting, filtering and CSV output are pure
 * functions so table-block.test.ts covers them without a DOM.
 */

import {
  arrowDownIconMarkup,
  arrowUpIconMarkup,
  checkIconMarkup,
  copyIconMarkup,
} from "../components/icons";
import type { FenceUpgrader } from "./fence-upgraders";
import { copyToClipboard } from "./share-link";

export const TABLE_LANGS = ["csv", "tsv", "table"] as const;

export type Delimiter = "," | "\t" | ";" | "|";

/** A fence with more data rows than this gets a filter input. */
export const FILTER_THRESHOLD = 8;

/**
 * How many rows the grid puts in the DOM at once. An asset preview hands
 * markdown up to 256 KiB to the renderer, which as a narrow CSV is tens of
 * thousands of rows; building every cell would freeze the page, and each
 * keystroke in the filter rebuilds the body. Sorting, filtering and Copy CSV
 * still work over the whole table; the count says what was cut.
 */
export const RENDER_CAP = 500;

export interface TableData {
  header: string[];
  /** Every row is exactly `header.length` wide. */
  rows: string[][];
  /** Per column: every non-empty cell reads as a number. */
  numeric: boolean[];
}

export type SortDir = "asc" | "desc";

/**
 * RFC 4180 split: `delimiter` between fields, LF or CRLF between records, a
 * field wrapped in double quotes may carry any of those, and `""` inside it
 * is one quote. An unquoted field is trimmed (`a, b` is two words, not a
 * word and a space-word); a quoted one keeps its whitespace. A trailing line
 * break closes the last record without opening an empty one.
 *
 * With a pipe delimiter, `\|` is a literal pipe: that is how a GitHub table
 * carries one, and a pipe table has no quoting of its own.
 */
export function parseDelimited(source: string, delimiter: string): string[][] {
  const escaped = delimiter === "|";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let wasQuoted = false;
  const endCell = () => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inQuotes) {
      if (c !== '"') {
        cell += c;
      } else if (source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (c === '"' && !wasQuoted && cell.trim() === "") {
      inQuotes = true;
      wasQuoted = true;
      cell = "";
    } else if (escaped && c === "\\" && source[i + 1] === delimiter) {
      cell += delimiter;
      i++;
    } else if (c === delimiter) {
      endCell();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += c;
    }
  }
  if (cell !== "" || wasQuoted || row.length > 0) endRow();
  return rows;
}

/**
 * The delimiter a ```table fence uses, read off its first non-empty line:
 * whichever candidate appears most, ties going to the more deliberate
 * character (a tab or a pipe is never punctuation in prose, a comma often
 * is). Null when the line carries none of them.
 */
export function detectDelimiter(source: string): Delimiter | null {
  const line = source.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let best: Delimiter | null = null;
  let bestCount = 0;
  for (const candidate of ["\t", "|", ";", ","] as const) {
    const count =
      candidate === "|"
        ? line.replace(/\\\|/g, "").split("|").length - 1
        : line.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// The trailing edge must not be an escaped pipe: `| a \| |` ends in `|`,
// but `| a \|` ends in a literal one.
const PIPE_EDGE = /^[ \t]*\||(?<!\\)\|[ \t]*$/gm;
const PIPE_RULE = /^:?-+:?$/;

/** A GitHub pipe-table rule: every cell is dashes, with optional colons. */
function isPipeRule(row: readonly string[] | undefined): boolean {
  return row !== undefined && row.every((c) => PIPE_RULE.test(c));
}

/**
 * The fence as a grid, or null when it should stay code. `lang` is the
 * fence's info word: csv, tsv or table.
 *
 * Rows the header's width apart are ragged. Up to one in ten (rounded up, so
 * always at least one: the row still being streamed) are repaired, a short
 * row padded with empty cells and a long row's overflow folded into its last
 * cell so nothing written is dropped. More than that and the source is not
 * the table it claims to be.
 */
export function parseTable(source: string, lang: string): TableData | null {
  const delimiter: Delimiter | null =
    lang === "csv" ? "," : lang === "tsv" ? "\t" : detectDelimiter(source);
  if (!delimiter) return null;
  // A pipe table usually wears GitHub's dress: an edge pipe on both sides
  // and a `|---|---|` rule right under the header. Neither is data. A row of
  // dashes anywhere else is data and stays.
  const text = delimiter === "|" ? source.replace(PIPE_EDGE, "") : source;
  const records = parseDelimited(text, delimiter).filter(
    (row) => row.length > 1 || row[0] !== "",
  );
  if (delimiter === "|" && isPipeRule(records[1])) records.splice(1, 1);
  const [header, ...body] = records;
  if (!header || header.length < 2 || body.length < 1) return null;
  const width = header.length;
  let ragged = 0;
  const rows = body.map((row) => {
    if (row.length === width) return row;
    ragged++;
    if (row.length < width) {
      return row.concat(Array.from({ length: width - row.length }, () => ""));
    }
    return [...row.slice(0, width - 1), row.slice(width - 1).join(delimiter)];
  });
  if (ragged > Math.ceil(body.length / 10)) return null;
  return {
    header,
    rows,
    numeric: header.map((_, col) => isNumericColumn(rows, col)),
  };
}

/** `1,234.5`, `-$12`, `$-12`, `+3%`, `.5`: a number with the dressing a
 *  spreadsheet gives it. Thousands groups must be groups of three. */
const NUMBER = /^[-+]?[$€£¥]?[-+]?(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?%?$/;

/** The number a cell reads as, or null when it is not one. */
export function parseNumber(cell: string): number | null {
  const s = cell.trim();
  if (!NUMBER.test(s) || !/\d/.test(s)) return null;
  const n = Number(s.replace(/[$€£¥,%+]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** True when the column has a value and every value it has is a number. */
export function isNumericColumn(
  rows: readonly string[][],
  col: number,
): boolean {
  let seen = false;
  for (const row of rows) {
    const cell = row[col] ?? "";
    if (cell.trim() === "") continue;
    if (parseNumber(cell) === null) return false;
    seen = true;
  }
  return seen;
}

/**
 * A copy of `rows` ordered by one column. Numeric columns compare as
 * numbers, text columns with a natural, case-insensitive collation. Empty
 * cells go last either way, and ties keep their source order.
 */
export function sortRows(
  rows: readonly string[][],
  col: number,
  dir: SortDir,
  numeric: boolean,
): string[][] {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const sign = dir === "desc" ? -1 : 1;
  return rows
    .map((row, index) => {
      const text = row[col] ?? "";
      return { row, index, text, empty: text.trim() === "" };
    })
    .sort((a, b) => {
      if (a.empty !== b.empty) return a.empty ? 1 : -1;
      const order = numeric
        ? (parseNumber(a.text) ?? 0) - (parseNumber(b.text) ?? 0)
        : collator.compare(a.text, b.text);
      return sign * order || a.index - b.index;
    })
    .map((k) => k.row);
}

/** Rows with `query` somewhere in them, case-insensitive; all of them for a
 *  blank query. */
export function filterRows(
  rows: readonly string[][],
  query: string,
): string[][] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((row) => row.some((c) => c.toLowerCase().includes(q)));
}

/** The header and rows as RFC 4180 CSV, comma separated, LF line breaks. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const field = (c: string) =>
    /[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
  return [header, ...rows].map((row) => row.map(field).join(",")).join("\n");
}

/**
 * `20 rows`, `1 row`, or `3 of 20 rows` while a filter is narrowing. When
 * the grid shows fewer than match (`rendered` below `shown`), the label says
 * so: `first 500 of 3,000 rows`, or `first 500 of 1,200 matches` under a
 * filter, so the reader knows to narrow rather than scroll.
 */
export function rowCountLabel(
  shown: number,
  total: number,
  rendered = shown,
): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const rows = total === 1 ? "row" : "rows";
  if (rendered < shown) {
    return shown === total
      ? `first ${n(rendered)} of ${n(shown)} ${rows}`
      : `first ${n(rendered)} of ${n(shown)} matches`;
  }
  return shown === total
    ? `${n(total)} ${rows}`
    : `${n(shown)} of ${n(total)} ${rows}`;
}

// ── DOM ──────────────────────────────────────────────────────

const COPY_LABEL = "Copy CSV";
const COPIED_LABEL = "Copied";
const COPIED_MS = 1600;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function buildTableBlock(data: TableData): HTMLElement {
  const { header, rows, numeric } = data;
  let sortCol = -1;
  let sortDir: SortDir = "asc";
  let query = "";

  const wrap = element("div", "md-table-wrap");
  const bar = element("div", "md-table-bar");
  const count = element("span", "md-table-count");
  count.setAttribute("aria-live", "polite");
  bar.append(count);

  if (rows.length > FILTER_THRESHOLD) {
    const filter = element("input", "md-table-filter");
    filter.type = "search";
    filter.placeholder = "Filter rows";
    filter.setAttribute("aria-label", "Filter rows");
    filter.autocomplete = "off";
    filter.spellcheck = false;
    filter.addEventListener("input", () => {
      query = filter.value;
      renderBody();
    });
    bar.append(filter);
  }

  const copy = element("button", "md-table-copy");
  copy.type = "button";
  copy.title = "Copy the rows shown as CSV";
  const copyIcon = element("span", "md-table-copy-icon");
  // Both glyphs share one cell, so the swap to the check moves nothing.
  copyIcon.innerHTML =
    `<span class="md-table-copy-glyph" data-state="idle">${copyIconMarkup(16)}</span>` +
    `<span class="md-table-copy-glyph" data-state="done">${checkIconMarkup(16)}</span>`;
  const copyLabel = element("span", "md-table-copy-label");
  copyLabel.textContent = COPY_LABEL;
  copy.append(copyIcon, copyLabel);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener("click", () => {
    copyToClipboard(toCsv(header, view()), () => {
      copy.dataset.copied = "";
      copyLabel.textContent = COPIED_LABEL;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        delete copy.dataset.copied;
        copyLabel.textContent = COPY_LABEL;
      }, COPIED_MS);
    });
  });
  bar.append(copy);

  const scroll = element("div", "md-table-scroll");
  const table = element("table", "md-table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const heads = header.map((name, col) => {
    const th = document.createElement("th");
    th.scope = "col";
    if (numeric[col]) th.classList.add("md-table-num");
    const button = element("button", "md-table-sort");
    button.type = "button";
    const label = element("span", "md-table-sort-label");
    label.textContent = name || `Column ${col + 1}`;
    const glyph = element("span", "md-table-sort-glyph");
    glyph.innerHTML = arrowUpIconMarkup(14) + arrowDownIconMarkup(14);
    button.append(label, glyph);
    button.addEventListener("click", () => {
      if (sortCol !== col) {
        sortCol = col;
        sortDir = "asc";
      } else if (sortDir === "asc") {
        sortDir = "desc";
      } else {
        sortCol = -1;
      }
      renderHeader();
      renderBody();
    });
    th.append(button);
    headRow.append(th);
    return th;
  });
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);
  scroll.append(table);
  wrap.append(bar, scroll);

  function view(): string[][] {
    const sorted =
      sortCol === -1
        ? rows
        : sortRows(rows, sortCol, sortDir, numeric[sortCol] ?? false);
    return filterRows(sorted, query);
  }

  function renderHeader() {
    heads.forEach((th, col) => {
      th.setAttribute(
        "aria-sort",
        col !== sortCol
          ? "none"
          : sortDir === "asc"
            ? "ascending"
            : "descending",
      );
    });
  }

  function renderBody() {
    const shown = view();
    const fragment = document.createDocumentFragment();
    const rendered = Math.min(shown.length, RENDER_CAP);
    for (let i = 0; i < rendered; i++) {
      const row = shown[i]!;
      const tr = document.createElement("tr");
      row.forEach((cell, col) => {
        const td = document.createElement("td");
        if (numeric[col]) td.className = "md-table-num";
        td.textContent = cell;
        tr.append(td);
      });
      fragment.append(tr);
    }
    tbody.replaceChildren(fragment);
    count.textContent = rowCountLabel(shown.length, rows.length, rendered);
    count.title =
      rendered < shown.length
        ? `The grid shows the first ${RENDER_CAP.toLocaleString("en-US")} rows; filter to narrow, or copy for all of them`
        : "";
  }

  renderHeader();
  renderBody();
  return wrap;
}

/** Source that is not a table (one row, one column, ragged past the
 *  tolerance) keeps the plain code fence. */
export const tableUpgrader: FenceUpgrader = {
  langs: [...TABLE_LANGS],
  async upgrade({ pre, source, lang, root, alive }) {
    const data = parseTable(source, lang);
    if (!data || !alive() || !root.contains(pre)) return false;
    pre.replaceWith(buildTableBlock(data));
    return true;
  },
};
