import { useEffect, useState } from "react";
import { fetchPr } from "../lib/api";
import {
	pollWhileVisible,
	PR_WEBHOOK_FALLBACK_POLL_MS,
} from "../lib/poll";
import type { PrCheck, UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import { toast } from "../ui/toast";
import { CopyCheck, useCopy } from "../ui/copy";
import { IconArrowUpRight, IconGlobe } from "./icons";
import { checkClass, isDeployment } from "./PrPanel";

// Keyboard hint for the open-staging chord (SessionViewer owns the handler —
// this component mounts once per layout variant, so a listener here would
// register multiple times).
const OPEN_CHORD = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
	? "⌘O"
	: "Ctrl+O";

/**
 * Header link to the PR's preview environment (the Vercel preview at
 * https://tella-git-<branch>.tella.dev) so a change can be tested on real
 * infra in one click. The URL comes from the PR details endpoint, which parses
 * tella-butler's preview-table comment — so the link only appears when a
 * webapp deploy actually exists for the PR (fusion PRs that don't touch the
 * webapp never get one). While the deploy is still building the link renders
 * dimmed; it flips live on the next poll.
 *
 * Before butler posts the comment at all there's still a window where we KNOW a
 * deploy is coming — the Vercel preview shows up as a pending StatusContext in
 * the PR checks first. In that window we render a shimmering placeholder globe
 * (no URL to click yet) so the staging affordance loads in lockstep with the
 * checks headline instead of popping in cold once the URL lands. The shimmer is
 * gated on a *pending deploy check* so it never appears on backend-only PRs
 * that will never deploy (they'd otherwise shimmer forever).
 */
export function StagingLink({
	session,
	variant = "bar",
	refreshTick,
}: {
	session: UnifiedSession;
	/** "bar" = the labelled Preview environment link; "header" = a compact
	 *  state-colored icon; "action" = a cell in the mobile workspace grid. */
	variant?: "bar" | "header" | "action";
	/** Bumped when GitHub reports PR/check/deployment activity for this session. */
	refreshTick?: number;
}) {
	const [staging, setStaging] = useState<{ url: string; status: string } | null>(
		null,
	);
	// A Vercel preview deploy is queued/running but butler hasn't posted the URL
	// comment yet — enough to show a loading placeholder, not enough to link.
	const [deployPending, setDeployPending] = useState(false);
	const { copied, copy } = useCopy();

	// A merged/closed PR's alias no longer points at this change — the link is a
	// pre-merge testing affordance. Repos without deployment metadata simply
	// return no staging URL.
	const relevant = !!session.prUrl && session.prState === "OPEN";

	useEffect(() => {
		if (!relevant) {
			setStaging(null);
			setDeployPending(false);
			return;
		}
		let alive = true;
		const load = () =>
			fetchPr(session.id)
				.then((pr) => {
					if (!alive) return;
					setStaging(pr?.staging ?? null);
					setDeployPending(
						!!pr?.checks?.some(
							(c: PrCheck) =>
								isDeployment(c) &&
								checkClass(c.status, c.conclusion) === "check-pending",
						),
					);
				})
				.catch(() => {});
		load();
		// Webhooks normally flip Building to Ready; this is only a missed-event
		// fallback, and hidden tabs skip it entirely.
		const stop = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
		return () => {
			alive = false;
			stop();
		};
	}, [session.id, relevant, refreshTick]);

	if (!relevant) return null;

	// No URL yet. If a deploy is on its way (pending check), hold the slot with a
	// shimmering globe so the affordance loads alongside the checks; otherwise
	// (backend-only PR, no deploy) render nothing.
	if (!staging) {
		if (!deployPending) return null;
		const shimmerGlobe = (size: number, className?: string) => (
			<span className="staging-globe-wrap staging-shimmer relative inline-flex animate-[staging-shimmer_1.4s_ease-in-out_infinite] items-center justify-center" aria-hidden="true">
				<IconGlobe size={size} className={className} />
			</span>
		);
		if (variant === "header") {
			return (
				<Tooltip
					label="Preview environment starting… the link appears once it's up"
					side="bottom"
					multiline
				>
					<span
						className="viewer-code-icon staging-icon is-pending inline-flex cursor-default items-center justify-center rounded-md border border-transparent bg-transparent px-1 py-0.5 text-faint no-underline"
						aria-disabled="true"
					>
						{shimmerGlobe(25)}
					</span>
				</Tooltip>
			);
		}
		if (variant === "action") {
			return (
				<span
					className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-supporting font-semibold text-faint"
					title="Preview environment starting… the link appears once it's up"
				>
					<span className="inline-flex size-5 shrink-0 items-center justify-center">
						{shimmerGlobe(17)}
					</span>
					<span className="min-w-0 flex-1 truncate">Preview environment</span>
				</span>
			);
		}
		return (
			<span
				className="staging-link staging-link-pending inline-flex cursor-default items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 py-1 text-control-label font-semibold text-dim no-underline"
				title="Preview environment starting… the link appears once it's up"
			>
				{shimmerGlobe(15, "staging-globe")}
				Preview environment
			</span>
		);
	}

	// A push mid-review kicks off a *new* Vercel preview, but butler's
	// preview-table comment still advertises the previous deploy as Ready — so
	// staging.status alone leaves the globe green while a rebuild is in flight.
	// The branch alias keeps serving the last Ready deploy until the new one
	// lands, so a rebuild only means "possibly one push behind", never a dead
	// link — keep it clickable, spin the globe, and say so in the tooltip.
	// Only a first deploy that has never gone Ready gets a dead (swallowed)
	// click: before that the alias 404s.
	const rebuilding = deployPending && staging.status === "Ready";
	const building = staging.status !== "Ready";
	// Deep-link to the agent-flagged route (set_preview_path) so the button
	// opens the feature under test, not the app root.
	const href = withPreviewPath(staging.url, session.previewPath);

	// ⌘/Ctrl-click copies the link instead of opening it (mirrors the browser's
	// own modifier semantics elsewhere) — hold Cmd on macOS, Ctrl on Windows.
	const onClick = (e: React.MouseEvent) => {
		if (e.metaKey || e.ctrlKey) {
			e.preventDefault();
			copy(href, { toast: "Link copied" });
			return;
		}
		// Before the first deploy goes Ready the alias 404s, so swallow a plain
		// click — but never silently (an unexplained dead link reads as a bug).
		if (building) {
			e.preventDefault();
			toast(
				`Preview environment is ${staging.status.toLowerCase()} — the link goes live once the first deploy finishes`,
			);
		}
	};

	// The globe carries a spinning ring while any deploy is in flight — first
	// build (link dead until it lands) and rebuild (link opens the previous
	// deploy) alike. While a ⌘-copy is fresh the globe morphs into a drawing
	// checkmark; otherwise it's the (optionally spinning) globe.
	const spinning = building || rebuilding;
	const globe = (size: number, className?: string) =>
		copied ? (
			<CopyCheck
				copied
				size={size}
				idle={<IconGlobe size={size} className={className} />}
			/>
		) : (
			<span className="staging-globe-wrap relative inline-flex items-center justify-center">
				{spinning && <span className="staging-spinner" aria-hidden="true" />}
				<IconGlobe size={size} className={className} />
			</span>
		);

	const stateClass = building
		? "is-building"
		: rebuilding
			? "is-rebuilding"
			: "is-ready";
	const tooltip = (copyHint: string) =>
		copied
			? "Link copied"
			: building
				? `Preview environment ${staging.status.toLowerCase()}… ${copyHint}`
				: rebuilding
					? `Redeploying for the latest push — opens the previous deploy until it lands (${OPEN_CHORD}; ${copyHint})`
					: `Open the preview environment to test this PR on real infra (${OPEN_CHORD}; ${copyHint})`;

	if (variant === "header") {
		return (
			<Tooltip label={tooltip("⌘-click to copy the link")} side="bottom" multiline>
				<a
					href={href}
					target="_blank"
					rel="noopener"
					onClick={onClick}
					aria-disabled={building || undefined}
					className={`viewer-code-icon staging-icon inline-flex items-center justify-center rounded-md border border-transparent bg-transparent px-1 py-0.5 text-faint no-underline transition-colors hover:bg-accent-soft hover:text-accent ${stateClass} ${building ? "cursor-default text-yellow opacity-70 hover:bg-[rgba(210,153,34,0.13)] hover:text-yellow hover:opacity-100" : rebuilding ? "text-yellow opacity-70 hover:bg-[rgba(210,153,34,0.13)] hover:text-yellow hover:opacity-100" : "text-green hover:bg-green-soft hover:text-green"}`}
				>
					{/* The globe glyph only fills ~60% of its box (thin circle in a 24
					    viewBox), so it still needs a hair more than the play/sidebar
					    icons to read at the same weight in the top bar. */}
					{globe(25)}
				</a>
			</Tooltip>
		);
	}
	if (variant === "action") {
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener"
				onClick={onClick}
				aria-disabled={building || undefined}
				className={`flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-supporting font-semibold no-underline outline-none transition-colors hover:bg-hover focus-visible:bg-hover ${building ? "cursor-default text-faint" : "text-fg"}`}
				title={`${tooltip("⌘-click to copy the link")} — ${href}`}
			>
				<span className="inline-flex size-5 shrink-0 items-center justify-center text-faint">
					{globe(17)}
				</span>
				<span className="min-w-0 flex-1 truncate">Preview environment</span>
			</a>
		);
	}

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener"
			onClick={onClick}
			aria-disabled={building || undefined}
			className={`staging-link inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[rgba(210,153,34,0.45)] px-2.5 py-1 text-control-label font-semibold text-yellow no-underline transition-colors hover:bg-[rgba(210,153,34,0.12)] ${building ? "staging-link-building cursor-default opacity-55" : ""}`}
			title={`${tooltip("⌘-click to copy the link")} — ${href}`}
		>
			{globe(15, "staging-globe")}
			Preview environment
			<IconArrowUpRight size={15} className="staging-ext -ml-px opacity-80" />
		</a>
	);
}
