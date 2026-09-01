import { utilityClassName } from "./cn";
/**
 * Copy-to-clipboard feedback primitives.
 *
 * Two flavours of "you copied it" confirmation, sharing one animated checkmark:
 *   - `useCopy()` + `toast` for a floating message ("Link copied").
 *   - `<CopyCheck>` for the subtle inline swap — a button's link/copy glyph
 *     morphs into a drawing checkmark for a beat, then swaps back.
 *
 * Open Session is served over plain HTTP on the tailnet, so clipboard writes go
 * through `copyToClipboard` (secure-context aware, hidden-textarea fallback).
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { MIN_ICON_SIZE } from "../components/icons";
import { copyToClipboard, shareOrCopyLink } from "../lib/share-link";
import { cn } from "./cn";
import { toast as fireToast } from "./toast";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  colStart1: {
    gridColumnStart: "1",
  },
  rowStart1: {
    gridRowStart: "1",
  },
  grid: {
    display: "grid",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
});

/**
 * A checkmark that draws itself on mount — the shared "success" gesture used by
 * both the toast and the inline swap. Same path as IconCheck so it reads as the
 * same mark, but rendered as a motion.path so the stroke can animate in.
 */
export function AnimatedCheck({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <motion.path
        d="M5.75 12.75L9.5 16.25L18.25 7.75"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{
          pathLength: { type: "spring", duration: 0.4, bounce: 0 },
          opacity: { duration: 0.08 },
        }}
      />
    </svg>
  );
}

/**
 * Inline copy affordance: shows `idle` normally, and cross-fades to a drawing
 * checkmark while `copied` is true. Pop the two states with AnimatePresence so
 * the check scales/rotates in and the resting glyph fades back when it resets.
 */
export function CopyCheck({
  copied,
  idle,
  size = MIN_ICON_SIZE,
  className,
  checkClassName,
}: {
  copied: boolean;
  /** The resting glyph (e.g. <IconLink/> or <IconCopy/>). */
  idle: React.ReactNode;
  size?: number;
  className?: string;
  /** Extra classes for the check state (default tints it green). */
  checkClassName?: string;
}) {
  // The same floor components/icons.tsx clamps every glyph to. This box is
  // drawn around one of them, so a caller asking for 14 or 15 used to get a
  // box smaller than the icon it holds: the glyph overflowed to the right and
  // bottom, and a button centring the box put the ink visibly off-centre.
  // Sizing the box below the icon is not a smaller icon, it is a broken one.
  const box = Math.max(size, MIN_ICON_SIZE);
  return (
    <span
      className={cn(
        utilityClassName("relative inline-grid place-items-center"),
        className,
      )}
      style={{ width: box, height: box }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {copied ? (
          <motion.span
            key="check"
            className={cn(
              utilityClassName(
                "col-start-1 row-start-1 grid place-items-center text-green",
              ),
              checkClassName,
            )}
            initial={{ opacity: 0, scale: 0.4, rotate: -12 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ type: "spring", duration: 0.32, bounce: 0.4 }}
          >
            <AnimatedCheck size={box} />
          </motion.span>
        ) : (
          <motion.span
            key="idle"
            {...stylex.props(
              sx.colStart1,
              sx.rowStart1,
              sx.grid,
              sx.placeItemsCenter,
            )}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ type: "spring", duration: 0.28, bounce: 0.2 }}
          >
            {idle}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export type UseCopyOptions = {
  /** How long the `copied` flag stays true (drives the inline swap). */
  resetMs?: number;
};

/**
 * Clipboard-copy with feedback state. `copied` flips true for `resetMs` after a
 * successful copy (for a <CopyCheck/> or a label swap); pass `toast` to also
 * fire a floating message.
 *
 *   const { copied, copy } = useCopy();
 *   <button onClick={() => copy(link, { toast: "Link copied" })}>
 *     <CopyCheck copied={copied} idle={<IconLink />} />
 *   </button>
 */
export function useCopy(opts: UseCopyOptions = {}) {
  const resetMs = opts.resetMs ?? 1600;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Don't setState after the button unmounts (a copy flash can outlive it).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const flash = (o: { toast?: string | boolean } = {}) => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), resetMs);
    if (o.toast) fireToast(o.toast === true ? "Link copied" : o.toast);
  };

  const copy = (text: string, o: { toast?: string | boolean } = {}) => {
    copyToClipboard(text, () => flash(o));
  };

  /**
   * Share-button behavior: native share sheet on touch devices, copy (with
   * the usual feedback) everywhere else. The `copied` flash only fires on
   * the copy path — the sheet is its own confirmation.
   */
  const share = (
    link: string,
    o: { toast?: string | boolean; title?: string } = {},
  ) => {
    shareOrCopyLink(link, { title: o.title, onCopied: () => flash(o) });
  };

  return { copied, copy, share };
}
