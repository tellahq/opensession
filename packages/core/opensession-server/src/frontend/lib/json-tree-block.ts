/**
 * A large ```json fence rendered as a collapsible tree, with a toggle back to
 * the raw highlighted text. Small JSON (under the thresholds below) stays
 * shiki-highlighted code, and JSON that does not parse (still streaming,
 * comments, trailing commas) declines too.
 *
 * The block keeps the copy and wrap controls: the fence's own <pre> stays
 * inside it, hidden while the tree shows, so the copy control (which reads
 * the first <pre> in the wrapper) still copies the JSON text rather than
 * the tree's labels. Switching to Raw reveals that <pre>, highlighted on
 * first use.
 *
 * The fence is parsed once into a tagged tree (`JsonNode`), and the rows are
 * built from it as an HTML string by pure functions (json-tree-block.test.ts);
 * the DOM part is the swap, a delegated click handler and lazy rendering of
 * a folded node's children on first expand.
 */

import { z } from "zod";
import { chevronRightIconMarkup } from "../components/icons";
import type { FenceUpgrader } from "./fence-upgraders";

/** A fence with more lines than this is worth folding. */
export const JSON_TREE_MIN_LINES = 30;
/** ... or more characters than this (minified JSON is one long line). */
export const JSON_TREE_MIN_CHARS = 1500;
/** Past this the tree would be heavier than the wall of text it replaces. */
export const JSON_TREE_MAX_CHARS = 200_000;
/** Containers at this depth and deeper start folded (root is depth 0). */
export const JSON_TREE_COLLAPSE_DEPTH = 2;
/** Rows rendered per container; the rest are counted in one closing row. */
export const JSON_TREE_MAX_CHILDREN = 500;

export type JsonNode =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "object"; entries: [string, JsonNode][] };
export type JsonContainer = Extract<JsonNode, { kind: "array" | "object" }>;

/** The keys (or indices, as decimal strings) from the root to a node. Which
 *  one a step is follows from the node it is applied to. */
export type JsonPath = string[];

const jsonNodeSchema: z.ZodType<JsonNode> = z.lazy(() =>
  z.union([
    z.null().transform((): JsonNode => ({ kind: "null" })),
    z.boolean().transform((value): JsonNode => ({ kind: "boolean", value })),
    z.number().transform((value): JsonNode => ({ kind: "number", value })),
    z.string().transform((value): JsonNode => ({ kind: "string", value })),
    z
      .array(jsonNodeSchema)
      .transform((items): JsonNode => ({ kind: "array", items })),
    z.record(z.string(), jsonNodeSchema).transform((record): JsonNode => ({
      kind: "object",
      entries: Object.entries(record),
    })),
  ]),
);

const jsonPathSchema = z.array(z.string());

export function isJsonContainer(node: JsonNode): node is JsonContainer {
  return node.kind === "array" || node.kind === "object";
}

/** Whether a fence is big enough that a tree beats reading it as text. */
export function jsonWorthFolding(source: string): boolean {
  const text = source.trim();
  if (text.length > JSON_TREE_MAX_CHARS) return false;
  if (text.length > JSON_TREE_MIN_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lines++;
  return lines > JSON_TREE_MIN_LINES;
}

/** The fence as a tree, or null when it does not parse or is not an object
 *  or array: a bare string or number has nothing to fold. */
export function parseJsonTree(source: string): JsonContainer | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  const parsed = jsonNodeSchema.safeParse(raw);
  if (!parsed.success) return null;
  return isJsonContainer(parsed.data) ? parsed.data : null;
}

/** The node at `path` under `root`, or undefined when the path is off. */
export function jsonAtPath(
  root: JsonNode,
  path: JsonPath,
): JsonNode | undefined {
  let node: JsonNode | undefined = root;
  for (const step of path) {
    if (node === undefined) return undefined;
    if (node.kind === "array") {
      const index = Number(step);
      node = Number.isInteger(index) ? node.items[index] : undefined;
    } else if (node.kind === "object") {
      node = node.entries.find(([key]) => key === step)?.[1];
    } else {
      return undefined;
    }
  }
  return node;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** What sits before a row's value: its object key or array index. */
export type RowLabel =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | null;

function childRows(
  node: JsonContainer,
): { label: RowLabel; step: string; child: JsonNode }[] {
  return node.kind === "array"
    ? node.items.map((child, index) => ({
        label: { kind: "index", index },
        step: String(index),
        child,
      }))
    : node.entries.map(([key, child]) => ({
        label: { kind: "key", key },
        step: key,
        child,
      }));
}

function childCount(node: JsonContainer): number {
  return node.kind === "array" ? node.items.length : node.entries.length;
}

/** "12 keys", "1 item": the folded summary of a container. */
export function containerSummary(node: JsonContainer): string {
  const count = childCount(node);
  const noun = node.kind === "array" ? "item" : "key";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const BARE_KEY = /^[A-Za-z_$][\w$]*$/;

function labelHtml(label: RowLabel): string {
  if (label === null) return "";
  if (label.kind === "index")
    return `<span class="md-json-index">${label.index}</span><span class="md-json-punct">: </span>`;
  const text = BARE_KEY.test(label.key) ? label.key : JSON.stringify(label.key);
  return `<span class="md-json-key">${escapeHtml(text)}</span><span class="md-json-punct">: </span>`;
}

function leafHtml(node: Exclude<JsonNode, JsonContainer>): string {
  switch (node.kind) {
    case "string":
      return `<span class="md-json-string">${escapeHtml(JSON.stringify(node.value))}</span>`;
    case "number":
      return `<span class="md-json-number">${String(node.value)}</span>`;
    case "boolean":
      return `<span class="md-json-keyword">${String(node.value)}</span>`;
    case "null":
      return `<span class="md-json-keyword">null</span>`;
  }
}

/** The rows for a container's children. `path` and `depth` are the
 *  container's own. */
export function renderJsonChildrenHtml(
  node: JsonContainer,
  path: JsonPath,
  depth: number,
): string {
  const rows = childRows(node);
  let html = "";
  for (const { label, step, child } of rows.slice(0, JSON_TREE_MAX_CHILDREN)) {
    html += renderJsonNodeHtml(child, label, [...path, step], depth + 1);
  }
  const rest = rows.length - JSON_TREE_MAX_CHILDREN;
  if (rest > 0) {
    html += `<li class="md-json-node md-json-more"><div class="md-json-row"><span class="md-json-count">${rest} more in the raw view</span></div></li>`;
  }
  return html;
}

/**
 * One node as a list item. A container at or past the collapse depth starts
 * folded with its children left unrendered (`data-lazy`), so a big document
 * costs only the rows that are visible.
 */
export function renderJsonNodeHtml(
  node: JsonNode,
  label: RowLabel,
  path: JsonPath,
  depth: number,
): string {
  if (!isJsonContainer(node)) {
    return `<li class="md-json-node" data-kind="${node.kind}"><div class="md-json-row">${labelHtml(label)}${leafHtml(node)}</div></li>`;
  }
  const [open, close] = node.kind === "array" ? ["[", "]"] : ["{", "}"];
  if (childCount(node) === 0) {
    return `<li class="md-json-node" data-kind="${node.kind}"><div class="md-json-row">${labelHtml(label)}<span class="md-json-punct">${open}${close}</span></div></li>`;
  }
  const expanded = depth < JSON_TREE_COLLAPSE_DEPTH;
  const pathAttr = escapeHtml(JSON.stringify(path));
  const caret =
    `<button type="button" class="md-json-caret" aria-expanded="${expanded}"` +
    ` aria-label="${expanded ? "Collapse" : "Expand"}">${chevronRightIconMarkup()}</button>`;
  const summary =
    `<span class="md-json-punct">${open}</span>` +
    `<span class="md-json-count">${containerSummary(node)}</span>` +
    `<span class="md-json-punct md-json-close">${close}</span>`;
  const children = expanded
    ? `<ul class="md-json-list">${renderJsonChildrenHtml(node, path, depth)}</ul>`
    : "";
  return (
    `<li class="md-json-node" data-kind="${node.kind}" data-open="${expanded}"${expanded ? "" : " data-lazy"} data-path="${pathAttr}">` +
    `<div class="md-json-row">${caret}${labelHtml(label)}${summary}</div>` +
    children +
    `<div class="md-json-end"><span class="md-json-punct">${close}</span></div>` +
    `</li>`
  );
}

/** The whole tree, root expanded. */
export function renderJsonTreeHtml(root: JsonContainer): string {
  return `<ul class="md-json-list">${renderJsonNodeHtml(root, null, [], 0)}</ul>`;
}

/** The header: the Tree / Raw toggle and the root's summary. */
export function renderJsonHeadHtml(root: JsonContainer): string {
  return (
    `<div class="md-json-head">` +
    `<div class="md-json-views" role="group" aria-label="View">` +
    `<button type="button" class="md-json-view" data-view="tree" aria-pressed="true">Tree</button>` +
    `<button type="button" class="md-json-view" data-view="raw" aria-pressed="false">Raw</button>` +
    `</div>` +
    `<span class="md-json-summary">${containerSummary(root)}</span>` +
    `</div>`
  );
}

/** Parse a node's `data-path` back into a path. */
export function parseJsonPath(raw: string | undefined): JsonPath | null {
  if (!raw) return null;
  try {
    const parsed = jsonPathSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

let highlightPromise: Promise<
  typeof import("../components/CodeHighlight")
> | null = null;
function loadHighlight() {
  highlightPromise ??= import("../components/CodeHighlight");
  return highlightPromise;
}

/**
 * Swap the block's plain <pre> for shiki's on the first switch to Raw. The
 * body's own highlighter skipped this fence because the tree claimed it.
 */
async function highlightRaw(
  block: HTMLElement,
  source: string,
  root: HTMLElement,
  alive: () => boolean,
): Promise<void> {
  const m = await loadHighlight().catch(() => null);
  const out = m
    ? await m.highlightToHtml(source, "json").catch(() => null)
    : null;
  if (!out || !alive() || !root.contains(block)) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = out;
  const shikiPre = tpl.content.firstElementChild;
  const plain = block.querySelector(":scope > pre");
  if (!(shikiPre instanceof HTMLElement) || !plain) return;
  shikiPre.classList.add("md-code", "md-json-raw");
  // The well is the block's; keep only shiki's ink (see MarkdownBody).
  shikiPre.style.backgroundColor = "";
  plain.replaceWith(shikiPre);
}

function setView(block: HTMLElement, view: "tree" | "raw"): void {
  block.dataset.view = view;
  for (const button of Array.from(
    block.querySelectorAll<HTMLElement>(":scope > .md-json-head .md-json-view"),
  )) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
}

function toggleNode(
  li: HTMLElement,
  caret: HTMLElement,
  root: JsonContainer,
): void {
  const open = li.dataset.open !== "true";
  if (open && li.hasAttribute("data-lazy")) {
    const path = parseJsonPath(li.dataset.path);
    const node = path ? jsonAtPath(root, path) : undefined;
    if (!path || node === undefined || !isJsonContainer(node)) return;
    const list = document.createElement("ul");
    list.className = "md-json-list";
    list.innerHTML = renderJsonChildrenHtml(node, path, path.length);
    li.querySelector(":scope > .md-json-row")?.after(list);
    li.removeAttribute("data-lazy");
  }
  li.dataset.open = String(open);
  caret.setAttribute("aria-expanded", String(open));
  caret.setAttribute("aria-label", open ? "Collapse" : "Expand");
}

export const jsonTreeUpgrader: FenceUpgrader = {
  langs: ["json"],
  keepsCodeControls: true,
  async upgrade({ pre, source, root, alive }) {
    if (!jsonWorthFolding(source)) return false;
    const tree = parseJsonTree(source);
    if (!tree) return false;
    // The copy control's wrapper is attached in the effect after the upgrade
    // pass starts (see fence-upgraders.ts), so the fence has to be replaced
    // after this pass yields, or the wrapper forms around the hidden <pre>
    // inside the block instead of around the block.
    await Promise.resolve();
    if (!alive() || !root.contains(pre)) return false;
    const block = document.createElement("div");
    block.className = "md-json-tree md-code-well";
    block.dataset.view = "tree";
    block.innerHTML =
      renderJsonHeadHtml(tree) +
      `<div class="md-json-body">${renderJsonTreeHtml(tree)}</div>`;
    let highlighted = false;
    block.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const viewButton = target.closest<HTMLElement>("button.md-json-view");
      if (viewButton && block.contains(viewButton)) {
        const view = viewButton.dataset.view === "raw" ? "raw" : "tree";
        setView(block, view);
        if (view === "raw" && !highlighted) {
          highlighted = true;
          void highlightRaw(block, source, root, alive);
        }
        return;
      }
      const caret = target.closest<HTMLElement>("button.md-json-caret");
      const li = caret?.closest<HTMLElement>("li.md-json-node");
      if (caret && li && block.contains(li)) toggleNode(li, caret, tree);
    });
    pre.classList.add("md-json-raw");
    pre.replaceWith(block);
    block.append(pre);
    return true;
  },
};
