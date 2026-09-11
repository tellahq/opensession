/**
 * File trees: a ```tree fence renders as a collapsible tree. The fence holds
 * either an indented listing (two spaces or a tab per level, a trailing `/`
 * marks a directory) or `tree` CLI output with its box-drawing connectors.
 *
 * DOM built inside a markdown body, no React. A file row carries
 * `data-tree-path` (relative to the tree's root); the session viewer's
 * delegated click handler (hooks/useTranscriptBlocks.ts) opens the file in
 * the Changes pane when the session's diff has it. Which rows can open is
 * published here per messages container, so the row can show it, the way
 * quick replies learn whether they are still current (choices-block.ts).
 * Folding is the block's own business and is wired at build time.
 */

import {
  chevronRightIconMarkup,
  fileIconMarkup,
  folderIconMarkup,
} from "../components/icons";
import type { FenceUpgrader } from "./fence-upgraders";

export const TREE_BLOCK_CLASS = "md-tree";
export const TREE_ROW_CLASS = "md-tree-row";
const SCOPE_SELECTOR = ".viewer-messages";
/** Directories this deep and shallower start open (root is depth 0). */
const OPEN_DEPTH = 1;
const MAX_LINES = 400;

export interface TreeNode {
  name: string;
  dir: boolean;
  /** A trailing `# note` on the line, shown dim beside the name. */
  note?: string;
  children: TreeNode[];
}

interface ParsedLine {
  depth: number;
  name: string;
  dir: boolean;
  note?: string;
}

/** `├── `, `└── ` and their ASCII spellings (`|-- `, `` `-- ``). */
const CONNECTOR = /(?:├|└|\||`)[─-]{2}\s?/;
/** One level of a `tree` prefix: `│   `, `|   ` or four blanks. */
const PREFIX_UNIT = /^(?:[│|] {0,3}| {4})/;
/** A name that begins with a connector's leftovers is not a name. */
const BOX_CHARS = /^[│├└─]/;
const SUMMARY = /^\d+ director(?:y|ies)(?:, \d+ files?)?$/;

function splitName(raw: string): Pick<ParsedLine, "name" | "dir" | "note"> {
  let text = raw.trim();
  let note: string | undefined;
  const hash = text.search(/\s+#\s/);
  if (hash > 0) {
    note =
      text
        .slice(hash)
        .replace(/^\s+#\s*/, "")
        .trim() || undefined;
    text = text.slice(0, hash).trim();
  }
  // `tree -F` marks executables and links too; only the directory mark
  // matters here, the rest is dropped so the name reads clean.
  const dir = text.endsWith("/");
  const name = text.replace(/[/*@=|>]$/, "").trim();
  return note ? { name, dir, note } : { name, dir };
}

function parseBoxLine(line: string): ParsedLine | null {
  const at = line.search(CONNECTOR);
  if (at < 0) {
    // A root line: no connector, no prefix.
    if (/^[\s│|]/.test(line)) return null;
    return { depth: 0, ...splitName(line) };
  }
  let prefix = line.slice(0, at);
  let depth = 1;
  while (prefix.length > 0) {
    const unit = PREFIX_UNIT.exec(prefix)?.[0] ?? "";
    if (!unit) {
      // A short run of blanks right before the connector is still a level.
      if (/^ +$/.test(prefix)) depth += 1;
      else return null;
      break;
    }
    prefix = prefix.slice(unit.length);
    depth += 1;
  }
  const rest = line.slice(at).replace(CONNECTOR, "");
  const parts = splitName(rest);
  return parts.name ? { depth, ...parts } : null;
}

function parseIndentedLine(line: string, unit: number): ParsedLine | null {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
  const spaces = lead.replace(/\t/g, " ".repeat(unit)).length;
  if (spaces % unit !== 0) return null;
  const parts = splitName(line.slice(lead.length));
  if (!parts.name || BOX_CHARS.test(parts.name)) return null;
  return { depth: spaces / unit, ...parts };
}

function indentUnit(lines: string[]): number {
  let unit = 0;
  for (const line of lines) {
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (!lead) continue;
    const width = lead.includes("\t") ? 2 * lead.length : lead.length;
    unit = unit === 0 ? width : Math.min(unit, width);
  }
  return unit || 2;
}

function nest(lines: ParsedLine[]): TreeNode[] | null {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const line of lines) {
    if (line.depth > stack.length) return null;
    stack.length = line.depth;
    const node: TreeNode = { name: line.name, dir: line.dir, children: [] };
    if (line.note) node.note = line.note;
    const parent = stack[line.depth - 1];
    if (parent) {
      parent.dir = true;
      parent.children.push(node);
    } else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * Both grammars, decided by whether any line carries a `tree` connector.
 * Null for anything else: mixed forms, a level skipped, a box line whose
 * prefix does not divide into levels, or nothing at all.
 */
export function parseTree(source: string): TreeNode[] | null {
  const lines = source
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() && !SUMMARY.test(line.trim()));
  if (lines.length === 0 || lines.length > MAX_LINES) return null;
  const boxed = lines.some((line) => CONNECTOR.test(line));
  const parsed: ParsedLine[] = [];
  const unit = indentUnit(lines);
  for (const line of lines) {
    const entry = boxed ? parseBoxLine(line) : parseIndentedLine(line, unit);
    if (!entry) return null;
    parsed.push(entry);
  }
  if (parsed[0]?.depth !== 0) return null;
  return nest(parsed);
}

/** A lone top-level directory names the tree and is not part of the paths
 *  under it; otherwise the fence itself is the root. */
export function treeRoot(nodes: TreeNode[]): TreeNode | undefined {
  const [lone] = nodes;
  return nodes.length === 1 && lone?.dir ? lone : undefined;
}

/** Every file path in a tree, relative to its root. */
export function treeFilePaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (node: TreeNode, prefix: string) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (!node.dir) paths.push(path);
    for (const child of node.children) walk(child, path);
  };
  const root = treeRoot(nodes);
  for (const node of root ? root.children : nodes) walk(node, "");
  return paths;
}

/**
 * The session file a tree row stands for. An exact path wins; otherwise a
 * tree rooted below the repo (`src/` drawn as the root) matches the one
 * changed file that ends in the row's path.
 */
export function matchTreePath(
  path: string,
  candidates: readonly string[],
): string | undefined {
  const clean = path.replace(/^\.?\//, "");
  if (candidates.includes(clean)) return clean;
  const suffix = `/${clean}`;
  const tails = candidates.filter((candidate) => candidate.endsWith(suffix));
  return tails.length === 1 ? tails[0] : undefined;
}

/** Per messages container: the paths a tree row can open. */
const openablePaths = new WeakMap<Element, readonly string[]>();

function markOpenable(block: Element): void {
  const scope = block.closest(SCOPE_SELECTOR);
  const paths = (scope && openablePaths.get(scope)) || [];
  for (const row of block.querySelectorAll("[data-tree-path]")) {
    const path = row.getAttribute("data-tree-path") ?? "";
    if (matchTreePath(path, paths)) row.setAttribute("data-openable", "");
    else row.removeAttribute("data-openable");
  }
}

/**
 * Publish the files the session can open, and bring every mounted tree under
 * `container` in line. Called by the viewer whenever the diff changes.
 */
export function setOpenableTreePaths(
  container: Element,
  paths: readonly string[],
): void {
  openablePaths.set(container, paths);
  for (const block of container.querySelectorAll(`.${TREE_BLOCK_CLASS}`))
    markOpenable(block);
}

function span(className: string, markup?: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  if (markup) el.innerHTML = markup;
  return el;
}

function buildRow(node: TreeNode, depth: number, path: string): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = TREE_ROW_CLASS;
  row.style.setProperty("--md-tree-depth", String(depth));
  const name = span("md-tree-name");
  // Untrusted text: never markup.
  name.textContent = node.name;
  if (node.dir) {
    row.dataset.treeDir = "";
    row.setAttribute("aria-expanded", String(depth <= OPEN_DEPTH));
    row.setAttribute("aria-label", `${node.name} folder`);
    row.append(
      span("md-tree-caret", chevronRightIconMarkup(16)),
      span("md-tree-icon", folderIconMarkup(16)),
      name,
    );
  } else {
    row.dataset.treePath = path;
    row.setAttribute("aria-label", path);
    row.append(
      span("md-tree-caret"),
      span("md-tree-icon", fileIconMarkup(16)),
      name,
    );
  }
  if (node.note) {
    const note = span("md-tree-note");
    note.textContent = node.note;
    row.append(note);
  }
  return row;
}

function buildList(
  nodes: TreeNode[],
  depth: number,
  prefix: string,
  /** The lone root directory: drawn, but not part of the paths under it. */
  root: TreeNode | undefined,
): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "md-tree-list";
  for (const node of nodes) {
    const path =
      node === root ? "" : prefix ? `${prefix}/${node.name}` : node.name;
    const item = document.createElement("li");
    item.append(buildRow(node, depth, path));
    if (node.dir && node.children.length > 0) {
      const children = buildList(node.children, depth + 1, path, undefined);
      children.hidden = depth > OPEN_DEPTH;
      item.append(children);
    }
    list.append(item);
  }
  return list;
}

function toggleDirectory(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest("[data-tree-dir]");
  if (!(row instanceof HTMLElement)) return;
  const children = row.parentElement?.querySelector(":scope > ul");
  if (!(children instanceof HTMLElement)) return;
  const open = row.getAttribute("aria-expanded") !== "true";
  row.setAttribute("aria-expanded", String(open));
  children.hidden = !open;
}

export const treeUpgrader: FenceUpgrader = {
  langs: ["tree"],
  async upgrade({ pre, source, root, alive }) {
    const nodes = parseTree(source);
    if (!nodes || !alive() || !root.contains(pre)) return false;
    const block = document.createElement("div");
    block.className = TREE_BLOCK_CLASS;
    block.setAttribute("aria-label", "File tree");
    block.append(buildList(nodes, 0, "", treeRoot(nodes)));
    // Folding is local to the block; a click on a file row bubbles up to the
    // session viewer's delegated handler untouched.
    block.addEventListener("click", toggleDirectory);
    pre.replaceWith(block);
    markOpenable(block);
    return true;
  },
};
