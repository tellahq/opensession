import * as stylex from "@stylexjs/stylex";
import { sx } from "./sx";
import {
  color,
  geometry,
  motion,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";

/**
 * Liveness indicators — the pulsing dot and the "Running" pill.
 *
 * Both are yellow, not green: yellow is this app's in-progress tone (the
 * "In progress" lane, the running StatusDot below, the sidebar run clock),
 * while green means a finished, reviewable result — "Ready to merge", an open
 * PR, a passing check. A green dot on running work read as "done" next to
 * those.
 *
 * These were `.working-pill` / `.working-dot` / `.pulse-dot` in the legacy
 * stylesheet, plus five rules that reached in from an ancestor to adjust them
 * (`.viewer-header-compact .working-pill`, `.automations-row .working-pill`,
 * `.msg-busy-inline .pulse-dot`, and a `flex-shrink` fix repeated for
 * `.app-header-title` and `.header-sessionbar`). Those overrides are why this
 * had to become a component rather than a utility swap: a compound selector
 * outranks a single utility class, so the call sites would have kept losing to
 * them. They are props now, or gone:
 *
 *  - the two `flex-shrink: 0` fixes are folded in — a 7px dot should never be
 *    the thing that gives way in a tight row, anywhere;
 *  - `.msg-busy-inline`'s smaller dot is `size={7}`;
 *  - the automations row's truncation is passed in as `className` by the one
 *    caller that wants it;
 *  - `.viewer-header-compact .working-pill` matched nothing (that header shows
 *    a bare dot, never the pill) and is simply dropped.
 *
 * On the animation: the `pulse` keyframes are Tailwind's, not the stylesheet's.
 * Both defined `@keyframes pulse`, Tailwind's sheet is linked second, and
 * keyframes don't cascade by specificity — the last definition wins the whole
 * document. So every legacy `animation: pulse` has in fact been running
 * Tailwind's 0.5 fade rather than the 0.35 it authored. Naming the timing
 * explicitly here keeps exactly what ships today.
 */

const pulse = stylex.keyframes({ "50%": { opacity: 0.5 } });

const styles = stylex.create({
  // The reduced-motion exception rides on the element (`data-pulse`), not on
  // a class name in base.css's list: that blanket kills every animation with
  // !important and hands specific liveness signals back by attribute, so a
  // rename cannot silently freeze the indicator.
  dot: {
    flexShrink: 0,
    borderRadius: radius.pill,
    backgroundColor: color.yellow,
    animationName: pulse,
    animationDuration: motion.pulse,
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  large: { width: geometry.dotLarge, height: geometry.dotLarge },
  standalone: { width: geometry.dot, height: geometry.dot },
  inline: { width: geometry.dotInline, height: geometry.dotInline },
  pill: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s6,
    borderRadius: radius.pill,
    backgroundColor: color.yellowSoft,
    paddingInline: space.s10,
    paddingBlock: geometry.pillPadBlock,
    fontSize: text.meta,
    fontWeight: weight.strong,
    color: color.yellow,
  },
});

const dotStyles = stylex.create({
  dot: {
    width: geometry.dot,
    height: geometry.dot,
    flexShrink: 0,
    borderRadius: radius.pill,
  },
  /** Yellow to match the "In progress" lane: green means "In review". */
  running: {
    backgroundColor: color.yellow,
    animationName: pulse,
    animationDuration: motion.pulse,
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  /** A question for the person: blue, glowing, breathing. */
  waiting: {
    backgroundColor: color.blue,
    boxShadow: shadow.glowBlue,
    animationName: pulse,
    animationDuration: motion.pulseWaiting,
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  /** A stopped run is actionable, but it is not a question for the person. */
  failed: { backgroundColor: color.red, boxShadow: shadow.glowRed },
  idle: { backgroundColor: color.faint },
});

export type StatusDotState = "running" | "waiting" | "failed" | "idle";

/**
 * A session's state as the 8px dot a sidebar row or hover card leads with.
 * The live states breathe, and keep breathing under reduced motion: they
 * carry `data-pulse` (base-theme.css hands them their duration back), with
 * the waiting dot's quicker breath keyed on its value.
 */
export function StatusDot({
  state,
  title,
}: {
  state: StatusDotState;
  title?: string;
}) {
  return (
    <span
      title={title}
      data-pulse={
        state === "running" || state === "waiting" ? state : undefined
      }
      {...stylex.props(dotStyles.dot, dotStyles[state])}
    />
  );
}

export function PulseDot({
  size = 8,
  className,
}: {
  /** 9px on the chat's busy row; 8px standalone; 7px when it sits inside
   * text or the Running pill. */
  size?: 7 | 8 | 9;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-pulse=""
      {...sx(
        [
          styles.dot,
          size === 9
            ? styles.large
            : size === 8
              ? styles.standalone
              : styles.inline,
        ],
        className,
      )}
    />
  );
}

export function WorkingPill({
  children = "Running",
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span {...sx(styles.pill, className)}>
      <PulseDot size={7} />
      {children}
    </span>
  );
}
