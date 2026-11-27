import * as React from "react";
import { IconChevronRight } from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import { Collapsible, collapsible } from "./collapsible";
import { focusStyles } from "./focus-styles";
import { disclosureMarker } from "./markers.stylex";
import { sx } from "./sx";
import {
  color,
  corner,
  media,
  motion,
  radius,
  space,
  text,
  weight,
} from "./tokens.stylex";

const styles = stylex.create({
  root: { minWidth: 0 },
  head: {
    display: "flex",
    minWidth: 0,
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space.s12,
    rowGap: space.s6,
  },
  // The negative margin lets the row's hover wash bleed past the text
  // without indenting the title away from the content it labels.
  trigger: {
    marginInline: `calc(-1 * ${space.s8})`,
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s6,
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    paddingInline: space.s8,
    paddingBlock: space.s4,
    fontSize: text.label,
    fontWeight: weight.strong,
    color: color.fg,
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  chevron: {
    flexShrink: 0,
    color: color.faint,
    transitionProperty: "transform, translate, scale, rotate",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    rotate: {
      default: null,
      [stylex.when.ancestor(":is([data-panel-open])", disclosureMarker)]:
        "90deg",
    },
  },
  title: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  body: { paddingTop: space.s12 },
});

/**
 * Disclosure — a titled block that opens and closes in place.
 *
 * For reference material that a surface should offer without spending its
 * first screen on: a provider's setup recipe, a generated config snippet, the
 * long tail of options behind a form. The closed state is one quiet row, so
 * the thing the person actually came to do stays above the fold.
 *
 * Built on Base UI's Collapsible rather than a raw `<details>`: the panel's
 * height is measured, so the block animates open instead of snapping, and the
 * trigger keeps its aria-expanded/aria-controls wiring. Reduced motion is
 * handled globally in base.css, which flattens the transition to ~0ms.
 *
 * `actions` sits BESIDE the trigger, never inside it. A disclosure's shoulder
 * usually carries a link out to whatever it documents, and an `<a>` nested in
 * a `<button>` is neither valid nor clickable.
 */
export function Disclosure({
  title,
  actions,
  defaultOpen,
  className,
  panelClassName,
  children,
}: {
  title: React.ReactNode;
  /** Rendered on the trigger's right, outside its hit area. */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  panelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} {...sx(styles.root, className)}>
      <div {...stylex.props(styles.head)}>
        <Collapsible.Trigger
          {...stylex.props(styles.trigger, focusStyles.ring, disclosureMarker)}
        >
          <IconChevronRight size={20} {...stylex.props(styles.chevron)} />
          <span {...stylex.props(styles.title)}>{title}</span>
        </Collapsible.Trigger>
        {actions}
      </div>
      <Collapsible.Panel {...sx(collapsible.panel, panelClassName)}>
        <div {...stylex.props(styles.body)}>{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
