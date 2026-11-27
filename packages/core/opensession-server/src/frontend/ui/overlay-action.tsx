import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { Button, type ButtonProps } from "./button";
import { overlayActionMarker } from "./markers.stylex";
import { color, layer, media, space } from "./tokens.stylex";

export type OverlayActionProps = Omit<ButtonProps, "size" | "variant">;

/**
 * Spread on the preview an `OverlayAction` belongs to (with `relative`):
 * hovering it reveals the action. A marker rather than Tailwind's
 * `group/overlay-action`, so the action answers to its own preview only.
 */
export const OVERLAY_ACTION_HOST =
  stylex.props(overlayActionMarker).className ?? "";

const styles = stylex.create({
  // White in both themes, so the action stays distinct from any image or
  // colour under it.
  action: {
    position: "absolute",
    right: `calc(-1 * ${space.s8})`,
    top: `calc(-1 * ${space.s8})`,
    zIndex: layer.overPreview,
    backgroundColor: color.overlaySurface,
    transitionProperty: "opacity, scale",
    // Pointer devices reveal it on hover; keyboard focus always does; touch
    // has no hover path, so it stays visible there.
    opacity: {
      default: null,
      [media.hover]: 0,
      ":focus-visible": 1,
      [stylex.when.ancestor(":hover", overlayActionMarker)]: {
        default: null,
        [media.hover]: 1,
      },
    },
    pointerEvents: {
      default: null,
      [media.hover]: "none",
      ":focus-visible": "auto",
      [stylex.when.ancestor(":hover", overlayActionMarker)]: {
        default: null,
        [media.hover]: "auto",
      },
    },
  },
});

/** A compact action over the top-right corner of a visual preview. */
export const OverlayAction = React.forwardRef<
  HTMLButtonElement,
  OverlayActionProps
>(function OverlayAction(props, ref) {
  return (
    <Button
      ref={ref}
      variant="default"
      size="sm"
      skin={styles.action}
      {...props}
    />
  );
});
