/**
 * THE SCALE, as StyleX styles.
 *
 * Eight steps, and text is set from one of them — see styles/tailwind.css for
 * the full rationale (desktop/phone columns, why arbitrary px sizes are
 * banned). Each role resolves through a `--type-*` property in base.css,
 * which is where the values live and where a phone promotes every one a rung,
 * so writing the role is what makes both widths follow.
 *
 * Import as `import { type } from "../styles/typography.stylex";` and compose
 * with the component's own styles: stylex.props(type.body, styles.x).
 */
import * as stylex from "@stylexjs/stylex";

/** Weight of plain text, spelled so a role can restate it without !important
 *  semantics (StyleX composes last-write-wins per property). */
const normalWeight = "var(--font-weight-normal)";

export const type = stylex.create({
  meta: { fontSize: "var(--type-meta)", fontWeight: normalWeight },
  label: { fontSize: "var(--type-label)" },
  supporting: { fontSize: "var(--type-label)", fontWeight: normalWeight },
  controlLabel: { fontSize: "var(--type-label)" },
  body: { fontSize: "var(--type-body)" },
  itemTitle: {
    fontSize: "var(--type-item-title)",
    "--settings-leading": "1.1",
  },
  dialogTitle: {
    fontSize: "var(--type-dialog-title)",
    "--settings-leading": "1.1",
  },
  sectionTitle: {
    fontSize: "var(--type-section-title)",
    "--settings-leading": "1.1",
  },
  pageTitle: {
    fontSize: "var(--type-page-title)",
    "--settings-leading": "1.1",
  },
  /** Not a step: iOS Safari zooms when a focused input is under 16px. */
  inputPhone: { fontSize: "var(--type-input-phone)" },
  stat: {
    fontSize: "var(--type-stat)",
    "--settings-leading": "1.1",
    lineHeight: "var(--type-stat-line)",
    letterSpacing: "-0.025em",
  },
});
