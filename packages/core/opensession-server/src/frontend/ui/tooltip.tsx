import { utilityClassName } from "./cn";
import * as React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "./cn";
import { ExclusivePopupProvider } from "./exclusive-popups";
import { FLOATING_OVERLAY_LAYER } from "./popup-classes";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  inlineFlex: {
    display: "inline-flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3px: {
    gap: "3px",
  },
  h4: {
    height: "calc(4px * 4)",
  },
  minW4: {
    minWidth: "calc(4px * 4)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px3px: {
    paddingInline: "3px",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  FontFamilyInherit: {
    fontFamily: "inherit",
  },
  bgWhite20: {
    backgroundColor: "color-mix(in oklab, var(--color-white) 20%, transparent)",
  },
  textWhite75: {
    color: "color-mix(in oklab, var(--color-white) 75%, transparent)",
  },
});

/**
 * Tooltip on Base UI (Tooltip.Root/Trigger/Positioner/Popup), styled with
 * Tailwind tokens. First component of the ui/ layer —
 * the pattern to copy for new primitives: Base UI parts for behavior
 * (positioning, collision flip, focus/hover semantics, a11y), our classes via
 * cn() with className passthrough.
 *
 * Keeps the exact API of the old hand-rolled components/Tooltip.tsx
 * (label/side/offset/shortcut, single-element child, no wrapper DOM) so call
 * sites didn't change. Open delay + instant group hand-off between adjacent
 * triggers come from <TooltipProvider> at the app root.
 *
 * Animation follows Base UI's lifecycle attributes. In particular,
 * data-instant disables transitions while the provider hands off between two
 * triggers, so the outgoing tooltip cannot remain visible beside the new one.
 */

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/** Mount once at the app root: shared 200ms open delay, and for 300ms after a
 * tooltip closes, neighbouring triggers open instantly (toolbar sweep). */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <BaseTooltip.Provider delay={200} timeout={300}>
      <ExclusivePopupProvider>{children}</ExclusivePopupProvider>
    </BaseTooltip.Provider>
  );
}

export function Tooltip({
  label,
  side = "top",
  align = "center",
  offset = 8,
  shortcut,
  multiline,
  popupClassName,
  children,
}: {
  label: React.ReactNode;
  side?: Side;
  /** Where along `side` the popup sits. "start" keeps it by the trigger's
   *  leading edge — right for a wide block trigger, where centering would
   *  float the tip far from whatever the cursor is actually over. */
  align?: Align;
  offset?: number;
  /** Optional keyboard-shortcut badges, e.g. ["⌘", "S"]. */
  shortcut?: string[];
  /** Wrap long content instead of the default single nowrap line. */
  multiline?: boolean;
  /** Extend the shared popup surface for richer tooltip content. */
  popupClassName?: string;
  children: React.ReactElement;
}) {
  if (!label) return children;

  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal
        // Base UI otherwise inherits a containing popup's portal target. Mount
        // tooltips at the page root so their floating layer can sit above that
        // popup instead of being trapped inside its stacking context.
        container={typeof document !== "undefined" ? document.body : undefined}
      >
        <BaseTooltip.Positioner
          side={side}
          align={align}
          sideOffset={offset}
          collisionPadding={6}
          className={FLOATING_OVERLAY_LAYER}
        >
          <BaseTooltip.Popup
            className={cn(
              utilityClassName("pointer-events-none flex items-center gap-2"),
              utilityClassName(
                "origin-[var(--transform-origin)] transition-[transform,opacity] duration-[120ms] ease-out",
              ),
              "data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0",
              "data-[ending-style]:opacity-0 data-[instant]:transition-none",
              // 13px medium text on a near-black chip with
              // its soft `shadow-popup` + our theme ring.
              utilityClassName(
                "rounded-panel bg-tooltip px-2 py-1 text-label leading-snug font-medium text-tooltip-fg",
              ),
              "shadow-[0px_10px_38px_-10px_rgba(14,18,22,0.35),0px_10px_20px_-15px_rgba(14,18,22,0.2),0_0_0_1px_var(--tooltip-ring)]",
              multiline
                ? utilityClassName(
                    "max-w-[360px] items-start whitespace-pre-wrap",
                  )
                : utilityClassName("max-w-[280px] whitespace-nowrap"),
              popupClassName,
            )}
          >
            <span
              className={cn(
                multiline
                  ? utilityClassName("max-h-[50vh] overflow-y-auto")
                  : utilityClassName("overflow-hidden text-ellipsis"),
              )}
            >
              {label}
            </span>
            {shortcut && shortcut.length > 0 && (
              <span {...stylex.props(sx.inlineFlex, sx.itemsCenter, sx.gap3px)}>
                {shortcut.map((k, i) => (
                  <kbd
                    key={i}
                    {...stylex.props(
                      sx.inlineFlex,
                      sx.h4,
                      sx.minW4,
                      sx.itemsCenter,
                      sx.justifyCenter,
                      sx.roundedSm,
                      sx.px3px,
                      sx.textXs,
                      sx.fontMedium,
                      sx.FontFamilyInherit,
                      sx.bgWhite20,
                      sx.textWhite75,
                    )}
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            )}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
