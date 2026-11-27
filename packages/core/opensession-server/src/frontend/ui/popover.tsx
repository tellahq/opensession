import * as React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { popup } from "./popup-styles";
import { sx } from "./sx";
import {
  color,
  corner,
  geometry,
  media,
  motion,
  radius,
  shadow,
} from "./tokens.stylex";

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";
const onSide = (s: string) => `:is([data-side=${s}])`;

const styles = stylex.create({
  surface: {
    borderRadius: radius.popup,
    ["cornerShape"]: corner.squircle,
    outline: {
      default: "none",
      [media.forcedColors]: shadow.ringForced,
    },
    outlineOffset: {
      default: null,
      [media.forcedColors]: shadow.ringForcedOffset,
    },
    backgroundColor: color.popupGlass,
    backdropFilter: "var(--popup-blur)",
    transformOrigin: "var(--transform-origin)",
    transitionProperty: { default: "scale, opacity", [ENDING]: "none" },
    transitionDuration: motion.popup,
    transitionTimingFunction: motion.easeOut,
    scale: { default: null, [STARTING]: motion.popupScale },
    opacity: { default: null, [STARTING]: 0, [ENDING]: 0 },
  },
  // The ring override rides on the popup so the arrow, which continues that
  // hairline, inherits the same value.
  ringDefault: { "--smooth-ring-color": color.popupRing },
  ringSoft: {
    "--smooth-ring-color": `color-mix(in srgb, ${color.popupRing} 65%, ${color.popup})`,
  },
  sm: { boxShadow: shadow.ringSm },
  md: { boxShadow: shadow.ringMd },
  lg: { boxShadow: shadow.ringLg },
  arrow: {
    width: geometry.arrow,
    height: geometry.arrow,
    rotate: "45deg",
    borderStyle: "solid",
    borderWidth: 0,
    borderColor: "var(--smooth-ring-color)",
    backgroundColor: color.popupGlass,
    backdropFilter: "var(--popup-blur)",
    left: { default: null, [onSide("right")]: geometry.arrowHangRight },
    right: { default: null, [onSide("left")]: geometry.arrowHang },
    bottom: { default: null, [onSide("top")]: geometry.arrowHang },
    top: { default: null, [onSide("bottom")]: geometry.arrowHang },
    borderTopWidth: {
      default: null,
      [onSide("left")]: geometry.hairline,
      [onSide("bottom")]: geometry.hairline,
    },
    borderRightWidth: {
      default: null,
      [onSide("left")]: geometry.hairline,
      [onSide("top")]: geometry.hairline,
    },
    borderBottomWidth: {
      default: null,
      [onSide("right")]: geometry.hairline,
      [onSide("top")]: geometry.hairline,
    },
    borderLeftWidth: {
      default: null,
      [onSide("right")]: geometry.hairline,
      [onSide("bottom")]: geometry.hairline,
    },
    clipPath: {
      default: null,
      [onSide("right")]: "polygon(14% 0, 0 0, 0 100%, 100% 100%, 100% 86%)",
      [onSide("left")]: "polygon(0 0, 100% 0, 100% 100%, 86% 100%, 0 14%)",
      [onSide("top")]: "polygon(100% 0, 100% 100%, 0 100%, 0 86%, 86% 0)",
      [onSide("bottom")]: "polygon(0 0, 100% 0, 100% 14%, 14% 100%, 0 100%)",
    },
  },
});
import { useExclusivePopup, useExclusivePopupDelay } from "./exclusive-popups";
import {
  DeferredPopupRootContext,
  useDeferredPopupRoot,
  useLazyPopupRoot,
} from "./popup-arming";
import { DeferredPopupTrigger } from "./popup-arming-region";

/**
 * Popover on Base UI parts, styled with Tailwind tokens. Composable shape —
 * consumers assemble Root/Trigger/Popup. Pass `openOnHover` on the Trigger for
 * hover-card behavior; the trigger stays a real button, so touch devices open
 * it with a tap (hover-only affordances are unreachable on iOS).
 *
 * Like ui/menu.tsx this animates with CSS transitions on Base UI's
 * [data-starting-style]/[data-ending-style] lifecycle attributes rather than a
 * Motion render prop, keeping the injected a11y attributes intact.
 * Roots also close the previously open popover through an imperative registry;
 * Base UI does not provide tooltip-style delay grouping for hover popovers.
 */

function Trigger({
  className,
  delay,
  ...props
}: Omit<React.ComponentProps<typeof BasePopover.Trigger>, "className"> & {
  className?: string;
}) {
  const groupedDelay = useExclusivePopupDelay(delay);
  const deferred = useDeferredPopupRoot();
  if (deferred) {
    const {
      render,
      openOnHover,
      closeDelay,
      handle,
      payload,
      nativeButton,
      style,
      ...domProps
    } = props;
    return (
      <DeferredPopupTrigger
        haspopup="dialog"
        onOpen={deferred.open}
        render={render}
        state={{ open: false, disabled: Boolean(domProps.disabled) }}
        props={{ ...domProps, className }}
      />
    );
  }
  return (
    <BasePopover.Trigger
      {...props}
      delay={groupedDelay}
      className={className}
    />
  );
}

/** Inside an unarmed PopupArmingRegion (ui/popup-arming.ts) the root waits:
 *  its trigger is a plain button and its popup is not rendered until the
 *  region arms or the button is clicked. A controlled root never waits. */
function Root<Payload = unknown>(
  props: BasePopover.Root.Props<Payload> & {
    /** Keep false for a popover nested inside another popup. Opening a child
     * should not dismiss the parent that owns its trigger. */
    exclusive?: boolean;
  },
) {
  const { deferred, openOnMount } = useLazyPopupRoot(props.open);
  const { children } = props;
  if (deferred && !(children instanceof Function))
    return (
      <DeferredPopupRootContext value={deferred}>
        {children}
      </DeferredPopupRootContext>
    );
  return (
    <DeferredPopupRootContext value={null}>
      <LiveRoot {...props} defaultOpen={props.defaultOpen || openOnMount} />
    </DeferredPopupRootContext>
  );
}

function LiveRoot<Payload = unknown>({
  actionsRef,
  onOpenChange,
  exclusive = true,
  ...props
}: BasePopover.Root.Props<Payload> & {
  exclusive?: boolean;
}) {
  const internalActionsRef = React.useRef<BasePopover.Root.Actions | null>(
    null,
  );
  const resolvedActionsRef = actionsRef ?? internalActionsRef;
  const entry = { close: () => resolvedActionsRef.current?.close() };
  const group = useExclusivePopup(entry);

  return (
    <BasePopover.Root
      {...props}
      actionsRef={resolvedActionsRef}
      onOpenChange={(open, eventDetails) => {
        if (exclusive) {
          if (open) group?.activate(entry);
          else group?.deactivate(entry);
        }
        onOpenChange?.(open, eventDetails);
      }}
    />
  );
}

function Popup({
  className,
  positionerClassName,
  portalContainer,
  positionMethod,
  side,
  align,
  sideOffset = 8,
  alignOffset = 0,
  collisionPadding = 8,
  collisionBoundary,
  arrow = false,
  elevation = "md",
  ring = "default",
  anchor,
  initialFocus = false,
  finalFocus,
  "aria-label": ariaLabel,
  children,
}: {
  className?: string;
  /** Override the portal layer for standing page-level surfaces that should
   * sit behind modal and palette backdrops. */
  positionerClassName?: string;
  /** Render the positioner inside a moving layout ancestor. This keeps a popup
   * attached by normal browser layout when that whole ancestor moves. */
  portalContainer?: React.ComponentProps<
    typeof BasePopover.Portal
  >["container"];
  positionMethod?: React.ComponentProps<
    typeof BasePopover.Positioner
  >["positionMethod"];
  side?: React.ComponentProps<typeof BasePopover.Positioner>["side"];
  align?: React.ComponentProps<typeof BasePopover.Positioner>["align"];
  sideOffset?: number;
  /** Shift the popup along its alignment axis. */
  alignOffset?: React.ComponentProps<
    typeof BasePopover.Positioner
  >["alignOffset"];
  /** Space kept between the popup and viewport clipping edges. Increase this
   * when a wide shadow needs more room than the compact-popover default. */
  collisionPadding?: React.ComponentProps<
    typeof BasePopover.Positioner
  >["collisionPadding"];
  /** The area the popup must stay inside. Defaults to its clipping
   * ancestors; pass an element to keep it within one region of the page. */
  collisionBoundary?: React.ComponentProps<
    typeof BasePopover.Positioner
  >["collisionBoundary"];
  /** Draw a callout diamond pointing back at the anchor, bridging
   * `sideOffset`. Matches the sidebar's legacy hover card, so a popup that
   * sits beside one of those reads as the same object. */
  arrow?: boolean;
  /** Choose a quieter or wider cast shadow for the popup's visual weight. */
  elevation?: "sm" | "md" | "lg";
  /** How firm the popup's hairline is. `soft` walks the ring toward the
   * popup's own surface, for a big card of quiet rows where the default edge
   * draws a box around them. Mixed toward the surface rather than faded to
   * transparent, so the edge keeps its direction in both themes: in light the
   * line lightens toward the paper, and in dark it stays brighter than the
   * fill it lifts off instead of falling under it into a seam. */
  ring?: "default" | "soft";
  /** Position against something other than the Trigger — pass the wrapper of a
   * control cluster whose popup opens from several places (a caret, a
   * right-click, a disabled button), so the popup keeps one anchor no matter
   * which of them opened it. */
  anchor?: React.ComponentProps<typeof BasePopover.Positioner>["anchor"];
  /** Defaults to false: most popups here are hover preview cards, and yanking
   * focus out of the page on hover would be hostile. Pass `true` for a
   * click-opened popup that holds controls, so the keyboard reaches them. */
  initialFocus?: React.ComponentProps<typeof BasePopover.Popup>["initialFocus"];
  finalFocus?: React.ComponentProps<typeof BasePopover.Popup>["finalFocus"];
  "aria-label"?: string;
  children: React.ReactNode;
}) {
  if (useDeferredPopupRoot()) return null;
  return (
    <BasePopover.Portal container={portalContainer}>
      <BasePopover.Positioner
        positionMethod={positionMethod}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={collisionPadding}
        collisionBoundary={collisionBoundary}
        // Keep the diamond clear of the popup's rounded corners.
        arrowPadding={14}
        {...sx(popup.positioner, positionerClassName)}
      >
        <BasePopover.Popup
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          aria-label={ariaLabel}
          {...sx(
            [
              styles.surface,
              ring === "soft" ? styles.ringSoft : styles.ringDefault,
              styles[elevation],
            ],
            className,
          )}
        >
          {arrow && (
            // A square rotated onto its point, half of it hanging off the
            // popup edge: the outward two borders continue the popup's
            // hairline. Base UI sets the cross-axis offset inline; the
            // main-axis one is ours.
            //
            // The clip is what lets the arrow be glass. Unclipped, its
            // inner half lies ON the popup, and two thinned fills stacked
            // composite brighter than one — the whole diamond shows
            // through the card as a wedge, which is exactly the seam a
            // pointer is meant not to have. Clipped to the half that
            // hangs off, arrow and popup tile edge to edge and read as
            // one sheet of glass. Each polygon is that half plus a ~1px
            // sliver past the diagonal, so the arrow's own fill covers
            // the popup's hairline where it would otherwise draw a line
            // across the arrow's base.
            <BasePopover.Arrow {...stylex.props(styles.arrow)} />
          )}
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

export const Popover = {
  Root,
  Trigger,
  Close: BasePopover.Close,
  Popup,
};
