import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "./cn";

const sx = stylex.create({
  hVarCollapsiblePanelHeight: {
    height: "var(--collapsible-panel-height)",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  transitionHeight: {
    transitionProperty: "height",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },
  durationVarDur: {
    "--tw-duration": "var(--dur)",
    transitionDuration: "var(--dur)",
  },
  easeVarEase: {
    "--tw-ease": "var(--ease)",
    transitionTimingFunction: "var(--ease)",
  },
});

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
export { Collapsible } from "@base-ui/react/collapsible";

/**
 * What a `Collapsible.Panel` wears to animate rather than snap.
 *
 * Base UI publishes the measured height as a custom property; transitioning
 * to it (rather than to `auto`) is what interpolates at all. Reduced motion is
 * handled globally in base.css, which flattens the duration to ~0ms.
 *
 * The `[hidden]` line is not redundant: Preflight is deliberately not imported
 * (see AGENTS.md), so the UA's `[hidden] { display: none }` is the only thing
 * hiding a closed panel, and any display utility on the same element would
 * outrank it.
 */
export const collapsiblePanelClasses = mergeStylexClassName(
  "data-[starting-style]:h-0 data-[ending-style]:h-0 [&[hidden]]:hidden",
  sx.hVarCollapsiblePanelHeight,
  sx.overflowHidden,
  sx.transitionHeight,
  sx.durationVarDur,
  sx.easeVarEase,
);
