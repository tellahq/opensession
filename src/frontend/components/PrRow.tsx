import React from "react";
import type { ReviewQueueItem } from "../lib/review-queue";
import { prStatusMark } from "../lib/pr-status";
import { providerFromUrl } from "../lib/provider";
import { shortTime } from "../lib/time";
import {
	IconArrowUpRight,
	IconPin,
	IconPullRequest,
	IconX,
} from "./icons";
import { ContextMenu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../ui/cn";
import {
	PrRowCard,
	RowCardPopup,
	useRowHoverCard,
} from "./SidebarRowCards";
import { useIsPhone } from "../hooks/useIsPhone";

/**
 * A session-less open PR, rendered inside a project's status lanes (ported
 * from the retired standalone Pull-requests band — the sidebar's PR queue
 * dissolved into the per-repo project groups). PRs that have a live session
 * ride their workspace row instead; this row covers the rest: automation
 * output, teammates' PRs surfaced by the PR filter, review requests whose
 * session is archived.
 *
 * Single-line, in the workspace rows' exact shape: the rail glyph carries the
 * PR state (the same color language as WsPrStatusMark), the title fills the
 * row, the right edge shows last-update time. Author, number, checks and the
 * spelled-out status live in the hover card and the context menu.
 */

// The ws rows' PR color language (prStatusMark), computed off the queue item's
// OpenPr: red = blocked (conflict / failing checks / changes requested),
// yellow = checks running, faint = draft, green = open and healthy.
function PrStateMark({ item, size }: { item: ReviewQueueItem; size: number }) {
	const status = prStatusMark(item.pr);
	return (
		<span title={item.status || status.label}>
			<IconPullRequest size={size} className={status.className} />
		</span>
	);
}

export function PrRow({
	item,
	selected,
	pinned,
	onTogglePin,
	onOpen,
	onClose,
	closing,
}: {
	item: ReviewQueueItem;
	selected: boolean;
	/** Pinned into the sidebar's Pinned band (per-user, like workspace pins). */
	pinned: boolean;
	onTogglePin: () => void;
	/** Open the PR's workspace (resolve-or-create, Review tab). */
	onOpen: () => void;
	/** Close the PR on the provider without merging (confirmed upstream). */
	onClose: () => void;
	closing: boolean;
}) {
	const isPhone = useIsPhone();
	const card = useRowHoverCard();
	return (
		<Popover.Root {...card.rootProps}>
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					// Both triggers ride the same row button: the popover raises the
					// hover card, the context menu keeps right-click. The card steps
					// aside when the menu opens so the two never overlap.
					<Popover.Trigger
						{...card.triggerProps}
						render={
							<button
								type="button"
								className={cn(
									"sidebar-item sidebar-ws-row group relative mt-0.5 flex w-full items-center gap-[9px] rounded-lg border-0 bg-transparent px-2 py-[9px] pl-2.5 text-left text-fg transition-colors hover:bg-hover max-[720px]:px-2 max-[720px]:py-[13px] max-[720px]:pl-2.5",
									selected && "sidebar-item-selected !bg-hover-strong",
								)}
								onClick={onOpen}
								onContextMenu={card.close}
								aria-label={item.pr.title}
							/>
						}
					/>
				}
			>
			<span className="sidebar-rail relative flex size-[22px] shrink-0 items-center justify-center">
				<PrStateMark item={item} size={18} />
			</span>
			<span className="sidebar-item-title min-w-0 flex-1 truncate text-item-title font-medium leading-[1.35] text-dim max-[720px]:text-[16px]">{item.pr.title}</span>
			{!isPhone && (
				<span
					className="sidebar-ws-time ml-auto min-w-[34px] shrink-0 text-right text-meta text-faint"
					aria-label={new Date(item.pr.updatedAt).toLocaleString()}
				>
					{shortTime(item.pr.updatedAt)}
				</span>
			)}
			{/* Hover actions in the workspace rows' shape: pin keeps the PR in
			    the Pinned band; the trailing action closes the PR upstream
			    (confirmed). It deliberately does NOT wear the archive icon —
			    this row sits beside workspace rows whose trailing icon archives
			    locally, and a mis-click here closes someone's PR on GitHub. */}
			<span className="sidebar-ws-actions absolute right-[7px] top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-sm bg-hover shadow-[-6px_0_5px_-2px_var(--bg-hover)] [@media(hover:hover)]:group-hover:inline-flex">
				<Tooltip label={pinned ? "Unpin pull request" : "Pin pull request"}>
					<span
						role="button"
						tabIndex={0}
						className={cn("sidebar-ws-action inline-flex size-8 items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-fg", pinned && "is-on text-accent")}
						aria-label={pinned ? "Unpin pull request" : "Pin pull request"}
						onMouseEnter={card.close}
						onClick={(e) => {
							e.stopPropagation();
							onTogglePin();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
								onTogglePin();
							}
						}}
					>
						<IconPin size={21} fill={pinned ? "currentColor" : "none"} />
					</span>
				</Tooltip>
				<Tooltip label="Close pull request">
					<span
						role="button"
						tabIndex={0}
						className="sidebar-ws-action inline-flex size-8 items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-fg"
						aria-label="Close pull request"
						onMouseEnter={card.close}
						onClick={(e) => {
							e.stopPropagation();
							onClose();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
								onClose();
							}
						}}
					>
						<IconX size={21} />
					</span>
				</Tooltip>
			</span>
			</ContextMenu.Trigger>
			<ContextMenu.Popup className="min-w-[220px]">
				<ContextMenu.Item onClick={onOpen}>
					<span className="grow">Open review</span>
				</ContextMenu.Item>
				<ContextMenu.Item
					render={
						<a href={item.pr.url} target="_blank" rel="noopener" />
					}
				>
					<IconArrowUpRight size={18} />
					<span className="grow">Open on {providerFromUrl(item.pr.url).name}</span>
				</ContextMenu.Item>
				<ContextMenu.Separator />
				<ContextMenu.Item
					className="text-red data-[highlighted]:bg-red-soft"
					disabled={closing}
					onClick={onClose}
				>
					<IconX size={18} />
					<span className="grow">{closing ? "Closing…" : "Close pull request…"}</span>
				</ContextMenu.Item>
			</ContextMenu.Popup>
		</ContextMenu.Root>
			<RowCardPopup>
				<PrRowCard item={item} />
			</RowCardPopup>
		</Popover.Root>
	);
}
