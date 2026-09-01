/**
 * Structural call-tree diff adapted from calldiff by Tanishq Kancharla.
 * Upstream: https://github.com/tanishqkancharla/calldiff (MIT, see LICENSE).
 *
 * Open Session's fork works from frozen source records rather than invoking
 * git, adds a `modified` state, and prunes unchanged leaves before returning
 * data to the browser. Keep the attribution when moving or copying this code.
 */

export type FlowStatus = "same" | "added" | "removed" | "modified";

export interface SourceLocation {
  file?: string;
  line?: number;
  endLine?: number;
}

export type CallStep =
  | ({ type: "call"; key: string; children?: CallStep[] } & SourceLocation)
  | ({
      type: "branch";
      key: string;
      label: string;
      children: CallStep[];
    } & SourceLocation);

export interface FunctionInfo extends SourceLocation {
  key: string;
  label: string;
  steps: CallStep[];
  exported: boolean;
}

export interface CallNode extends SourceLocation {
  key: string;
  label: string;
  kind: "call" | "branch";
  children: CallNode[];
}

export interface FlowNode extends SourceLocation {
  key: string;
  label: string;
  kind: "call" | "branch";
  status: FlowStatus;
  children: FlowNode[];
}

export interface FlowTree {
  entry: string;
  tree: FlowNode;
}

export interface FunctionIndex extends Map<string, FunctionInfo> {
  truncated?: boolean;
}

function resolveEntry(entry: string, index: FunctionIndex): string | null {
  if (index.has(entry)) return entry;
  const matches = [...index.keys()].filter(
    (key) =>
      key.endsWith(`::${entry}`) ||
      key.endsWith(`.${entry}`) ||
      key.endsWith(`::new ${entry}`),
  );
  if (matches.length === 1) return matches[0]!;
  const exported = matches.filter((key) => index.get(key)?.exported);
  return (exported.length === 1 ? exported : matches.sort())[0] ?? null;
}

function callLabel(key: string, index: FunctionIndex): string {
  return index.get(key)?.label ?? (key.includes("(") ? key : `${key}()`);
}

function expandSteps(
  steps: CallStep[],
  index: FunctionIndex,
  depth: number,
  maxDepth: number,
  visiting: Set<string>,
  budget: { remaining: number; truncated: boolean },
): CallNode[] {
  const nodes: CallNode[] = [];
  for (const step of steps) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    if (step.type === "branch") {
      budget.remaining--;
      nodes.push({
        key: step.key,
        label: step.label,
        kind: "branch",
        file: step.file,
        line: step.line,
        endLine: step.endLine,
        children: expandSteps(
          step.children,
          index,
          depth,
          maxDepth,
          visiting,
          budget,
        ),
      });
      continue;
    }
    nodes.push(
      expandCall(
        step.key,
        index,
        depth,
        maxDepth,
        visiting,
        budget,
        step.children,
        step,
      ),
    );
  }
  return nodes;
}

function expandCall(
  key: string,
  index: FunctionIndex,
  depth: number,
  maxDepth: number,
  visiting: Set<string>,
  budget: { remaining: number; truncated: boolean },
  inlineChildren?: CallStep[],
  callSite?: SourceLocation,
): CallNode {
  budget.remaining--;
  const resolved = resolveEntry(key, index) ?? key;
  const info = index.get(resolved);
  const location =
    depth === 0 && info?.line
      ? { file: info.file, line: info.line, endLine: info.endLine }
      : callSite;
  const base = {
    key: resolved,
    label: callLabel(resolved, index),
    kind: "call" as const,
    file: location?.file,
    line: location?.line,
    endLine: location?.endLine,
  };
  if (depth >= maxDepth) {
    if (info?.steps.length || inlineChildren?.length) budget.truncated = true;
    return { ...base, children: [] };
  }
  if (!info && !inlineChildren?.length) return { ...base, children: [] };
  if (info && visiting.has(resolved)) {
    return {
      ...base,
      label: `${base.label} (recursive)`,
      children: inlineChildren
        ? expandSteps(
            inlineChildren,
            index,
            depth + 1,
            maxDepth,
            visiting,
            budget,
          )
        : [],
    };
  }
  if (info) visiting.add(resolved);
  const children = [
    ...(info
      ? expandSteps(info.steps, index, depth + 1, maxDepth, visiting, budget)
      : []),
    ...(inlineChildren
      ? expandSteps(
          inlineChildren,
          index,
          depth + 1,
          maxDepth,
          visiting,
          budget,
        )
      : []),
  ];
  if (info) visiting.delete(resolved);
  return { ...base, children };
}

export function buildCallTree(
  entry: string,
  index: FunctionIndex,
  maxDepth: number,
  maxNodes = 800,
): CallNode {
  return buildCallTreeResult(entry, index, maxDepth, maxNodes).tree;
}

function buildCallTreeResult(
  entry: string,
  index: FunctionIndex,
  maxDepth: number,
  maxNodes: number,
): { tree: CallNode; truncated: boolean } {
  const key = resolveEntry(entry, index) ?? entry;
  const budget = { remaining: maxNodes, truncated: false };
  return {
    tree: expandCall(key, index, 0, maxDepth, new Set(), budget),
    truncated: budget.truncated,
  };
}

function mark(node: CallNode, status: "added" | "removed"): FlowNode {
  return {
    ...node,
    status,
    children: node.children.map((child) => mark(child, status)),
  };
}

function diffChildren(before: CallNode[], after: CallNode[]): FlowNode[] {
  const n = before.length;
  const m = after.length;
  const lengths = Array.from({ length: n + 1 }, () =>
    Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        before[i]!.key === after[j]!.key
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const result: FlowNode[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i]!.key === after[j]!.key) {
      result.push(diffTree(before[i]!, after[j]!));
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      result.push(mark(before[i++]!, "removed"));
    } else {
      result.push(mark(after[j++]!, "added"));
    }
  }
  while (i < n) result.push(mark(before[i++]!, "removed"));
  while (j < m) result.push(mark(after[j++]!, "added"));
  return result;
}

export function diffTree(before: CallNode, after: CallNode): FlowNode {
  return {
    ...after,
    status: before.label === after.label ? "same" : "modified",
    children: diffChildren(before.children, after.children),
  };
}

/** Drop unchanged leaves while retaining every ancestor needed to explain a change. */
function focused(node: FlowNode): FlowNode | null {
  const children = node.children
    .map(focused)
    .filter((child): child is FlowNode => child !== null);
  if (node.status === "same" && children.length === 0) return null;
  return { ...node, children };
}

function stepSignature(step: CallStep): string {
  return step.type === "branch"
    ? `branch:${step.key}[${step.children.map(stepSignature).join(",")}]`
    : `call:${step.key}[${(step.children ?? []).map(stepSignature).join(",")}]`;
}

function functionSignature(info: FunctionInfo | undefined): string {
  return info
    ? `${info.label}[${info.steps.map(stepSignature).join(",")}]`
    : "<missing>";
}

function nodeCount(node: FlowNode): number {
  return 1 + node.children.reduce((sum, child) => sum + nodeCount(child), 0);
}

export function buildChangedTrees(
  before: FunctionIndex,
  after: FunctionIndex,
  opts: { maxDepth?: number; maxTrees?: number; maxNodes?: number } = {},
): { trees: FlowTree[]; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 6;
  const maxTrees = opts.maxTrees ?? 20;
  const maxNodes = opts.maxNodes ?? 800;
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changed = [...keys].filter(
    (key) =>
      !key.includes("::new ") &&
      functionSignature(before.get(key)) !== functionSignature(after.get(key)),
  );
  const candidates = changed
    .sort((a, b) => {
      const exported =
        Number(Boolean(after.get(b)?.exported || before.get(b)?.exported)) -
        Number(Boolean(after.get(a)?.exported || before.get(a)?.exported));
      return exported || a.localeCompare(b);
    })
    .slice(0, 300);

  let nodes = 0;
  let truncated =
    Boolean(before.truncated || after.truncated) ||
    changed.length > candidates.length ||
    changed.length > maxTrees;
  const trees: FlowTree[] = [];
  for (const entry of candidates.slice(0, maxTrees)) {
    const remaining = maxNodes - nodes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const oldResult = before.has(entry)
      ? buildCallTreeResult(entry, before, maxDepth, remaining)
      : null;
    const newResult = after.has(entry)
      ? buildCallTreeResult(entry, after, maxDepth, remaining)
      : null;
    if (oldResult?.truncated || newResult?.truncated) truncated = true;
    const oldTree = oldResult?.tree ?? {
      key: entry,
      label: after.get(entry)?.label ?? entry,
      kind: "call" as const,
      children: [],
    };
    const newTree = newResult?.tree ?? {
      key: entry,
      label: before.get(entry)?.label ?? entry,
      kind: "call" as const,
      children: [],
    };
    let diff = !before.has(entry)
      ? mark(newTree, "added")
      : !after.has(entry)
        ? mark(oldTree, "removed")
        : diffTree(oldTree, newTree);
    const changedDiff = focused(diff);
    if (!changedDiff) continue;
    diff = changedDiff;
    const size = nodeCount(diff);
    if (nodes + size > maxNodes) {
      truncated = true;
      const bounded = limitTree(diff, maxNodes - nodes);
      if (bounded) {
        trees.push({ entry, tree: bounded });
        nodes = maxNodes;
      }
      break;
    }
    nodes += size;
    trees.push({ entry, tree: diff });
  }
  return { trees, truncated };
}

function limitTree(node: FlowNode, remaining: number): FlowNode | null {
  if (remaining <= 0) return null;
  let available = remaining - 1;
  const children: FlowNode[] = [];
  for (const child of node.children) {
    const bounded = limitTree(child, available);
    if (!bounded) break;
    children.push(bounded);
    available -= nodeCount(bounded);
  }
  return { ...node, children };
}
