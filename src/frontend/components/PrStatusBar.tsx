import { repoLabel } from "../lib/repo-label";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GitStatusInfo, PrDetails } from "../lib/types";
import {
	refChipText,
	refLabel,
	refTone,
	summarizePrSeries,
	type SessionPrRef,
} from "../lib/pr-refs";
import {
	archiveSessionApi,
	fetchGitStatus,
	fetchPr,
	gitPullApi,
	gitPushApi,
	mergePrApi,
} from "../lib/api";
import {
	pollWhileVisible,
	PR_WEBHOOK_FALLBACK_POLL_MS,
} from "../lib/poll";
import { getCurrentUser } from "./UserPicker";
import { providerFromUrl } from "../lib/provider";
import { sessionPrPresentation } from "../lib/session-prs";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu, Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { PrChecksPopover } from "./PrChecksPopover";
import { PrSeriesRows } from "./PrSeriesRows";
import {
	IconArrowDown,
	IconArrowUp,
	IconArrowUpRight,
	IconPullRequest,
	IconGitMerge,
	IconCopy,
	IconHash,
	IconCheck,
} from "./icons";

/**
 * Conductor-style status strip at the top of the right Workspace panel: the PR
 * number as a linked pill, one derived headline ("Ready to merge", "Merged",
 * "Checks running", "Ahead by 2 commits"…), and a single primary action on the
 * right (Merge / Push / Create PR / Archive).
 *
 * One departure from Conductor: sessions push automatically, so Push is a
 * fallback for stray local commits rather than the main flow, and "Create PR"
 * asks the session to do it (commit → push → PR with a real description)
 * instead of minting a bare PR from the header.
 */

interface PrHeadline {
	key:
		| "merged"
		| "closed"
		| "conflicts"
		| "failing"
		| "running"
		| "draft"
		| "changes-requested"
		| "stack-blocked" // a lower layer of this PR's stack is still open
		| "ready"
		| "ahead"
		| "behind" // behind the branch's own upstream → Pull
		| "behind-base" // clean tree, no PR, behind origin/<base> → Pull
		| "no-pr"
		| "clean";
	label: string;
	tone: "green" | "purple" | "red" | "yellow" | "muted";
}

/** Roll PR + local git state up into the one line the header shows. */
function deriveHeadline(
	pr: PrDetails | null,
	git: GitStatusInfo | null,
): PrHeadline {
	const ahead = git?.ahead ?? 0;
	const behind = git?.behind ?? 0;
	if (pr) {
		if (pr.state === "MERGED") return { key: "merged", label: "Merged", tone: "purple" };
		if (pr.state === "CLOSED") return { key: "closed", label: "Closed", tone: "muted" };
		if (ahead > 0)
			return {
				key: "ahead",
				label: `Ahead by ${ahead} commit${ahead === 1 ? "" : "s"}`,
				tone: "yellow",
			};
		// Local checkout is stale vs the PR branch (someone else pushed) — the
		// PR data below would describe commits this worktree doesn't have yet.
		if (behind > 0)
			return {
				key: "behind",
				label: `Behind by ${behind} commit${behind === 1 ? "" : "s"}`,
				tone: "yellow",
			};
		if (pr.mergeable === "CONFLICTING")
			return { key: "conflicts", label: "Merge conflicts", tone: "red" };
		const checks = summarizeChecks(pr);
		if (checks.failed > 0) return { key: "failing", label: "Checks failed", tone: "red" };
		if (checks.pending > 0)
			return {
				key: "running",
				label: `${checks.pending} check${checks.pending === 1 ? "" : "s"} pending…`,
				tone: "yellow",
			};
		if (pr.isDraft) return { key: "draft", label: "Draft", tone: "muted" };
		if (pr.reviewDecision === "CHANGES_REQUESTED")
			return { key: "changes-requested", label: "Changes requested", tone: "red" };
		// A stack layer can't land before the layers under it (mergePr refuses
		// it) — "Ready to merge" would be a promise the merge button breaks.
		const openBelow = pr.stack
			? pr.stack.layers.filter(
					(l) => l.position < pr.stack!.position && l.state === "OPEN",
				)
			: [];
		if (openBelow.length)
			return {
				key: "stack-blocked",
				label: `Waiting on #${openBelow[openBelow.length - 1].number} below it`,
				tone: "yellow",
			};
		return { key: "ready", label: "Ready to merge", tone: "green" };
	}
	if (behind > 0)
		return {
			key: "behind",
			label: `Behind by ${behind} commit${behind === 1 ? "" : "s"}`,
			tone: "yellow",
		};
	if (ahead > 0 || (git?.uncommittedFiles ?? 0) > 0)
		return { key: "no-pr", label: "No PR open", tone: "muted" };
	if ((git?.behindBase ?? 0) > 0)
		return {
			key: "behind-base",
			label: `${git!.behindBase} commit${git!.behindBase === 1 ? "" : "s"} behind ${git!.baseBranch}`,
			tone: "muted",
		};
	return { key: "clean", label: "Up to date", tone: "muted" };
}

export type { SessionPrRef } from "../lib/pr-refs";
// Re-exported so the strip stays the one import site for PR-ref presentation.
export { refTone } from "../lib/pr-refs";

export function summarizeChecks(pr: PrDetails | null): {
	passed: number;
	failed: number;
	pending: number;
	total: number;
} {
	let passed = 0,
		failed = 0,
		pending = 0;
	for (const c of pr?.checks || []) {
		// StatusContexts (Vercel deploys) report a state, not a status — PENDING
		// there means running, and must not read as done.
		if (
			(c.status !== "COMPLETED" && c.status !== "") ||
			c.conclusion === "PENDING" ||
			c.conclusion === "EXPECTED"
		)
			pending++;
		else if (c.conclusion === "SUCCESS") passed++;
		else if (["FAILURE", "TIMED_OUT", "ERROR"].includes(c.conclusion)) failed++;
	}
	return { passed, failed, pending, total: (pr?.checks || []).length };
}

interface Props {
	sessionId: string;
	/** Primary repo id (for multi-repo sessions the header tracks the primary). */
	repo?: string;
	archived?: boolean;
	/**
	 * Every PR this session spans (`session.prs`: primary branch + attached
	 * repos + linked + footer-discovered). The headline and the primary action
	 * stay on the primary branch's PR — that's the one this worktree can push,
	 * pull and merge — while the rest ride along as chips, so a session that
	 * shipped one feature as four PRs shows all four. No extra fetch: the refs
	 * come enriched from the server's bulk PR cache.
	 */
	prs?: SessionPrRef[];
	/** Prompt the session (Create PR / Resolve conflicts) — WS `prompt` message. */
	send?: (msg: any) => void;
	/** Clicking the headline jumps to the PR tab; a chip jumps to that PR. */
	onOpenPrTab?: (ref?: { repo: string; branch: string }) => void;
	/** Open the primary PR directly on its Checks tab. */
	onOpenChecksTab?: () => void;
	/** Archive via the owning viewer so it can select the neighboring sidebar row. */
	onArchive?: () => void;
	/** "header" renders just the PR chip + primary action for the chat header
	    (shown while the Workspace panel is closed); default is the full strip. */
	variant?: "bar" | "header";
	/** Optional element rendered inside the strip, left of the PR chip (bar
	    variant only) so it shares the strip's tone background — e.g. the globe
	    staging-deploy icon in the Workspace panel. */
	leading?: React.ReactNode;
	/** Live run state — when it falls from running→idle the header refetches, so
	    it reflects the just-finished turn (and any auto-push) immediately. */
	running?: boolean;
	/** Bumped by the viewer on a `git_pushed` or matching `pr_updated` broadcast. */
	refreshTick?: number;
}

interface PrBarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	tone: "green" | "purple" | "red" | "secondary" | "solid";
	icon?: React.ReactNode;
	confirm?: boolean;
}

function PrBarButton({
	tone,
	icon,
	confirm,
	className = "",
	children,
	...props
}: PrBarButtonProps) {
	const tones = {
		green:
			"bg-[var(--green)] border-[color-mix(in_srgb,var(--green)_78%,black)]",
		purple:
			"bg-[var(--purple)] border-[color-mix(in_srgb,var(--purple)_78%,black)]",
		red: "bg-[var(--red)] border-[color-mix(in_srgb,var(--red)_78%,black)]",
		solid:
			"bg-[var(--text)] text-[var(--bg)] border-[color-mix(in_srgb,var(--text)_84%,transparent)]",
		secondary: "bg-raised text-fg border-line-strong hover:bg-hover hover:brightness-100",
	} as const;
	return (
		<button
			type="button"
			className={cn(
				"inline-flex min-h-[30px] items-center justify-center gap-1.5 rounded-lg border px-2.5 py-[5px] text-control-label leading-none font-[650] whitespace-nowrap text-white shadow-control transition-[background-color,border-color,color,filter,transform] duration-150 ease-in-out hover:brightness-[1.08] active:scale-[0.98] active:brightness-[0.98] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60 disabled:shadow-none",
				tones[tone],
				confirm && "outline-2 outline-[color-mix(in_srgb,var(--green)_45%,transparent)] outline-offset-1",
				className,
			)}
			{...props}
		>
			{icon && (
				<span className="inline-flex size-[18px] shrink-0 items-center justify-center [&_svg]:block [&_svg]:stroke-[1.7]">
					{icon}
				</span>
			)}
			<span className="inline-flex items-center">{children}</span>
		</button>
	);
}

// Keyboard hint for the open-PR chord (SessionViewer owns the handler).
const PR_CHORD = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
	? "⌘G"
	: "Ctrl+G";

/**
 * The PR chip links to OpenSession's review by default. GitHub remains a
 * separate outbound action, while the context menu holds copy actions.
 */
function PrNumberChip({
	pr,
	tone,
	onOpenPrTab,
}: {
	pr: PrDetails;
	tone: PrHeadline["tone"];
	onOpenPrTab?: () => void;
}) {
	const [copied, setCopied] = useState<"link" | "number" | null>(null);
	const provider = providerFromUrl(pr.url);

	const copy = useCallback((kind: "link" | "number", text: string) => {
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(kind);
			setTimeout(() => setCopied(null), 1500);
		});
	}, []);

	return (
		<div className="pr-num-chip-group">
			<ContextMenu.Root>
				<ContextMenu.Trigger
					render={
						<button
							type="button"
							className={`pr-num-chip pr-num-chip-${tone}`}
							onClick={onOpenPrTab}
							title={`Review #${pr.number}: ${pr.title}`}
						/>
					}
				>
					#{pr.number}
				</ContextMenu.Trigger>
				<ContextMenu.Popup>
					<ContextMenu.Item
						render={
							<a
								href={pr.url}
								target="_blank"
								rel="noopener"
								className="no-underline"
							/>
						}
					>
						<IconArrowUpRight size={20} />
						<span className="grow">Open on {provider.name}</span>
					</ContextMenu.Item>
					<ContextMenu.Item
						closeOnClick={false}
						onClick={() => copy("link", pr.url)}
					>
						{copied === "link" ? (
							<IconCheck size={20} />
						) : (
							<IconCopy size={20} />
						)}
						<span className="grow">
							{copied === "link" ? "Copied" : "Copy link"}
						</span>
					</ContextMenu.Item>
					<ContextMenu.Item
						closeOnClick={false}
						onClick={() => copy("number", `#${pr.number}`)}
					>
						{copied === "number" ? (
							<IconCheck size={20} />
						) : (
							<IconHash size={20} />
						)}
						<span className="grow">
							{copied === "number" ? "Copied" : "Copy number"}
						</span>
					</ContextMenu.Item>
				</ContextMenu.Popup>
			</ContextMenu.Root>
			<Tooltip label={`Open on ${provider.name} (${PR_CHORD})`}>
				<a
					className={`pr-num-chip-external pr-num-chip-${tone}`}
					href={pr.url}
					target="_blank"
					rel="noopener"
					aria-label={`Open pull request #${pr.number} on ${provider.name}`}
				>
					<IconArrowUpRight size={18} />
				</a>
			</Tooltip>
		</div>
	);
}

/**
 * The session's other PRs, as compact tone-coloured chips after the primary
 * one. Their tone IS the aggregate signal — a red #72 beside a green "Ready to
 * merge" reads at a glance — and clicking one opens it in the Review tab, which
 * is where per-PR review and merge belong. Past `maxInline` (0 in the chat
 * header, where there's no room) they collapse into a `+N` menu.
 */
function PrRefChips({
	refs,
	maxInline,
	primaryRepo,
	onOpen,
}: {
	refs: SessionPrRef[];
	maxInline: number;
	primaryRepo?: string;
	onOpen?: (ref: { repo: string; branch: string }) => void;
}) {
	if (refs.length === 0) return null;
	const inline = refs.slice(0, maxInline);
	const rest = refs.slice(maxInline);
	// The overflow chip carries the worst tone in the hidden set, so a failing
	// PR still shows red even while collapsed.
	const restTone = rest.some((r) => refTone(r) === "red")
		? "red"
		: rest.some((r) => refTone(r) === "yellow")
			? "yellow"
			: rest.every((r) => r.state === "MERGED")
				? "purple"
				: rest.some((r) => refTone(r) === "green")
					? "green"
					: "muted";
	return (
		<div className="pr-sib-chips">
			{inline.map((ref) => (
				<Tooltip key={`${ref.repo} ${ref.branch}`} label={refLabel(ref)}>
					<button
						type="button"
						className={`pr-num-chip pr-sib-chip pr-num-chip-${refTone(ref)}`}
						onClick={() => onOpen?.(ref)}
					>
						{refChipText(ref, primaryRepo)}
					</button>
				</Tooltip>
			))}
			{rest.length > 0 && (
				<Menu.Root>
					<Menu.Trigger
						render={
							<button
								type="button"
								className={`pr-num-chip pr-sib-chip pr-num-chip-${restTone}`}
								aria-label={`${rest.length} more pull request${rest.length === 1 ? "" : "s"}`}
							/>
						}
					>
						+{rest.length}
					</Menu.Trigger>
					<Menu.Popup>
						{rest.map((ref) => (
							<Menu.Item
								key={`${ref.repo} ${ref.branch}`}
								onClick={() => onOpen?.(ref)}
							>
								<span className={`pr-sib-dot pr-sib-dot-${refTone(ref)}`} />
								<span className="grow">
									{repoLabel(ref.repo)} #{ref.number}
								</span>
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Root>
			)}
		</div>
	);
}

/** Last-known state per session+repo, so a remount (tab switch, panel toggle)
 * paints the previous status instantly and revalidates behind it instead of
 * blanking for a fresh round-trip. Module-level: survives unmounts, dies with
 * the page (a reload starts honest). */
const lastKnown = new Map<
	string,
	{ pr: PrDetails | null; git: GitStatusInfo | null }
>();

export function PrStatusBar({
	sessionId,
	repo,
	archived,
	prs,
	send,
	onOpenPrTab,
	onOpenChecksTab,
	onArchive,
	variant = "bar",
	leading,
	running,
	refreshTick,
}: Props) {
	const presentation = useMemo(() => sessionPrPresentation(prs), [prs]);
	const promoted =
		presentation.primary?.source !== "primary" ? presentation.primary : undefined;
	const targetRepo = promoted?.repo || repo;
	const targetBranch = promoted?.branch;
	const cacheId = `${sessionId}\0${targetRepo || ""}\0${targetBranch || ""}`;
	const seed = lastKnown.get(cacheId);
	const [pr, setPr] = useState<PrDetails | null>(seed?.pr ?? null);
	const [git, setGit] = useState<GitStatusInfo | null>(seed?.git ?? null);
	const [loaded, setLoaded] = useState(!!seed);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmMerge, setConfirmMerge] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isArchived, setIsArchived] = useState(!!archived);
	const [prompted, setPrompted] = useState<string | null>(null);

	useEffect(() => setIsArchived(!!archived), [archived]);

	const load = useCallback(async () => {
		const [prData, gitData] = await Promise.all([
			fetchPr(sessionId, targetRepo, targetBranch).catch(() => null),
			promoted
				? Promise.resolve(null)
				: fetchGitStatus(sessionId, repo).catch(() => null),
		]);
		setPr(prData);
		setGit(gitData);
		setLoaded(true);
		lastKnown.set(cacheId, { pr: prData, git: gitData });
	}, [sessionId, targetRepo, targetBranch, promoted, repo, cacheId]);

	useEffect(() => {
		// Session/repo switch on a mounted component: fall back to that target's
		// last-known state (or the checking placeholder) while the fetch runs.
		const cached = lastKnown.get(cacheId);
		setPr(cached?.pr ?? null);
		setGit(cached?.git ?? null);
		setLoaded(!!cached);
		load();
		return pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
	}, [load]);

	// Refetch the instant a turn ends (running→idle) or an auto-push lands
	// (refreshTick bump), so "Ahead by N commits" clears without waiting on a
	// webhook or fallback poll. Skip initial mount/true edges: load() above covers
	// those. Track the previous run state so only the falling edge
	// triggers (a turn *starting* can't change the pushed/ahead state).
	const prevRunning = React.useRef(running);
	useEffect(() => {
		const fell = prevRunning.current && !running;
		prevRunning.current = running;
		if (fell) load();
	}, [running, load]);
	useEffect(() => {
		if (refreshTick) load();
	}, [refreshTick, load]);

	const headline = useMemo(() => deriveHeadline(pr, git), [pr, git]);

	// Everything except the primary branch's PR (which the headline covers):
	// attached repos, manual links, and PRs discovered through their body
	// footer. Numberless refs are branches with no PR yet — nothing to chip.
	const siblings = presentation.additional;
	// Slack/Linear sessions carry no explicit `repo` — fall back to the primary
	// ref's, so cross-repo chips still get their repo hint.
	const primaryRepoId =
		targetRepo || (prs || []).find((r) => r.source === "primary")?.repo;
	const openSiblings = siblings.filter(
		(r) => r.state !== "MERGED" && r.state !== "CLOSED",
	).length;
	// A feature shipped as N PRs is only done when they've all landed — so the
	// merged headline counts the series, and Archive waits for the last one.
	const seriesAllMerged =
		siblings.length > 0 && siblings.every((r) => r.state === "MERGED");
	// Nothing on this session's own branch, but it owns PRs elsewhere: "No PR
	// open" would be a lie with three rows sitting under it, and a bare count in
	// the neutral tone hides a failing PR one row down — so the strip borrows the
	// series' own worst tone and says how much of it is still open.
	const series = !pr ? summarizePrSeries(siblings) : null;
	const headlineTone = series ? series.tone : headline.tone;
	const headlineLabel =
		headline.key === "merged" && siblings.length > 0
			? seriesAllMerged
				? `All ${siblings.length + 1} merged`
				: `Merged · ${openSiblings} of ${siblings.length + 1} open`
			: series
				? series.label
				: headline.label;

	async function run(name: string, fn: () => Promise<unknown>) {
		if (busy) return;
		setBusy(name);
		setError(null);
		try {
			await fn();
			await load();
		} catch (e: any) {
			setError(e.message || `${name} failed`);
		} finally {
			setBusy(null);
		}
	}

	function handleMerge() {
		if (!confirmMerge) {
			setConfirmMerge(true);
			setTimeout(() => setConfirmMerge(false), 4000);
			return;
		}
		setConfirmMerge(false);
		run("merge", () =>
			mergePrApi(sessionId, "squash", targetRepo, targetBranch),
		);
	}

	// Session-driven actions: ask the agent instead of doing bare git plumbing —
	// a session-authored PR gets a real title/description, and conflict
	// resolution needs judgment, not a button.
	function promptSession(label: string, content: string) {
		if (!send) return;
		send({ type: "prompt", sessionId, user: getCurrentUser(), content });
		setPrompted(label);
		setTimeout(() => setPrompted(null), 6000);
	}

	// The strip is a permanent fixture of the panel (Kent: a topbar that blinks
	// in and out of existence shouldn't exist). First visit with nothing known
	// yet holds its place with a quiet checking line instead of popping the bar
	// in seconds late (the PR fetch can take a GitHub round-trip); a clean
	// session reads "Up to date" rather than vanishing.
	if (!loaded && variant !== "header") {
		return (
			<div className="pr-bar pr-bar-muted">
				{leading}
				<span className="pr-bar-checking">Checking status…</span>
			</div>
		);
	}
	if (
		!loaded ||
		(headline.key === "clean" && variant === "header" && siblings.length === 0)
	)
		return null;

	// Header mode: only once a PR exists — the chip is the anchor; a bare
	// Create PR/Push button in the chrome would just be noise. A session whose
	// PRs all live elsewhere (nothing on its own branch) still gets its chips.
	if (variant === "header" && !pr && siblings.length === 0) return null;

	// Primary action for the current headline (right side of the strip).
	function renderAction(): React.ReactNode {
		if (prompted)
			return <span className="pr-bar-prompted">{prompted}</span>;
		switch (headline.key) {
			case "merged":
				// Don't offer to archive a session that still has open PRs in its
				// series just because the primary one landed.
				if (openSiblings > 0) return null;
				return isArchived ? null : (
					<PrBarButton
						tone="purple"
						disabled={!!busy}
						onClick={() =>
							run("archive", async () => {
								if (onArchive) onArchive();
								else await archiveSessionApi(sessionId, true);
								setIsArchived(true);
							})
						}
					>
						{busy === "archive" ? "Archiving…" : "Archive"}
					</PrBarButton>
				);
			case "ahead":
				return (
					<PrBarButton
						tone="solid"
						icon={<IconArrowUp size={18} />}
						disabled={!!busy}
						onClick={() => run("push", () => gitPushApi(sessionId, repo))}
					>
						{busy === "push" ? "Pushing…" : "Push"}
					</PrBarButton>
				);
			case "behind":
			case "behind-base":
				return (
					<PrBarButton
						tone="solid"
						icon={<IconArrowDown size={18} />}
						disabled={!!busy}
						title={
							headline.key === "behind-base"
								? `Merge the latest origin/${git?.baseBranch || "main"}`
								: "Fast-forward to the branch's upstream"
						}
						onClick={() =>
							run("pull", () =>
								gitPullApi(sessionId, repo, headline.key === "behind-base"),
							)
						}
					>
						{busy === "pull" ? "Pulling…" : "Pull"}
					</PrBarButton>
				);
			case "conflicts":
				return send ? (
					<PrBarButton
						tone="red"
						onClick={() =>
							promptSession(
								"Resolving conflicts…",
								`The PR has merge conflicts with ${pr?.baseRefName || git?.baseBranch || "main"}. Rebase this branch on the latest origin/${pr?.baseRefName || git?.baseBranch || "main"}, resolve the conflicts, and push.`,
							)
						}
					>
						Resolve
					</PrBarButton>
				) : null;
			case "no-pr":
				return send ? (
					<PrBarButton
						tone="secondary"
						icon={<IconPullRequest size={18} />}
						onClick={() =>
							promptSession(
								"Creating PR…",
								"Commit any remaining work, push the branch, and open a PR for it.",
							)
						}
					>
						Create PR
					</PrBarButton>
				) : null;
			case "ready":
			case "failing":
			case "running":
			case "changes-requested":
				return (
					<PrBarButton
						tone="green"
						confirm={confirmMerge}
						icon={!busy && !confirmMerge ? <IconGitMerge size={18} /> : undefined}
						disabled={!!busy}
						onClick={handleMerge}
						title="Squash and merge this PR into its base branch"
					>
						{busy === "merge"
							? "Merging…"
							: confirmMerge
								? "Confirm merge"
								: "Merge"}
					</PrBarButton>
				);
			default:
				return null;
		}
	}

	if (variant === "header") {
		return (
			<div className="pr-head">
				{pr && (
					<PrNumberChip
						pr={pr}
						tone={headline.tone}
						onOpenPrTab={() => onOpenPrTab?.()}
					/>
				)}
				{/* No room for a row of chips in the chat header — the siblings
				    collapse into one `+N` menu in their worst tone. */}
				<PrRefChips
					refs={siblings}
					maxInline={0}
					primaryRepo={primaryRepoId}
					onOpen={onOpenPrTab}
				/>
				{headline.key === "running" && pr && (
					<PrChecksPopover
						checks={pr.checks}
						trigger={
							<button
								type="button"
								className={`pr-bar-state pr-bar-state-${headline.tone}`}
								onClick={onOpenChecksTab}
							>
								{headlineLabel}
							</button>
						}
					/>
				)}
				{error && (
					<span className="pr-bar-error" title={error}>
						{error}
					</span>
				)}
				{renderAction()}
			</div>
		);
	}

	// The primary row is the session's own branch — the one this worktree can
	// push, pull and merge. Its other PRs stack underneath, one row each.
	const primaryRow = (
		<div className={`pr-bar pr-bar-${headlineTone}`}>
			{leading}
			{pr && (
				<PrNumberChip
					pr={pr}
					tone={headlineTone}
					onOpenPrTab={() => onOpenPrTab?.()}
				/>
			)}
			{headline.key === "running" && pr ? (
				<PrChecksPopover
					checks={pr.checks}
					trigger={
						<button
							type="button"
							className={`pr-bar-state pr-bar-state-${headlineTone}`}
							onClick={onOpenChecksTab}
						>
							{headlineLabel}
						</button>
					}
				/>
			) : (headline.key !== "no-pr" || siblings.length > 0) && (
				<Tooltip label="Open the PR tab">
					<button
						className={`pr-bar-state pr-bar-state-${headlineTone}`}
						onClick={() => onOpenPrTab?.()}
					>
						{headlineLabel}
					</button>
				</Tooltip>
			)}
			<span className="pr-bar-spacer" />
			{error && <span className="pr-bar-error" title={error}>{error}</span>}
			{renderAction()}
		</div>
	);
	if (siblings.length === 0) return primaryRow;
	return (
		<div className="pr-bar-stack">
			{primaryRow}
			<PrSeriesRows
				refs={siblings}
				primaryRepo={primaryRepoId}
				onOpen={onOpenPrTab}
			/>
		</div>
	);
}
