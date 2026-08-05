import React, { useEffect, useRef, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { clampSplitRatio } from "../lib/split-tabs";

type Socket = ReturnType<typeof useWebSocket>;
export type SplitSide = "left" | "right";

// The middle column is the divider hairline itself — no gutter around it. Its
// grab area is a wider overlay (see .session-split-resize::after) so pointing at
// it stays easy without a channel of background between the two panes.
const splitColumns = (ratio: number) =>
	`${ratio * 100}% 1px minmax(0, 1fr)`;

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
	renderColumn: (side: SplitSide, socket: Socket, focused: boolean) => React.ReactNode;
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
	const leftSocket = useWebSocket();
	const rightSocket = useWebSocket();
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
			const next = clampSplitRatio((moveEvent.clientX - rect.left) / rect.width);
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
			className={`session-split-pane relative min-h-0 min-w-0 overflow-hidden ${focusedSide === side ? "session-split-pane-focused" : "after:pointer-events-none after:absolute after:inset-0 after:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--border)_75%,transparent)]"}`}
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
			className="session-split grid min-h-0 min-w-0 flex-1 overflow-hidden"
			style={{ gridTemplateColumns: splitColumns(draftRatio) }}
		>
			{column("left", leftSocket)}
			<div
				className="session-split-resize relative z-[5] cursor-col-resize touch-none"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize split tabs"
				onPointerDown={startResize}
			/>
			{column("right", rightSocket)}
		</div>
	);
}
