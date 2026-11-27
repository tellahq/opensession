/**
 * The design system's decisions, as the only values StyleX code may use.
 *
 * Every scale here is closed on purpose. A primitive that needs a size, a
 * colour or a corner picks one of these by name; there is no escape hatch for
 * "just this once 31px", because each of those is how the app ended up with
 * 39 control heights and 30 horizontal paddings. `bun scripts/ui-audit.ts`
 * rejects a raw length or colour inside `stylex.create` anywhere but this file.
 * See docs/design-system.md for the reasoning behind each scale.
 *
 * Colours and type are thin names over the theme properties in
 * styles/base-theme.css. They are `defineConsts`, not `defineVars`: StyleX
 * inlines them, so `var(--text)` still resolves wherever an ancestor re-points
 * `--text` (the side panel's plate, a popup's inverted surface), the way the
 * Tailwind tokens do. Light and dark keep switching in base-theme.css.
 */
import * as stylex from "@stylexjs/stylex";

/** Surface, ink, edge and status colours. Same roles as the Tailwind tokens. */
export const color = stylex.defineConsts({
  // Surfaces, L0 to L3.
  page: "var(--bg)",
  raised: "var(--bg-raised)",
  panel: "var(--bg-panel)",
  control: "var(--control-surface)",
  button: "var(--button-surface)",
  popup: "var(--popup-surface)",
  // Interaction washes: translucent ink, so one value reads on any surface.
  hover: "var(--hover)",
  pressed: "var(--hover-strong)",
  selected: "var(--selected)",
  // Ink.
  fg: "var(--text)",
  dim: "var(--text-dim)",
  faint: "var(--text-faint)",
  link: "var(--link)",
  // Edges.
  line: "var(--border)",
  lineStrong: "var(--border-strong)",
  divider: "var(--divider)",
  // Accent.
  accent: "var(--accent)",
  accentHover: "var(--accent-hover)",
  accentInk: "var(--accent-ink)",
  onAccent: "var(--on-accent)",
  // Status ink and their soft plates.
  green: "var(--green)",
  greenSoft: "var(--green-soft)",
  yellow: "var(--yellow)",
  yellowSoft: "var(--yellow-soft)",
  red: "var(--red)",
  redSoft: "var(--red-soft)",
  blue: "var(--blue)",
  blueSoft: "var(--blue-soft)",
  // Ink on a dark media scrim, where the theme does not apply.
  onScrim: "#fff",
  transparent: "transparent",
});

/**
 * Control heights. Three on desktop and one touch target: a control is 26
 * (chips, inline actions), 32 (the default) or 36 (a page's primary row), and
 * anything a finger operates on a phone is 44. Nothing in between.
 */
export const controlHeight = stylex.defineConsts({
  sm: "26px",
  md: "32px",
  lg: "36px",
  touch: "44px",
});

/**
 * Spacing, in px. A 2px step up to 16, then 4px, then 8px. The name is the
 * value, so a review can see what was picked. Odd values (3, 5, 7, 9, 11,
 * 13) are not on the scale: they are a 1px nudge standing in for a decision.
 */
export const space = stylex.defineConsts({
  s0: "0px",
  s2: "2px",
  s4: "4px",
  s6: "6px",
  s8: "8px",
  s10: "10px",
  s12: "12px",
  s14: "14px",
  s16: "16px",
  s20: "20px",
  s24: "24px",
  s32: "32px",
  s40: "40px",
  s48: "48px",
});

/**
 * Corner radii, chosen by the size of the box. Each scales with `--rf`, so a
 * browser with `corner-shape: squircle` draws them 1.35x larger. `pill` is a
 * true circle at the ends and opts out of the squircle; there is no other
 * escape. A child inside a rounded parent takes parent radius minus padding.
 */
export const radius = stylex.defineConsts({
  xs: "calc(2px * var(--rf))",
  sm: "calc(4px * var(--rf))",
  md: "calc(7px * var(--rf))",
  control: "calc(12px * var(--rf))",
  lg: "calc(14px * var(--rf))",
  popup: "calc(16px * var(--rf))",
  xl: "calc(18px * var(--rf))",
  xxl: "calc(22px * var(--rf))",
  pill: "calc(infinity * 1px)",
});

/**
 * Type roles. Pick by purpose, not by nearest number. Each promotes one rung
 * at phone width through base-theme.css, so no call site writes a phone size.
 */
export const text = stylex.defineConsts({
  meta: "var(--type-meta)",
  label: "var(--type-label)",
  itemTitle: "var(--type-item-title)",
  body: "var(--type-body)",
  dialogTitle: "var(--type-dialog-title)",
  sectionTitle: "var(--type-section-title)",
  pageTitle: "var(--type-page-title)",
  stat: "var(--type-stat)",
  inputPhone: "var(--type-input-phone)",
});

/**
 * Line heights for single-line control labels, as unitless ratios. Three
 * values for one 13px label is an accident inherited from Tailwind's stock
 * `text-xs` / `text-sm` / `text-base` leading, kept so the port renders
 * identically; docs/design-system.md lists unifying them as an open decision.
 */
export const leading = stylex.defineConsts({
  chip: "calc(1 / 0.75)",
  control: "calc(1.25 / 0.875)",
  body: "1.5",
});

/**
 * Weights. Medium is the app's regular; metadata and supporting copy drop to
 * regular; headings take `title` (500 in dark, 600 in light). Semibold and
 * bold are for prose emphasis, not chrome.
 */
export const weight = stylex.defineConsts({
  regular: "400",
  medium: "500",
  title: "var(--title-weight)",
});

/** The few opacities that mean something. */
export const opacity = stylex.defineConsts({
  disabled: "0.4",
  /** A supporting glyph beside a label on a neutral control. */
  glyphMuted: "0.6",
  /** The same glyph on a tinted or solid plate, where 0.6 reads as dirt. */
  glyphOnTone: "0.8",
  /** A trailing chevron, quieter than the label it qualifies. */
  affordance: "0.55",
});

export const motion = stylex.defineConsts({
  ease: "var(--ease)",
  micro: "var(--dur-micro)",
  /** Whole-control press tick. */
  pressScale: "0.96",
});

/** The one keyboard focus treatment: a 2px accent-ink ring, 2px out. */
export const focus = stylex.defineConsts({
  ring: "2px solid var(--accent-ink)",
  offset: "2px",
});

/** Elevation. Never a stock shadow; never a border on top of a ring tier. */
export const shadow = stylex.defineConsts({
  xs: "0 1px 2px -1px color-mix(in srgb, black 5%, transparent), 0 2px 5px -3px color-mix(in srgb, black 7%, transparent)",
  /** Top-down shading that gives a solid plate a face (Tailwind's `plate-sheen`). */
  plateSheen:
    "linear-gradient(to bottom, transparent, rgb(255 255 255 / 0.035) 35%, rgb(255 255 255 / 0.01) 55%, rgb(0 0 0 / 0.05))",
});

/** The one breakpoint (720px, inclusive on the phone side) and hover gating. */
export const media = stylex.defineConsts({
  phone: "@media (max-width: 720px)",
  desktop: "@media (min-width: 721px)",
  hover: "@media (hover: hover)",
  forcedColors: "@media (forced-colors: active)",
});
