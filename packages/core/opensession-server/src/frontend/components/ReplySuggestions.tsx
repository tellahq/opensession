import { utilityClassName } from "../ui/cn";
import React from "react";
import { motion } from "motion/react";
import type { ReplySuggestion } from "../lib/reply-suggestions";
import { duration, ease } from "../ui/motion";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../ui/cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  pointerEventsAuto: {
    pointerEvents: "auto",
  },
  shrink0: {
    flexShrink: "0",
  },
});

/**
 * Quick-reply chips above the session composer: the two or three replies the
 * finished turn most likely wants, as 1-2 word pills you can pick instead of
 * typing them out. The server generates them (server/reply-suggestions.ts) and
 * only when the turn actually ended on a choice, so most turns show no row.
 *
 * The row floats over the tail of the transcript rather than sitting in flow
 * between it and the composer. In flow it opened a band of empty page every
 * time a turn ended and closed it again the moment you picked a chip, which
 * moved the composer under your hands for something optional. So it lies on
 * the conversation instead, as glass, and the transcript pays for the rows it
 * covers in bottom padding (SUGGESTIONS_CLEARANCE).
 *
 * Picking one FILLS the composer, it never sends. Two reasons, and neither is
 * timidity: the chip is a guess about what you meant, and the full sentence is
 * the thing you are agreeing to, so you should read it before it becomes your
 * message. The Desk's starter pills made the same call for the same reason
 * (lib/desk-suggestions.ts), and this row deliberately wears their shape.
 *
 * The row retires as soon as you pick one. Picking a second chip would leave
 * two contradictory instructions in one draft ("fix both" under "only step
 * 1"), and replacing instead of appending would eat whatever you had typed.
 */

/**
 * The composer's own material, at the composer's own height off the page.
 *
 * The row sits just above the input and belongs to it, so the two are read
 * together and any difference between them is read as depth. Glass over a blur
 * was that difference: translucent against the input's solid paper, and a
 * tight `sm` cast against its wide `soft` one, which put the pills on a lower
 * plane than the box they lead into. They wear its fill, its edge colour and
 * the same cast at half the scale instead. `md` IS `soft` halved (10/28
 * against 20/56, 10% ink against 12%), which is what a smaller object on the
 * same plane throws: `soft`'s own 20px offset under a 28px pill would put the
 * cast's core below the pill and read as a grey underline rather than a lift.
 *
 * The one thing it does not take from the composer is how faint the hairline
 * is (65% of the edge colour against the composer's 35%). That is the argument
 * `--dialog-ring` makes in base.css: the smaller the box, the more of its
 * shape the outline has to hold, and at the composer's weight a 28px pill on a
 * white page loses its ends.
 *
 * Solid rather than glass also means the answer underneath is covered rather
 * than blurred, so no `backdrop-filter` is needed to keep the label legible.
 *
 * What keeps the row quiet is its ink, not its surface: dim at medium weight,
 * no icon, against the near-black semibold of the transcript's own pills.
 *
 * The 28px height is fixed rather than left to the label, because
 * SUGGESTIONS_CLEARANCE is measured from it and inherited leading would
 * otherwise decide how much of the answer the row covers.
 */
const chip =
  utilityClassName(
    "relative inline-flex h-7 w-full items-center whitespace-nowrap rounded-[999px] px-3 ",
  ) +
  utilityClassName("bg-[var(--composer-surface)] ") +
  utilityClassName(
    "[--smooth-ring-color:var(--composer-border)] smooth-shadow-ring-md ",
  ) +
  utilityClassName(
    "text-label font-medium text-dim transition-[color,scale] ",
  ) +
  utilityClassName("hover:text-fg focus-visible:text-fg active:scale-[0.96] ") +
  // The hover wash layers over the lid rather than replacing it, so it paints
  // on a pseudo-element, which needs the pill's corner treatment of its own:
  // base.css grants `corner-shape` by matching `rounded-*` on an ELEMENT, and
  // a pseudo-element matches no selector.
  utilityClassName(
    "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] ",
  ) +
  utilityClassName(
    "before:[corner-shape:inherit] before:bg-transparent before:transition-colors ",
  ) +
  utilityClassName(
    "before:content-[''] hover:before:bg-hover focus-visible:before:bg-hover ",
  ) +
  utilityClassName(
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
  );

interface Props {
  suggestions: ReplySuggestion[];
  /** Hands back the chip's full text for the composer to receive as a draft. */
  onPick: (text: string) => void;
  className?: string;
}

export function ReplySuggestions({ suggestions, onPick, className }: Props) {
  const rowRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const syncEdges = () => {
      const overflow = row.scrollWidth - row.clientWidth > 1;
      row.toggleAttribute(
        "data-overflow-start",
        overflow && row.scrollLeft > 1,
      );
      row.toggleAttribute(
        "data-overflow-end",
        overflow && row.scrollLeft + row.clientWidth < row.scrollWidth - 1,
      );
    };
    const observer = new ResizeObserver(syncEdges);
    observer.observe(row);
    for (const child of row.children) observer.observe(child);
    row.addEventListener("scroll", syncEdges, { passive: true });
    syncEdges();
    return () => {
      observer.disconnect();
      row.removeEventListener("scroll", syncEdges);
    };
  }, [suggestions]);

  if (!suggestions.length) return null;
  return (
    <div
      ref={rowRef}
      className={cn(
        // One row that scrolls sideways rather than wrapping: a second line
        // costs the transcript real height, and these are optional.
        utilityClassName(
          "flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        ),
        // Fade only the edge with more content. A hard clip beside Next made
        // a complete chip look broken, while the fade says the row scrolls.
        "[--reply-fade-start:#000] [--reply-fade-end:#000] " +
          "data-[overflow-start]:[--reply-fade-start:transparent] data-[overflow-end]:[--reply-fade-end:transparent] " +
          utilityClassName(
            "[-webkit-mask-image:linear-gradient(to_right,var(--reply-fade-start)_0,#000_16px,#000_calc(100%_-_16px),var(--reply-fade-end)_100%)] ",
          ) +
          utilityClassName(
            "[mask-image:linear-gradient(to_right,var(--reply-fade-start)_0,#000_16px,#000_calc(100%_-_16px),var(--reply-fade-end)_100%)]",
          ),
        // The caller floats this over the transcript, so the row spans the
        // whole column while the chips fill only part of it. Nothing but the
        // chips may take a click: the rest of that band is transcript you
        // should still be able to select and reach.
        utilityClassName("pointer-events-none"),
        className,
      )}
    >
      {suggestions.map((s, i) => (
        // The animation rides a wrapper rather than the button itself: the
        // button is Base UI's tooltip trigger, which renders INTO the element
        // it is given, and a motion component there is the one case where its
        // injected props are known to get lost.
        <motion.div
          key={`${s.label}-${i}`}
          {...stylex.props(sx.pointerEventsAuto, sx.shrink0)}
          // The row arrives seconds after the turn ends, so it fades in from
          // its own size rather than sliding: something appearing above the
          // composer while you are reading should not also move. The small
          // stagger reads as one row settling rather than four arrivals.
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.base, ease, delay: i * 0.04 }}
        >
          <Tooltip label={s.text} side="top" multiline>
            <button
              type="button"
              className={chip}
              onClick={() => onPick(s.text)}
              // The label is the short form; the sentence it stands for is
              // what lands in the draft, so name it for a screen reader
              // rather than leaving that to the hover tooltip.
              aria-label={s.text}
            >
              {s.label}
            </button>
          </Tooltip>
        </motion.div>
      ))}
    </div>
  );
}
