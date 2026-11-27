import React from "react";
import {
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "motion/react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "./button";
import { cn } from "./cn";
import { SWIPE_DISTANCE, SWIPE_VELOCITY } from "../lib/swipe-deck";
import {
  color,
  corner,
  geometry,
  layer,
  leading,
  radius,
  shadow,
  space,
  text,
  tracking,
  weight,
} from "./tokens.stylex";

/**
 * The swipe-card mechanics shared by the decks (Support Tinder, catch-up):
 * drag-to-commit with the same distance/velocity thresholds, the
 * rotate-with-drag tilt, the red/green intent stamps, and the directional
 * exit fling. Each deck supplies its own card content as children and maps
 * its actions to fling directions via `exitFor`.
 */

type SwipeExitDir = "left" | "right" | "up" | null;

type SwipeExitStyle = {
  position?: "absolute";
  top?: number;
  left?: number;
  right?: number;
  x: number;
  y: number;
  rotate: number;
  opacity: number;
  transition: { duration: number };
};

export function SwipeCard<A extends string>({
  className,
  custom,
  exitFor,
  exitDistance,
  popOnExit = false,
  stampLeft,
  stampRight,
  onSwipeLeft,
  onSwipeRight,
  children,
}: {
  /** Positioning classes for the card — the deck decides flow vs overlay. */
  className?: string;
  /** The action that dismissed the card (mirrors AnimatePresence `custom`). */
  custom: A | null;
  /** Maps the dismissing action to its fling direction (null = fade in place). */
  exitFor: (a: A | null) => SwipeExitDir;
  /** Px the exiting card travels. */
  exitDistance: number;
  /**
   * Pop the exiting card to absolute for its fling. Needed when the card
   * lives in normal flow (auto height) — otherwise it would hold layout and
   * shove the incoming card down while both are mounted.
   */
  popOnExit?: boolean;
  /** Left-swipe intent stamp (red). */
  stampLeft: string;
  /** Right-swipe intent stamp (green). */
  stampRight: string;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  children: React.ReactNode;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-260, 260], [-9, 9]);
  const leftTint = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
  const rightTint = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);

  function onDragEnd(
    _event: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo,
  ) {
    if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY)
      onSwipeLeft();
    else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY)
      onSwipeRight();
  }

  // Exit is a function variant so AnimatePresence's `custom` (the action
  // taken) picks the fling direction.
  const variants = {
    exit: (a: A | null) => {
      const dir = exitFor(a);
      const style: SwipeExitStyle = {
        x: dir === "left" ? -exitDistance : dir === "right" ? exitDistance : 0,
        y: dir === "up" ? -exitDistance : 0,
        rotate: dir === "left" ? -12 : dir === "right" ? 12 : 0,
        opacity: 0,
        transition: { duration: 0.26 },
      };
      if (popOnExit) {
        style.position = "absolute";
        style.top = 0;
        style.left = 0;
        style.right = 0;
      }
      return style;
    },
  };

  return (
    <motion.div
      className={cn(stylex.props(styles.card).className, className)}
      style={{ x, rotate }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.7}
      onDragEnd={onDragEnd}
      variants={variants}
      initial={{ scale: 0.97, opacity: 0, y: 12 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit="exit"
      custom={custom}
      transition={{ type: "spring", stiffness: 400, damping: 34 }}
    >
      {/* Swipe intent stamps. */}
      <motion.div
        className={stylex.props(styles.stamp, styles.stampLeft).className}
        style={{ opacity: leftTint, rotate: -12 }}
      >
        {stampLeft}
      </motion.div>
      <motion.div
        className={stylex.props(styles.stamp, styles.stampRight).className}
        style={{ opacity: rightTint, rotate: 12 }}
      >
        {stampRight}
      </motion.div>

      {children}
    </motion.div>
  );
}

/**
 * The end-of-deck screen shared by the tinder decks: emoji, headline, a recap
 * of how many cards were dealt with, and a Done button (plus an optional
 * secondary action, e.g. "Deal N kept PRs").
 */
export function DeckDone({
  emoji,
  title,
  message,
  secondary,
  onExit,
}: {
  emoji: string;
  title: string;
  message: string;
  /** Optional extra action rendered before Done. */
  secondary?: { label: string; onClick: () => void };
  onExit: () => void;
}) {
  return (
    <div {...stylex.props(styles.done)}>
      <div {...stylex.props(styles.emoji)}>{emoji}</div>
      <div {...stylex.props(styles.doneTitle)}>{title}</div>
      <div {...stylex.props(styles.doneMessage)}>{message}</div>
      <div {...stylex.props(styles.doneActions)}>
        {secondary && (
          <Button onClick={secondary.onClick}>{secondary.label}</Button>
        )}
        <Button variant="soft" onClick={onExit}>
          Done
        </Button>
      </div>
    </div>
  );
}

const styles = stylex.create({
  card: {
    display: "flex",
    touchAction: "pan-y",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: radius.xl,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.panel,
    boxShadow: shadow.lifted,
  },
  // The red/green word that fades in as a drag leans toward a decision.
  stamp: {
    pointerEvents: "none",
    position: "absolute",
    top: geometry.stampTop,
    zIndex: layer.sticky,
    borderRadius: radius.md,
    ["cornerShape"]: corner.squircle,
    borderWidth: geometry.stampBorder,
    borderStyle: "solid",
    paddingInline: space.s10,
    paddingBlock: space.s4,
    fontSize: text.label,
    fontWeight: weight.bold,
    lineHeight: leading.label,
    letterSpacing: tracking.wide,
  },
  stampLeft: {
    left: geometry.stampInset,
    borderColor: color.red,
    color: color.red,
  },
  stampRight: {
    right: geometry.stampInset,
    borderColor: color.green,
    color: color.green,
  },
  done: {
    display: "flex",
    flex: "1 1 0%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s12,
    paddingInline: space.s24,
    textAlign: "center",
  },
  emoji: { fontSize: text.glyphHero, lineHeight: leading.hero },
  doneTitle: {
    fontSize: text.itemTitle,
    fontWeight: weight.strong,
    color: color.fg,
  },
  doneMessage: {
    maxWidth: geometry.measureNarrow,
    fontSize: text.label,
    lineHeight: leading.label,
    color: color.dim,
  },
  doneActions: { marginTop: space.s8, display: "flex", gap: space.s8 },
});
