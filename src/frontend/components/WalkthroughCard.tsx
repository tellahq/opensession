import React, { useMemo } from "react";
import type { SessionWalkthrough } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { relativeTime } from "../lib/api";
import { cn } from "../ui/cn";
import { openLightbox, type LightboxItem } from "./MediaLightbox";
import { MARKDOWN_STYLES } from "./MarkdownBody";

/** Stream server-side media (staged under the uploads dir) through the
 *  existing scoped media route — same URL shape MessageBubble uses. */
const mediaUrl = (path: string) => `/media?path=${encodeURIComponent(path)}`;

/**
 * The agent-published walkthrough (opensession-walkthrough): demo video +
 * before/after screenshot pairs + writeup. Rendered at the top of the PR info
 * column in the Review tab (`panel`), and inline in the chat where the agent
 * published it (`chat`) — the video plays right there instead of only living
 * behind a tab. Both are the inline counterpart of the link-only section
 * mirrored into the GitHub PR description.
 */
export function WalkthroughCard({
	walkthrough,
	variant = "panel",
}: {
	walkthrough: SessionWalkthrough;
	variant?: "panel" | "chat";
}) {
	const summaryHtml = useMemo(
		() => renderMarkdown(walkthrough.summary),
		[walkthrough.summary],
	);
	// Every still in the card, flattened in render order, so clicking one opens
	// the shared media lightbox (Escape/arrows/pinch-zoom/download) browsing
	// before→after across all the pairs.
	const gallery = useMemo(() => {
		const items: LightboxItem[] = [];
		const at = new Map<string, number>();
		(walkthrough.shots || []).forEach((shot, i) => {
			for (const side of ["before", "after"] as const) {
				const path = shot[side];
				if (!path) continue;
				at.set(`${i}:${side}`, items.length);
				items.push({
					kind: "image",
					src: mediaUrl(path),
					chatTitle: [shot.caption, side === "before" ? "Before" : "After"]
						.filter(Boolean)
						.join(" — "),
				});
			}
		});
		return { items, at };
	}, [walkthrough.shots]);
	const chat = variant === "chat";

	return (
		<div
			className={cn(
				// p-4 deliberately exceeds the mt-3 rhythm between the blocks
				// inside, so the card edge reads as an edge — at 12px a trailing
				// screenshot looks like it runs out of the card rather than sitting
				// in it.
				"rounded-lg bg-raised p-4",
				// In the chat the card is a transcript block like any other, so it
				// takes the same centered reading column the turns and footers use
				// (mx-auto + --chat-col) instead of spanning the whole pane. It
				// trails more space than it leads: unlike the neighbouring blocks
				// it ends in media, which otherwise butts straight into the next
				// message.
				chat ? "mx-auto mb-6 mt-2 w-full max-w-[var(--chat-col)]" : "mb-4",
			)}
		>
			<div className="mb-2 flex items-baseline gap-2">
				<span className="text-label font-semibold text-dim">
					Walkthrough
				</span>
				{chat && walkthrough.publishedAt && (
					<span className="text-meta text-faint">
						{relativeTime(walkthrough.publishedAt)}
					</span>
				)}
			</div>
			{walkthrough.video && (
				<>
					<video
						className={cn(
							"w-full rounded-md border border-line bg-black",
							chat ? "max-h-[60vh] object-contain" : "",
						)}
						src={mediaUrl(walkthrough.video)}
						controls
						preload="metadata"
						title={walkthrough.videoTitle || "Demo video"}
					/>
					{chat && walkthrough.videoTitle ? (
						<div className="mb-2 mt-1 text-meta text-faint">
							{walkthrough.videoTitle}
						</div>
					) : (
						<div className="mb-2" />
					)}
				</>
			)}
			<div
				className={`markdown ${MARKDOWN_STYLES} text-control-label`}
				dangerouslySetInnerHTML={{ __html: summaryHtml }}
			/>
			{(walkthrough.shots || []).map((shot, i) => (
				<div className="mt-3" key={i}>
					{shot.caption && (
						<div className="mb-1 text-label text-dim">{shot.caption}</div>
					)}
					<div className="flex gap-2">
						{(["before", "after"] as const).map(
							(side) =>
								shot[side] && (
									<figure className="m-0 min-w-0 flex-1" key={side}>
										<figcaption className="mb-1 text-meta font-medium text-dim">
											{side === "before" ? "Before" : "After"}
										</figcaption>
									<button
										type="button"
										className="block w-full cursor-zoom-in rounded-md border-0 bg-transparent p-0 outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
										aria-label={`Open ${side} image preview`}
										onClick={(event) =>
											openLightbox(
												gallery.items,
												gallery.at.get(`${i}:${side}`) ?? 0,
												event.currentTarget,
											)
										}
									>
										<img
											className={cn(
												"w-full rounded-md border border-line",
												// In the chat the card sits in the message flow, so
												// cap the stills (full size lives one click away in
												// the lightbox) instead of pushing the conversation
												// down by a screenful per pair.
												chat && "max-h-52 object-contain object-top",
											)}
											src={mediaUrl(shot[side]!)}
											alt={`${shot.caption || "change"} — ${side}`}
											loading="lazy"
										/>
									</button>
									</figure>
								),
						)}
					</div>
				</div>
			))}
		</div>
	);
}
