import * as React from "react";
import { cn } from "./cn";

/**
 * Badge — a label that reports state, not an action.
 *
 * This is the shape the app kept rebuilding: a dozen surfaces each wrote their
 * own `rounded-* px-1.5 py-0.5 text-meta` chip, and between them they used
 * three radii, four font weights, and six different ways of tinting the same
 * six states (`bg-yellow/15`, `bg-yellow-soft`, and a hand-written
 * `color-mix(… var(--yellow) 16% …)` all appeared for "warning"). Individually
 * each was defensible; together they made one concept look like six.
 *
 * The choices worth knowing:
 *
 *  - `text-meta`, always. A badge sits inside a row it must not outweigh, so
 *    it does not get its own type size or a bolder weight "because this one
 *    matters." The tone carries that.
 *  - `rounded-sm`, matching the majority of what it replaces. A capsule reads
 *    as a control you can press; a badge is not pressable, and the softer rect
 *    also stays concentric inside the `rounded-md`/`rounded-control` boxes these
 *    live in.
 *  - Tones name the *state*, not the colour. A call site asking for `success`
 *    keeps meaning success when the palette moves; one asking for `green`
 *    does not.
 *  - `soft` is the default because a page of outlined chips reads as a form
 *    (see the "do not frame a section in a border" rule in AGENTS.md).
 *    `outline` stays for the few places that sit ON a filled surface, where a
 *    soft fill has nothing to separate itself from.
 *
 * A badge that opens something is not a badge. Use `Button` with `size="sm"`.
 */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
type Variant = "soft" | "outline";

const soft: Record<Tone, string> = {
  neutral: "bg-active text-dim",
  accent: "bg-accent-soft text-accent",
  success: "bg-green-soft text-green",
  warning: "bg-yellow-soft text-yellow",
  danger: "bg-red-soft text-red",
  info: "bg-blue-soft text-blue",
};

// The outline set borrows the tone's own ink for its edge at low strength, so
// a warning chip does not read as a neutral box with yellow text in it.
const outline: Record<Tone, string> = {
  // `text-dim`, not `text-faint`: an outlined chip already gives up the fill
  // that a soft badge reads against, and faint ink on top of that leaves the
  // label barely there — which matters most here, since the neutral outline
  // is the one that carries names (a branch, "current") rather than states.
  neutral: "border border-line text-dim",
  accent: "border border-accent/40 text-accent",
  success: "border border-green/40 text-green",
  warning: "border border-yellow/40 text-yellow",
  danger: "border border-red/40 text-red",
  info: "border border-blue/40 text-blue",
};

export type BadgeProps = React.ComponentPropsWithoutRef<"span"> & {
  tone?: Tone;
  variant?: Variant;
  /** A leading state dot, filled with the tone's ink. */
  dot?: boolean;
};

export function Badge({
  tone = "neutral",
  variant = "soft",
  dot,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5",
        "text-meta whitespace-nowrap",
        variant === "outline" ? outline[tone] : soft[tone],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
