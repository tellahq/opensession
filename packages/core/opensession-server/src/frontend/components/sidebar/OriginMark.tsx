import { BrandMark } from "../BrandMark";
import { brandLogo } from "../../brand-logos";
import { sessionSourceName } from "../../lib/brand";
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
 * Where this row came from, when it came from somewhere else: a Slack thread,
 * a Linear issue. Sessions started in this product's own UI are the default
 * and get no mark, the same way a person's own work needs no author.
 *
 * The pair with [AutoCreatedMark] is deliberate: both answer a question the
 * row raises once the grouping mixes origins into one column, both ride beside
 * the title so the rail keeps its status slot, and both stay in faint ink
 * because the fact is worth keeping on the page without competing with the
 * name. This one is the brand's own logo rather than a drawn glyph, so it is
 * a couple of steps smaller: a filled mark carries more ink per pixel than the
 * 1.5-stroke icon set.
 */
export function OriginMark({ source }: { source?: string | null }) {
  if (!source || source === "opensession" || source === "backstage")
    return null;
  if (!brandLogo(source)) return null;
  const label = `From ${sessionSourceName(source)}`;
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
      aria-label={label}
      title={label}
    >
      <BrandMark name={source} size={13} />
    </span>
  );
}
