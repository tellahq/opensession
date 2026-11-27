import * as stylex from "@stylexjs/stylex";
import { cn } from "../../ui/cn";
import { focusStyles } from "../../ui/focus-styles";
import type { Styles } from "../../ui/sx";
import { color, corner, media, motion, radius } from "../../ui/tokens.stylex";
import { Tooltip } from "../../ui/tooltip";
import { IconInbox, IconPlus } from "../icons";

/** Inbox-plus mark shared by sidebar rows and the top bar. */
export function KeepInSidebarIcon({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <IconInbox size={20} />
      <span
        aria-hidden="true"
        className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-accent text-on-accent ring-2 ring-panel"
      >
        <IconPlus size={9} />
      </span>
    </span>
  );
}

const styles = stylex.create({
  mark: {
    position: "relative",
    flexShrink: 0,
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    ["cornerShape"]: corner.squircle,
    color: {
      default: color.faint,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    scale: {
      default: null,
      ":active": { default: motion.pressScale, [media.reducedMotion]: null },
    },
    transitionProperty: "color, scale",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
});

/**
 * The inline claim affordance for a row that is visible but not yet kept.
 * `xstyle` is the row's chip (its box, slot and reveal), merged in the same
 * StyleX call so it out-ranks the mark's own position by argument order.
 */
export function KeepInSidebarMark({
  onKeep,
  label = "Keep in sidebar",
  xstyle,
  onMouseEnter,
}: {
  onKeep: () => void;
  label?: string;
  xstyle: Styles;
  onMouseEnter?: () => void;
}) {
  const keep = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    onKeep();
  };
  return (
    <Tooltip label={label}>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        data-sidebar-keep=""
        {...stylex.props(styles.mark, focusStyles.ring, xstyle)}
        onClick={keep}
        onMouseEnter={onMouseEnter}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onTouchEnd={keep}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") keep(event);
        }}
      >
        <KeepInSidebarIcon />
      </span>
    </Tooltip>
  );
}
