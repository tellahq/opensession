import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { Collapsible, collapsible } from "./collapsible";
import { sx } from "./sx";

const styles = stylex.create({ root: { minWidth: 0 } });

/**
 * Fold — animates a region's height between open and closed.
 *
 * The session transcript folds whole turns and grouped tool runs: regions
 * whose height is anything from one row to many screens. A fixed-distance
 * animation cannot fit both, so Base UI measures the panel for its open/close
 * keyframes. At rest it uses natural height, letting nested folds and live
 * content grow it. A 40px run and a 4000px turn take the same motion. Content
 * stays mounted through the close animation and unmounts after it, keeping
 * the fold's own perf win.
 *
 * A fold that starts open is a plain block until it first closes. Base UI's
 * panel reads its computed style and scroll size in a layout effect when it
 * mounts open, and a transcript opens with many folds already open: each one
 * forced a style and layout pass before the first paint. The first close runs
 * the same keyframes on the same element, so the content is not remounted
 * mid-animation, and only then hands over to Base UI for every later toggle.
 *
 * Bring your own trigger: this is the panel half only, for surfaces whose
 * disclosure row is already richer than a title (the turn header carries
 * stats, live status, media labels). For a titled block dropped into a page,
 * `Disclosure` is the opinionated form.
 *
 * Reduced motion is handled globally in base.css, which flattens the
 * animation to ~0ms.
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
  const [handedOver, setHandedOver] = React.useState(!open);
  if (!handedOver)
    return (
      <PlainFold
        open={open}
        className={className}
        panelClassName={panelClassName}
        onClosed={() => setHandedOver(true)}
      >
        {children}
      </PlainFold>
    );
  return (
    <Collapsible.Root open={open} {...sx(styles.root, className)}>
      <Collapsible.Panel {...sx(collapsible.panel, panelClassName)}>
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** The open fold before its first close: the same two boxes Base UI renders,
 *  without its mount-time measurement. Closing sets the height Base UI would
 *  have measured and lets `collapsible.panel` play the close keyframes;
 *  reopening mid-close drops `data-closed` and the block is open again. */
function PlainFold({
  open,
  className,
  panelClassName,
  onClosed,
  children,
}: {
  open: boolean;
  className?: string;
  panelClassName?: string;
  onClosed: () => void;
  children: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const closed = React.useEffectEvent(onClosed);
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    if (open || !panel) return;
    panel.style.setProperty(
      "--collapsible-panel-height",
      `${panel.scrollHeight}px`,
    );
    // Nothing to wait for when the keyframes do not apply (a hidden
    // ancestor, a stylesheet that has not loaded).
    if (panel.getAnimations().length === 0) {
      closed();
      return;
    }
    // Nested folds' animations bubble here too; only this panel's counts.
    const finish = (event: AnimationEvent) => {
      if (event.target === panel) closed();
    };
    panel.addEventListener("animationend", finish);
    panel.addEventListener("animationcancel", finish);
    return () => {
      panel.removeEventListener("animationend", finish);
      panel.removeEventListener("animationcancel", finish);
    };
  }, [open]);
  return (
    <div {...sx(styles.root, className)}>
      <div
        ref={panelRef}
        data-closed={open ? undefined : ""}
        {...sx(collapsible.panel, panelClassName)}
      >
        {children}
      </div>
    </div>
  );
}
