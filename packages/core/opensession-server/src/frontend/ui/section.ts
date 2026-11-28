import * as stylex from "@stylexjs/stylex";
import {
  color,
  corner,
  geometry,
  radius,
  space,
  text,
  weight,
} from "./tokens.stylex";

/**
 * Sections: a label over a group of rows.
 *
 * `label` is the one section label in the app: a Settings group, a side
 * panel section (Agents, Portals, Collaborators, Changes) and the workspace
 * summary's bands all name themselves at the label size, medium weight, in
 * dim ink. Faint is for counts and hints beside it, not for the name.
 *
 * The `panel*` styles are the side panel's grammar: a label over one
 * borderless plate. The plate's fill against the panel is what separates a
 * section, so a section never takes a border. Content sits 12px from the
 * plate's edge: a list pays it as 4 of plate padding plus 8 on the row, a
 * label pays all 12 itself.
 */
export const section = stylex.create({
  label: {
    fontSize: text.label,
    fontWeight: weight.medium,
    color: color.dim,
  },
  panelStack: { display: "grid", gap: space.s6 },
  panelLabel: { paddingInline: space.s12 },
  /** A label with something at its end (a count, an action). */
  panelLabelRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s8,
  },
  panelPlate: {
    display: "grid",
    gap: geometry.hairline,
    overflow: "hidden",
    borderRadius: radius.lg,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.panel,
    padding: space.s4,
  },
});
