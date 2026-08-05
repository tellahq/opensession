import React from "react";
import { cn } from "../ui/cn";

/**
 * Pixel spinner — a 3×3 grid of tiny pixels that light up in a single,
 * consistent diagonal wave sweeping top-left → bottom-right (the
 * `diagonal-br` pattern). The wavefront runs along successive anti-diagonals,
 * so the number of lit pixels grows 1 → 2 → 3 and then recedes 3 → 2 → 1 as
 * it crosses the grid. Ported from tella-fusion's `UI__PixelSpinner`. The
 * pixels inherit the surrounding text color (via `currentColor`), so the
 * color is controlled by the caller's text class (e.g. `text-fg` for a
 * neutral black/white loader).
 *
 * The pattern is intentionally fixed (not random per instance) so every
 * loader in the app looks identical — a row of session spinners reads as one
 * consistent indicator rather than a different animation each. `cycling` and
 * `interval` are kept for call-site compatibility but no longer switch the
 * pattern.
 */
interface Props {
	/** Retained for compatibility; the pattern no longer changes over time. */
	cycling?: boolean;
	/** Retained for compatibility; no longer used. */
	interval?: number;
	className?: string;
}

export function PixelSpinner({ className = "" }: Props) {
	const sidebar = className.includes("sidebar-spinner");
	const slow = className.includes("pixel-spinner-slow");
	const delays = sidebar
		? ["0ms", "170ms", "170ms", "345ms", "345ms", "345ms", "520ms", "520ms", "690ms"]
		: ["0ms", "210ms", "210ms", "420ms", "420ms", "420ms", "630ms", "630ms", "840ms"];

	return (
		<div className={cn("pixel-spinner diagonal-br grid grid-cols-3 gap-px [--glow-color:currentColor] [--glow-dim:currentColor]", className)} aria-hidden>
			{Array.from({ length: 9 }, (_, i) => (
				<div key={i} className={cn("pixel rounded-[calc(1px*var(--rf))] bg-[color-mix(in_srgb,currentColor_35%,transparent)] [animation-name:pixel-snake-trail] [animation-duration:1.4s] [animation-iteration-count:infinite] [animation-timing-function:ease-out] [corner-shape:var(--cs)] transition-[background,box-shadow,opacity] duration-150 motion-reduce:animate-none motion-reduce:bg-current motion-reduce:opacity-60", sidebar ? "size-[3.5px] [animation-duration:1.15s]" : "size-[3px]", slow && !sidebar && "[animation-duration:2.4s]")} style={{ animationDelay: delays[i] }} />
			))}
		</div>
	);
}
