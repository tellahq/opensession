/**
 * StyleX design tokens — the bridge between component styles and base.css.
 *
 * base.css remains the substrate: every value here resolves through the same
 * `--*` custom properties it always did, so `html[data-theme]` re-themes both
 * the remaining stylesheets and every StyleX-declared color together. Nothing
 * in here names a raw color; a token that points at nothing resolves through
 * base.css, never through a literal added here.
 *
 * Naming follows the vocabulary the Tailwind theme established (bg, raised,
 * panel, line, dim, faint, accent …) so converted call sites read the same on
 * both sides of the migration. See CONCEPTS.md for the words themselves.
 */
import * as stylex from "@stylexjs/stylex";

export const tokens = stylex.defineVars({
  /* Surfaces */
  bg: "var(--bg)",
  raised: "var(--bg-raised)",
  /** The sidebar column and the chrome band around it. */
  sidebar: "var(--sidebar-bg)",
  panel: "var(--bg-panel)",
  /** The session's right-hand panel column (PANEL_SHELL re-points it). */
  panelSurface: "var(--panel-surface)",
  /** The plate a settings group sits on. */
  settingsPlate: "var(--settings-plate)",
  /** Floating popups (hover cards, menus); popupGlass is the blurred paper. */
  popup: "var(--popup-surface)",
  popupGlass: "var(--popup-glass)",
  paletteGlass: "var(--palette-glass)",

  /* Interaction washes and states */
  hover: "var(--hover)",
  pressed: "var(--hover-strong)",
  selected: "var(--selected)",
  active: "var(--bg-active)",

  /* Borders */
  line: "var(--border)",
  lineStrong: "var(--border-strong)",
  divider: "var(--divider)",
  dividerSoft: "var(--divider-soft)",

  /* Text */
  fg: "var(--text)",
  dim: "var(--text-dim)",
  faint: "var(--text-faint)",

  /* Accent + status */
  accent: "var(--accent)",
  accentInk: "var(--accent-ink)",
  accentSoft: "var(--accent-soft)",
  onAccent: "var(--on-accent)",
  accentHover: "var(--accent-hover)",
  accentControl: "var(--accent-control, var(--accent))",
  onAccentControl: "var(--on-accent-control, var(--on-accent))",
  link: "var(--link)",
  focusRing: "var(--accent-ink)",
  green: "var(--green)",
  greenSoft: "var(--green-soft)",
  yellow: "var(--yellow)",
  yellowSoft: "var(--yellow-soft)",
  yellowTint: "var(--yellow-tint)",
  blue: "var(--blue)",
  blueSoft: "var(--blue-soft)",
  red: "var(--red)",
  redSoft: "var(--red-soft)",
  purple: "var(--purple)",

  /* Tool-family hues (transcript timeline) */
  toolRun: "var(--tool-run)",
  toolFile: "var(--tool-file)",
  toolEdit: "var(--tool-edit)",
  toolFind: "var(--tool-find)",
  toolWeb: "var(--tool-web)",
  toolAgent: "var(--tool-agent)",
  toolMcp: "var(--tool-mcp)",
  toolSkill: "var(--tool-skill)",

  /* Code wells */
  codeWell: "var(--code-well)",
  codeWellLine: "var(--code-well-line)",
  codeWellInk: "var(--code-well-ink)",
  codeWellGutter: "var(--code-well-gutter)",

  /* Tooltip chip */
  tooltipBg: "var(--tooltip-bg)",
  tooltipFg: "var(--tooltip-fg)",
  tooltipRing: "var(--tooltip-ring)",

  /* Control chrome */
  control: "var(--control-surface)",
  button: "var(--button-surface)",

  /* Type + shape + motion */
  sans: "var(--sans)",
  mono: "var(--mono)",
  titleWeight: "var(--title-weight)",
  radiusPanel: "calc(var(--radius) * var(--rf))",
  radiusControl: "calc(12px * var(--rf))",
  radiusRow: "calc(12px * var(--rf))",
  radiusPopup: "calc(16px * var(--rf))",
  durMicro: "var(--dur-micro)",
  ease: "var(--ease)",
});
