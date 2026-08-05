import React, { useEffect, useRef, useState } from "react";

/**
 * Turn-level windowing with measured placeholders. Recent turns stay mounted;
 * older settled turns render within a 1.5-viewport overscan and preserve their
 * exact measured height outside it, so scroll anchors remain stable.
 */
export const VirtualTranscriptBlock = React.memo(function VirtualTranscriptBlock({
	children,
	enabled,
	anchorId,
}: {
	children: React.ReactNode;
	enabled: boolean;
	anchorId: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(true);
	const heightRef = useRef(96);

	useEffect(() => {
		const node = ref.current;
		if (!node || !enabled || typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const root = node.closest(".viewer-messages");
		const resize = new ResizeObserver(([entry]) => {
			if (entry?.contentRect.height) heightRef.current = entry.contentRect.height;
		});
		resize.observe(node);
		const intersection = new IntersectionObserver(
			([entry]) => setVisible(Boolean(entry?.isIntersecting)),
			{ root, rootMargin: "150% 0px" },
		);
		intersection.observe(node);
		return () => {
			resize.disconnect();
			intersection.disconnect();
		};
	}, [enabled]);

	if (enabled && !visible) {
		return (
			<div
				ref={ref}
				className="transcript-window transcript-window-placeholder pointer-events-none"
				data-eid={anchorId}
				aria-hidden
				style={{ height: heightRef.current }}
			/>
		);
	}

	return (
		<div
			ref={ref}
			className={enabled ? "transcript-window transcript-settled [content-visibility:auto] [contain-intrinsic-size:auto_96px]" : "transcript-window"}
		>
			{children}
		</div>
	);
});
