import React from "react";
import { motion } from "motion/react";
import { cn } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { Tooltip } from "../ui/tooltip";
import { IconX } from "./icons";

/** Per-tone colour, spelled out in full: Tailwind scans source as text, so a
 *  class assembled from the tone name would never be generated. Neutral keeps
 *  an edge against the plain composer. Note and Ask use their tinted fills
 *  alone for cleaner labels on the matching composer washes. */
const CHIP_TONE = {
  neutral: {
    box: "border border-line/60 bg-surface text-fg",
    icon: "text-faint opacity-60",
    remove: "text-faint enabled:hover:text-fg",
  },
  note: {
    box: "bg-[color-mix(in_srgb,var(--yellow-tint)_18%,transparent)] text-yellow",
    icon: "text-yellow",
    remove: "text-yellow/60 enabled:hover:text-yellow",
  },
  ask: {
    box: "bg-[color-mix(in_srgb,var(--green)_18%,transparent)] text-green",
    icon: "text-green",
    remove: "text-green/60 enabled:hover:text-green",
  },
} as const;

/**
 * The row of context that sits directly above the composer's field: a small
 * pill naming something attached to the next send, with an ✕ that detaches it.
 *
 * Three things live here: the transcript selection ("Selected text"), note
 * mode ("Team note") and ask mode ("Ask"). They are the same object as
 * far as a reader is concerned, *this composer is not in its ordinary state,
 * and here is what that state is*, so they share one shape rather than each
 * inventing a marker. That is also what keeps two tinted surfaces apart: the
 * wash says something is different, the chip says which, and no state paints
 * the box without naming itself here.
 *
 * The ✕ is optional, because it has to be honest. Ask mode's exit cuts a
 * worktree and only the server can say whether this session may promote at
 * all; where it cannot, the chip renders as a label with no ✕ rather than
 * offering an exit that does not exist.
 */
export function ComposerContextChip({
  icon,
  label,
  meta,
  title,
  tone = "neutral",
  onRemove,
  removeLabel,
  disabled,
}: {
  /** Leading glyph, sized by the caller (15px is the house size here). */
  icon: React.ReactNode;
  label: string;
  /** Optional compact detail shown after the label, e.g. "+20 lines". */
  meta?: string;
  /** Text shown in the shared tooltip instead of a native `title` popup. */
  title?: string;
  /** `note` and `ask` tint the pill, because each sits on a surface that is
   *  already tinted in its own ink: a neutral chip on the yellow or green
   *  writing surface reads as a hole in it rather than as a label on it. */
  tone?: keyof typeof CHIP_TONE;
  /** Omit to render the chip as a label. See the note on the ✕ above. */
  onRemove?: () => void;
  /** Accessible name for the ✕: "Remove selected text", "Leave note mode". */
  removeLabel?: string;
  disabled?: boolean;
}) {
  const colours = CHIP_TONE[tone];
  const chip = (
    <div
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1 rounded-full px-2 text-label font-medium",
        colours.box,
      )}
    >
      {/* No optical nudge on either glyph. Every icon this chip carries is
			    drawn on the shared 24 grid with its ink centred (IconEye, IconNote,
			    IconX all span 4.75-19.25 about y=12), and a brand tile is a solid
			    square, so a translate here only pushes the mark off the row's
			    centre: measured, it sat 1px below while the label's ink sat 0.5px
			    above, which is the 1.5px step you can see at Retina. */}
      <span className={cn("inline-flex shrink-0 items-center", colours.icon)}>
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {meta && <span className="shrink-0 font-normal text-faint">{meta}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={removeLabel}
          className={cn(
            // `before:-inset-2` grows the hit area past the 20px box without
            // growing the pill around it.
            "relative -mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center before:absolute before:-inset-2 enabled:active:scale-press enabled:transition-[color,transform] disabled:cursor-default disabled:opacity-50",
            colours.remove,
          )}
        >
          <IconX size={20} className="scale-[0.8] [&_path]:stroke-2" />
        </button>
      )}
    </div>
  );
  return (
    // Two boxes, because the chip is what changes the composer's height and
    // the composer no longer animates its own size (see the note on the box
    // in Composer.tsx). The outer one collapses its height, so the composer
    // grows and shrinks with the chip on every frame rather than snapping
    // once the ✕ has already faded the chip out; `overflow-hidden` both clips
    // the collapse and keeps the inner margin inside the measured height. The
    // inner one carries the chip's own arrival.
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: "tween", duration: duration.base, ease }}
      className="overflow-hidden"
    >
      <motion.div
        initial={{ y: 2, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        transition={{ type: "tween", duration: duration.micro, ease }}
        className="mb-1 flex origin-left"
      >
        {title ? <Tooltip label={title}>{chip}</Tooltip> : chip}
      </motion.div>
    </motion.div>
  );
}
