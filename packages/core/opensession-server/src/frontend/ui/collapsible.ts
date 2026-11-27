/**
 * Collapsible — the open-in-place primitive, re-exported through `ui/`.
 *
 * `ui/disclosure.tsx` is the opinionated form of this: a titled block with a
 * foreground-weight trigger row, a chevron on the left and its own panel
 * padding. That is the right answer for reference material dropped into a
 * page, and most call sites want it.
 *
 * A surface with its own established grammar does not. The session Info panel
 * writes a faint label over a borderless plate and aligns every label to one
 * x; a Disclosure inside it fights all three. Those surfaces compose the Base
 * UI parts directly — but through here, so the `@base-ui` import stays inside
 * the layer that is allowed to hold it (`scripts/ui-audit.ts`, raw-base-ui)
 * and the panel's animation is one string rather than a copy per surface.
 *
 * Re-exported rather than wrapped: the parts API is the thing being reused,
 * and a prop-shaped stand-in for it would be a second Disclosure.
 */
import * as stylex from "@stylexjs/stylex";
import { motion } from "./tokens.stylex";

export { Collapsible } from "@base-ui/react/collapsible";

/**
 * What a `Collapsible.Panel` wears to animate rather than snap.
 *
 * Use Base UI's measured height only inside the open/close keyframes. The
 * resting height must be auto: a cancelled transition can leave the measured
 * custom property behind, clipping nested disclosures or streamed content.
 * Opening deliberately has no forwards fill, so natural sizing resumes even
 * if animation-completion cleanup is interrupted. Reduced motion is handled
 * globally in base.css, which flattens the duration to ~0ms.
 *
 * The `[hidden]` line is not redundant: Preflight is deliberately not imported
 * (see AGENTS.md), so the UA's `[hidden] { display: none }` is the only thing
 * hiding a closed panel, and any display utility on the same element would
 * outrank it.
 */
export const collapsible = stylex.create({
  panel: {
    height: "auto",
    overflow: "hidden",
    display: { default: null, ":is([hidden])": "none" },
    // The keyframes live in base-keyframes.css: they read Base UI's measured
    // `--collapsible-panel-height`, which no element-scoped rule can own.
    animationName: {
      default: null,
      ":is([data-open])": "collapsible-open",
      ":is([data-closed])": "collapsible-close",
    },
    animationDuration: motion.standard,
    animationTimingFunction: motion.ease,
    animationFillMode: { default: null, ":is([data-closed])": "forwards" },
  },
});

/** The panel style as one class string, for a caller composing Base UI's
 *  parts with its own classes. */
export const collapsiblePanelClasses =
  stylex.props(collapsible.panel).className ?? "";
