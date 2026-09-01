import { utilityClassName } from "./cn";
import * as React from "react";
import { cn } from "./cn";

/**
 * The waiting spinner: a turning ring, for anything that is fetching,
 * uploading or preparing.
 *
 * It is deliberately not the PixelSpinner. That one is the app's *generating*
 * indicator: the wave a session wears while a model is producing output, so
 * wearing it to fetch a pull request reads as "the agent is working on this"
 * for a PR that has simply not arrived over the network yet. A ring says
 * "waiting", which is the truth on those surfaces.
 *
 * The same ring was hand-rolled in eight places (TurnBlock, PortalPane,
 * PreviewWait, CheckStatusIcon, VoiceInput…) at three different border widths;
 * this is that recipe, once. It inherits `currentColor`, so the caller's text
 * class picks the hue, and base.css keeps `animate-spin` turning under
 * prefers-reduced-motion.
 */
export type SpinnerSize = "sm" | "md" | "lg";

const sizes: Record<SpinnerSize, string> = {
  sm: utilityClassName("size-3 border"),
  md: utilityClassName("size-4 border-2"),
  lg: utilityClassName("size-5 border-2"),
};

export function Spinner({
  size = "sm",
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span"> & { size?: SpinnerSize }) {
  return (
    <span
      aria-hidden
      className={cn(
        utilityClassName(
          "inline-block shrink-0 animate-spin rounded-full border-current/25 border-t-current",
        ),
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
