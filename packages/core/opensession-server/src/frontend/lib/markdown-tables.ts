import { checkIconMarkup, copyIconMarkup } from "../components/icons";
import { copyToClipboard } from "./share-link";

/**
 * Smart prose Markdown tables:
 *  - Column typing: detects numeric/metric columns (right-aligned + tabular-nums)
 *    and code/ID columns.
 *  - Wide breakout: marks wide (>= 5 column) tables so desktop layouts can give
 *    them extra breathing room without squeezing cells.
 *  - One-click Copy CSV: wraps prose tables with a quiet top-right CSV copy
 *    button using RFC 4180 escaping.
 *
 * Skips `.md-table` data grids (already upgraded from ```csv/```table fences).
 */

const WRAP_CLASS = "md-smart-table-wrap";
const SCROLL_CLASS = "md-smart-table-scroll";
const COPY_CLASS = "md-smart-table-copy";
const COPIED_MS = 1600;

const NUMERIC_CELL_RE =
  /^[+-]?(?:\$|€|£|¥)?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s*(?:%|ms|s|m|h|d|kb|mb|gb|tb|b|px|x|k|m|b))?$|^[+-]?\d+(?:\.\d+)?(?:\s*(?:%|ms|s|m|h|d|kb|mb|gb|tb|b|px|x))?$|^—$|^–$|^-$|^n\/a$/i;

export type ColumnType = "number" | "code" | "text";

export function classifyColumnValues(
  values: readonly { readonly text: string; readonly isSingleCode: boolean }[],
): ColumnType {
  const nonEmpty = values.filter((v) => v.text.trim().length > 0);
  if (nonEmpty.length === 0) return "text";

  const meaningful = nonEmpty.filter(
    (v) => !/^(?:—|–|-|n\/a)$/i.test(v.text.trim()),
  );
  if (meaningful.length > 0) {
    const numericCount = nonEmpty.filter((v) =>
      NUMERIC_CELL_RE.test(v.text.trim()),
    ).length;
    if (numericCount / nonEmpty.length >= 0.8) return "number";
  }

  const codeCount = nonEmpty.filter((v) => v.isSingleCode).length;
  if (codeCount / nonEmpty.length >= 0.8) return "code";

  return "text";
}

export function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ").trim();
  if (/[",\n\r]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function tableElementToCsv(table: HTMLTableElement): string {
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.children)
      .filter((el) => el.tagName === "TH" || el.tagName === "TD")
      .map((el) => (el.textContent ?? "").trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rowsToCsv(rows);
}

function isSingleCodeCell(cell: Element): boolean {
  if (cell.children.length !== 1) return false;
  const only = cell.children[0];
  if (!only || only.tagName !== "CODE") return false;
  const rawText = (cell.textContent ?? "").trim();
  const codeText = (only.textContent ?? "").trim();
  return rawText.length > 0 && rawText === codeText;
}

const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function flashCopied(button: HTMLElement): void {
  const running = flashTimers.get(button);
  if (running) clearTimeout(running);
  button.dataset.copied = "";
  button.title = "Copied CSV";
  button.setAttribute("aria-label", "Copied CSV");
  flashTimers.set(
    button,
    setTimeout(() => {
      delete button.dataset.copied;
      button.title = "Copy as CSV";
      button.setAttribute("aria-label", "Copy as CSV");
      flashTimers.delete(button);
    }, COPIED_MS),
  );
}

export function decorateMarkdownTables(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll("table"))) {
    if (table.classList.contains("md-table")) continue;
    const existing = table.parentElement?.closest(`.${WRAP_CLASS}`);
    if (existing && root.contains(existing)) continue;
    if (table.closest(".md-table-wrap")) continue;

    const headRow = table.querySelector("thead tr");
    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    const headerCells = headRow ? Array.from(headRow.children) : [];
    const colCount = Math.max(
      headerCells.length,
      ...bodyRows.map((r) => r.children.length),
    );

    if (colCount > 0 && bodyRows.length > 0) {
      for (let col = 0; col < colCount; col++) {
        const colCells = bodyRows
          .map((row) => row.children[col])
          .filter((c): c is Element => Boolean(c));
        const colType = classifyColumnValues(
          colCells.map((c) => ({
            text: (c.textContent ?? "").trim(),
            isSingleCode: isSingleCodeCell(c),
          })),
        );
        if (colType === "text") continue;
        const th = headerCells[col];
        if (th instanceof HTMLElement && !th.style.textAlign) {
          th.dataset.colType = colType;
        }
        for (const td of colCells) {
          if (td instanceof HTMLElement && !td.style.textAlign) {
            td.dataset.colType = colType;
          }
        }
      }
    }

    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS;
    if (colCount >= 5) wrap.dataset.wide = "true";

    const scroll = document.createElement("div");
    scroll.className = SCROLL_CLASS;

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = COPY_CLASS;
    copyButton.title = "Copy as CSV";
    copyButton.setAttribute("aria-label", "Copy as CSV");
    copyButton.innerHTML =
      `<span class="md-smart-table-copy-glyph" data-state="idle">${copyIconMarkup()}</span>` +
      `<span class="md-smart-table-copy-glyph" data-state="done">${checkIconMarkup()}</span>` +
      `<span class="md-smart-table-copy-label">CSV</span>`;

    table.replaceWith(wrap);
    scroll.append(table);
    wrap.append(copyButton, scroll);
  }
}

export function attachSmartTableCopy(root: HTMLElement): () => void {
  function onClick(e: MouseEvent) {
    if (!(e.target instanceof Element)) return;
    const button = e.target.closest(`button.${COPY_CLASS}`);
    if (!(button instanceof HTMLElement) || !root.contains(button)) return;
    const table = button
      .closest(`.${WRAP_CLASS}`)
      ?.querySelector<HTMLTableElement>("table");
    if (!table) return;
    e.preventDefault();
    copyToClipboard(tableElementToCsv(table), () => flashCopied(button));
  }
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
