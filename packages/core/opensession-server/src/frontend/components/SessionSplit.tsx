import { utilityClassName } from "../ui/cn";
import React, { useEffect, useRef, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { clampSplitRatio } from "../lib/split-tabs";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  grid: {
    display: "grid",
  },
  minH0: {
    minHeight: "0",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  overflowHidden: {
    overflow: "hidden",
  },
});

type Socket = ReturnType<typeof useWebSocket>;
export type SplitSide = "left" | "right";

// The middle column is the divider hairline itself — no gutter around it. Its
// grab area is a wider ::after overlay (see DIVIDER) so pointing at it stays
// easy without a channel of background between the two panes.
const splitColumns = (ratio: number) => `${ratio * 100}% 1px minmax(0, 1fr)`;

/**
 * A column. `.session-tabs` stays a real class name (SessionViewer's phone
 * chrome and legacy.css both key structural `:has()` rules off it), so the bar
 * still sizes to its content here while everything after it takes the rest.
 */
const COLUMN =
  utilityClassName("relative flex min-h-0 min-w-0 flex-col overflow-hidden ") +
  "[&>.session-tabs]:shrink-0 [&>:not(.session-tabs)]:min-h-0 [&>:not(.session-tabs)]:flex-1";

/**
 * The divider IS the seam — one hairline on the same token as every other
 * divider, with the panes butted straight onto it. The grab area is an
 * ::after spilling 4px over both panes, so it takes no layout width of its
 * own. It lights up while hovered and stays lit for the whole drag.
 */
const DIVIDER =
  utilityClassName(
    "relative z-[5] cursor-col-resize touch-none bg-line transition-[background-color] ",
  ) +
  utilityClassName(
    "after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] ",
  ) +
  utilityClassName("hover:bg-accent [body.resizing-tab-split_&]:bg-accent");

interface Props {
  /** Which column holds the focused tab — it owns the shared header chrome. */
  focusedSide: SplitSide;
  ratio: number;
  onFocusSide: (side: SplitSide) => void;
  onRatioChange: (ratio: number) => void;
  /**
   * A whole column: its own tab bar above its own pane. Each side gets its own
   * socket so both panes stay live, not just the focused one.
   */
  renderColumn: (
    side: SplitSide,
    socket: Socket,
    focused: boolean,
  ) => React.ReactNode;
}

/**
 * Two side-by-side columns with a draggable divider. The split runs the full
 * height of the detail pane — each column carries its own tab bar, so the two
 * sides are independent tab strips rather than two panes sharing one strip.
 */
export function SessionSplit({
  focusedSide,
  ratio,
  onFocusSide,
  onRatioChange,
  renderColumn,
}: Props) {
  // Both panes keep streaming, but only the selected pane may put this user's
  // face on a sidebar row. Otherwise whichever socket joined last wins global
  // presence, which makes an unfocused session look randomly watched.
  const leftSocket = useWebSocket(focusedSide === "left");
  const rightSocket = useWebSocket(focusedSide === "right");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  const [draftRatio, setDraftRatio] = useState(() => clampSplitRatio(ratio));

  useEffect(() => setDraftRatio(clampSplitRatio(ratio)), [ratio]);
  useEffect(
    () => () => {
      stopResizeRef.current?.();
      document.body.classList.remove("resizing-tab-split");
    },
    [],
  );

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    stopResizeRef.current?.();
    document.body.classList.add("resizing-tab-split");
    const move = (moveEvent: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const next = clampSplitRatio(
        (moveEvent.clientX - rect.left) / rect.width,
      );
      // Keep Motion's reorder items out of React's layout-projection cycle while
      // the grid moves, otherwise the right tab visibly trails its pane.
      root.style.gridTemplateColumns = splitColumns(next);
    };
    const cleanup = () => {
      document.body.classList.remove("resizing-tab-split");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancel);
      stopResizeRef.current = null;
    };
    const stop = (upEvent: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const next = clampSplitRatio((upEvent.clientX - rect.left) / rect.width);
      root.style.gridTemplateColumns = splitColumns(next);
      setDraftRatio(next);
      onRatioChange(next);
      cleanup();
    };
    const cancel = () => {
      root.style.gridTemplateColumns = splitColumns(draftRatio);
      cleanup();
    };
    stopResizeRef.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancel);
  }

  const column = (side: SplitSide, socket: Socket) => (
    <div
      className={COLUMN}
      onPointerDownCapture={() => {
        if (focusedSide !== side) onFocusSide(side);
      }}
    >
      {renderColumn(side, socket, focusedSide === side)}
    </div>
  );

  return (
    <div
      ref={rootRef}
      {...stylex.props(
        sx.grid,
        sx.minH0,
        sx.minW0,
        sx.flex1,
        sx.overflowHidden,
      )}
      style={{ gridTemplateColumns: splitColumns(draftRatio) }}
    >
      {column("left", leftSocket)}
      <div
        className={DIVIDER}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize split tabs"
        onPointerDown={startResize}
      />
      {column("right", rightSocket)}
    </div>
  );
}
