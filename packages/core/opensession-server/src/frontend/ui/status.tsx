import { utilityClassName } from "./cn";
import { cn } from "./cn";

/**
 * Liveness indicators — the pulsing dot and the "Running" pill.
 *
 * Both are yellow, not green: yellow is this app's in-progress tone (the
 * "In progress" lane, `SIDEBAR_STATUS_DOT.running`, the sidebar run clock),
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

// The exception rides on the element, not on a class name in base.css's
// reduced-motion list: that blanket kills every animation with !important
// and hands specific liveness signals back by class, so a rename silently
// freezes the indicator. This one cannot be orphaned by a rename.
const PULSE =
  utilityClassName("animate-[pulse_1.4s_ease-in-out_infinite] ") +
  utilityClassName(
    "motion-reduce:[animation-duration:1.4s]! motion-reduce:[animation-iteration-count:infinite]!",
  );

export function PulseDot({
  size = 8,
  className,
}: {
  /** 8px standalone; 7px when it sits inside text or the Running pill. */
  size?: 7 | 8;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        utilityClassName("shrink-0 rounded-full bg-yellow"),
        size === 8
          ? utilityClassName("size-2")
          : utilityClassName("size-[7px]"),
        PULSE,
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
    <span
      className={cn(
        utilityClassName(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-yellow-soft px-2.5 py-[3px] text-meta font-semibold text-yellow",
        ),
        className,
      )}
    >
      <PulseDot size={7} />
      {children}
    </span>
  );
}
