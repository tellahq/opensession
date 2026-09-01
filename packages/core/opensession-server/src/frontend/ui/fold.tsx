import { utilityClassName } from "./cn";
import * as React from "react";
import { Collapsible, collapsiblePanelClasses } from "./collapsible";
import { cn } from "./cn";

/**
 * Fold — animates a region's height between open and closed.
 *
 * The session transcript folds whole turns and grouped tool runs: regions
 * whose height is anything from one row to many screens. A fixed-distance
 * animation cannot fit both, so the height here is always MEASURED — Base UI
 * publishes the panel's real height as a custom property and the panel
 * transitions to it, so a 40px run and a 4000px turn take the same motion,
 * each landing exactly where its content says. Content stays mounted through
 * the close transition and unmounts after it, keeping the fold's own perf win.
 *
 * Bring your own trigger: this is the panel half only, for surfaces whose
 * disclosure row is already richer than a title (the turn header carries
 * stats, live status, media labels). For a titled block dropped into a page,
 * `Disclosure` is the opinionated form.
 *
 * Reduced motion is handled globally in base.css, which flattens the
 * transition to ~0ms.
 */
export function Fold({
  open,
  className,
  panelClassName,
  children,
}: {
  open: boolean;
  className?: string;
  panelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible.Root
      open={open}
      className={cn(utilityClassName("min-w-0"), className)}
    >
      <Collapsible.Panel
        className={cn(collapsiblePanelClasses, panelClassName)}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
