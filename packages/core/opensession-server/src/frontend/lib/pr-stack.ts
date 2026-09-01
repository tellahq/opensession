import type { PrDetails, PrStack, PrStackLayer } from "./types";

/**
 * Reading a stack, shared by the surfaces that show one: the review panel's
 * stack map, the header's stack chip and its popover, and the merge action.
 *
 * The server hands the layers over trunk-first (position 1 is the layer
 * closest to the trunk). Everything a person reads is drawn the other way up —
 * github.com draws a stack top-down, and the trunk is the line under the last
 * row — so the flip lives here rather than in each caller.
 */

/** Layers top-first, the way a stack is drawn. Never mutates the input. */
export function stackLayersTopFirst(stack: PrStack): PrStackLayer[] {
  return [...stack.layers].sort((a, b) => b.position - a.position);
}

/**
 * What a stack merge would take: every open layer from the trunk up to and
 * including this PR. GitHub's stack merge is all-or-nothing, so this is the
 * whole set or nothing — and it refuses drafts, which is the one blocker we
 * can see from here (branch protection and repo rules are evaluated by GitHub
 * when the merge runs).
 */
export interface StackMergePlan {
  /** Bottom-first: the order the layers land in. */
  layers: PrStackLayer[];
  /** A draft in that set — GitHub's stack merge would refuse the whole thing. */
  blockedBy: PrStackLayer | null;
}

/** Null when this PR isn't a stack layer, or is no longer open. */
export function stackMergePlan(pr: PrDetails | null): StackMergePlan | null {
  const stack = pr?.stack;
  if (!stack || pr!.state !== "OPEN") return null;
  const layers = stack.layers
    .filter((l) => l.position <= stack.position && l.state === "OPEN")
    .sort((a, b) => a.position - b.position);
  if (!layers.length) return null;
  return { layers, blockedBy: layers.find((l) => l.isDraft) || null };
}
