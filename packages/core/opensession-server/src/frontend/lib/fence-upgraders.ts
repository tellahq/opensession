/**
 * The registry of ```lang fences that render as something other than code.
 *
 * A markdown body (components/MarkdownBody.tsx) renders marked's output first
 * and upgrades tagged fences after mount: mermaid into diagrams, vega-lite
 * into charts, everything else through shiki. Each block kind is one entry
 * here, so adding a kind is a new module plus a line in FENCE_UPGRADERS
 * rather than another branch in the body's effect. The body owns the loop,
 * the pass's cancellation and the innerHTML reset; an upgrader owns one
 * fence at a time.
 *
 * This module stays light. It is imported eagerly by the body and by the copy
 * control (code-copy.ts), so an upgrader's renderer (mermaid, vega, katex,
 * ...) is `import()`ed inside `upgrade`, never at the top of the file that
 * declares the upgrader. See docs/blocks.md for the catalog and the contract.
 */

import { chartUpgrader } from "./chart-fence";
import { mathUpgrader } from "./math-block";
import { mermaidUpgrader } from "./mermaid-fence";
import { paletteUpgrader } from "./palette-block";
import { tableUpgrader } from "./table-block";
import { metricsUpgrader } from "./metrics-block";
import type { EffectiveTheme } from "./theme";

export interface FenceUpgradeContext {
  /** The <pre> marked wrote for the fence. `pre.replaceWith(block)` is the
   *  upgrade; the block's own controls (expand, toggles) go with it. */
  pre: HTMLElement;
  /** The fence's source text, exactly as written. */
  source: string;
  /** The first word of the fence's info string, lowercased. */
  lang: string;
  /** The markdown body this fence sits in. */
  root: HTMLElement;
  theme: EffectiveTheme;
  /** False once this pass was superseded: new html, a theme flip, or an
   *  unmount. Check it after every await and stop touching the DOM. */
  alive: () => boolean;
}

/** The part of Element `finalize` reads. Named so a test can hand in a
 *  plain object: there is no DOM preload in this repo. */
export interface UpgradeRoot {
  matches(selector: string): boolean;
  querySelectorAll(selector: string): ArrayLike<UpgradeRoot>;
}

export interface FenceUpgrader {
  /** Info-string languages this claims, lowercase. */
  langs: readonly string[];
  /** Claim a fence by its content too, e.g. a bash fence carrying ANSI escape
   *  codes. Runs in addition to `langs`. */
  claims?: (lang: string, source: string) => boolean;
  /**
   * True when the copy and wrap controls (code-copy.ts) should stay on the
   * block: it is still code someone might copy (a terminal transcript, a
   * JSON tree with a raw view). Default false: the block replaces the fence
   * outright and carries whatever controls it needs, the way a diagram does.
   */
  keepsCodeControls?: boolean;
  /**
   * Replace `ctx.pre` with the rendered block and return true. Return false
   * (or throw) to keep the plain fence: source that does not parse, is still
   * streaming, or has the wrong shape. When returning false `ctx.pre` must
   * still be in the DOM, untouched, so shiki can highlight it.
   */
  upgrade(ctx: FenceUpgradeContext): Promise<boolean>;
  /**
   * Release anything live this upgrader mounted under `root` (dataflows,
   * timers, listeners) before the DOM under it is discarded. Called on every
   * reset and on unmount, so it must tolerate a root with nothing of its own.
   */
  finalize?(root: UpgradeRoot): void;
}

/** Every block kind, in the order fences are upgraded. */
export const FENCE_UPGRADERS: readonly FenceUpgrader[] = [
  mermaidUpgrader,
  chartUpgrader,
  paletteUpgrader,
  tableUpgrader,
  metricsUpgrader,
  mathUpgrader,
];

/** The upgrader that claims a fence, if any. */
export function fenceUpgraderFor(
  lang: string | undefined,
  source = "",
): FenceUpgrader | undefined {
  if (!lang) return undefined;
  const key = lang.toLowerCase();
  return FENCE_UPGRADERS.find(
    (u) => u.langs.includes(key) || u.claims?.(key, source) === true,
  );
}

/**
 * Selector for a fence's <code> that an upgrader will replace outright, so
 * the copy control leaves it alone: its source is not what anyone wants on
 * the clipboard, and what replaces it carries its own controls.
 */
export const REPLACED_FENCE_SELECTOR = FENCE_UPGRADERS.filter(
  (u) => !u.keepsCodeControls,
)
  .flatMap((u) => u.langs)
  .map((lang) => `code[class~="language-${lang}"]`)
  .join(", ");

/** Finalize every live block under `root` before its DOM is discarded. */
export function finalizeFenceUpgrades(root: UpgradeRoot): void {
  for (const upgrader of FENCE_UPGRADERS) {
    try {
      upgrader.finalize?.(root);
    } catch {
      // A block that already failed has nothing left to release.
    }
  }
}
