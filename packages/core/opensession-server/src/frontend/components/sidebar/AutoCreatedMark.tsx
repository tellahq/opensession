import { IconRobot } from "../icons";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  ml1: {
    marginLeft: "4px",
  },
  flex: {
    display: "flex",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

/**
 * A row nobody started in a composer: an automation run, a report's Fix task,
 * or a session an agent minted itself. Faint ink keeps the origin visible
 * without competing with status. It rides beside the title so the status rail
 * stays aligned with every ordinary row.
 */
export function AutoCreatedMark() {
  return (
    <span
      {...stylex.props(
        sx.ml1,
        sx.flex,
        sx.shrink0,
        sx.itemsCenter,
        sx.textFaint,
      )}
      role="img"
      aria-label="Started by an agent, not by a person"
      title="Started by an agent, not by a person"
    >
      <IconRobot size={20} />
    </span>
  );
}
