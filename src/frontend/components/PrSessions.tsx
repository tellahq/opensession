import React, { useEffect, useRef, useState } from "react";
import type { UnifiedSession, WSServerMessage } from "../lib/types";
import { relativeTime } from "../lib/api";
import { chatPath } from "../lib/share-link";
import { Button } from "../ui/button";
import { getCurrentUser } from "./UserPicker";

/**
 * Sessions related to a PR: primarily via the server-enriched `prs` refs
 * (primary + attached + linked), with primary-branch/number fallbacks for
 * sessions the enrichment hasn't reached. Matching also uses the loaded PR's
 * number and head branch, so number-keyed callers link the same sessions as
 * branch-keyed ones. Legacy hidden chats are excluded; running sessions sort first,
 * then most recent activity.
 */
export function prRelatedSessions(
	sessions: UnifiedSession[],
	repo: string,
	branch: string | undefined,
	pr?: { number?: number; headRefName?: string } | null,
): UnifiedSession[] {
	const num = pr?.number;
	const head = pr?.headRefName;
	const refMatch = (r: { repo: string; branch?: string; number?: number }) =>
		r.repo === repo &&
		((num != null && r.number === num) ||
			(!!branch && r.branch === branch) ||
			(!!head && r.branch === head));
	const matched = sessions.filter((s) => {
		if (s.sideChatOf) return false;
		if ((s.prs || []).some(refMatch)) return true;
		if ((s.linkedPrs || []).some(refMatch)) return true;
		const sRepo = s.repo || "repository";
		if (
			sRepo === repo &&
			((!!branch && s.branch === branch) || (!!head && s.branch === head))
		)
			return true;
		if (num != null && sRepo === repo && s.prNumber === num) return true;
		return (s.attachedRepos || []).some(
			(a) =>
				a.repo === repo &&
				((!!branch && a.branch === branch) || (!!head && a.branch === head)),
		);
	});
	return matched.sort((a, b) => {
		if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
		return (b.lastActivity || "").localeCompare(a.lastActivity || "");
	});
}

interface Props {
	/** Already-matched sessions for this PR (see prRelatedSessions). */
	sessions: UnifiedSession[];
	repo: string;
	/** The PR's head branch as the caller knows it (the loaded PR's headRefName wins). */
	branch?: string;
	pr?: { number?: number; title?: string; headRefName?: string } | null;
	/** Marks this session's row as "current" (the session hosting the panel). */
	currentSessionId?: string;
	onOpenSession?: (id: string) => void;
	/** WebSocket sender + handler hook — both required for the compose form. */
	send?: (msg: any) => void;
	addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
	/** Offer the inline "start a new session on this PR" form. */
	compose?: boolean;
}

/**
 * The sessions linked to a PR, with an optional one-line composer that starts
 * a NEW session on the PR's head branch (`create_session` with `fromPr` — an
 * isolated worktree checking out the existing branch). The new chat joins the
 * PR's existing workspace when a related session carries one; otherwise a
 * fresh workspace named after the PR is minted (the PrPreview pattern). App
 * navigates into the session on `session_created`.
 */
export function PrSessionsList({
	sessions,
	repo,
	branch,
	pr,
	currentSessionId,
	onOpenSession,
	send,
	addHandler,
	compose,
}: Props) {
	const [prompt, setPrompt] = useState("");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// Success navigates away on session_created (App handles it); on failure
	// the `starting` lock would stick — reset on server error or timeout (same
	// pattern as PrPreview / the workspace home composer).
	useEffect(() => {
		if (!addHandler) return;
		return addHandler((msg) => {
			if (msg.type === "error" && startingRef.current) {
				clearTimeout(timer.current);
				startingRef.current = false;
				setStarting(false);
				setError(msg.message || "Failed to start the session.");
			}
		});
	}, [addHandler]);
	useEffect(() => () => clearTimeout(timer.current), []);

	const targetBranch = pr?.headRefName || branch;
	const canCompose = !!compose && !!send && !!targetBranch;

	function handleStart() {
		const q = prompt.trim();
		if (!q || starting || !send || !targetBranch) return;
		setStarting(true);
		startingRef.current = true;
		setError(null);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			if (!startingRef.current) return;
			startingRef.current = false;
			setStarting(false);
			setError("No response — check your connection and try again.");
		}, 15_000);
		// Join the PR's existing workspace when a related chat carries one so
		// the new chat lands as a sibling tab, not a duplicate workspace.
		const workspaceId =
			sessions.find((s) => s.projectId)?.projectId || undefined;
		send({
			type: "create_session",
			mode: "code",
			repo,
			branch: targetBranch,
			fromPr: true,
			prompt: q,
			user: getCurrentUser(),
			...(workspaceId
				? { workspaceId }
				: {
						createWorkspace: {
							name: pr?.number
								? `PR #${pr.number}: ${pr.title || ""}`.trim().slice(0, 80)
								: targetBranch,
						},
					}),
		});
		// App navigates into the session on session_created.
	}

	return (
		<div className="flex flex-col">
			{sessions.length === 0 && (
				<div className="px-2 py-1.5 -mx-2 text-label text-faint">
					No sessions are linked to this PR yet.
				</div>
			)}
			{sessions.map((s) => (
				<a
					key={s.id}
					href={chatPath(s)}
					onClick={(e) => {
						// Plain click navigates in-app; modified clicks keep native
						// new-tab behavior.
						if (e.metaKey || e.ctrlKey || e.shiftKey) return;
						e.preventDefault();
						onOpenSession?.(s.id);
					}}
					className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-body text-fg no-underline hover:bg-surface"
				>
					<span
						className={`w-1.5 h-1.5 rounded-full shrink-0 ${
							s.isRunning ? "bg-green animate-pulse" : "bg-line"
						}`}
					/>
					<span className="truncate">{s.title}</span>
					{s.id === currentSessionId && (
						<span className="shrink-0 rounded-full border border-line bg-surface px-1.5 py-px text-meta text-faint">
							current
						</span>
					)}
					{s.archived && (
						<span className="shrink-0 text-meta text-faint">archived</span>
					)}
					{s.startedBy && (
						<span className="text-faint text-label shrink-0">{s.startedBy}</span>
					)}
					<span className="text-faint text-label shrink-0 ml-auto">
						{relativeTime(s.lastActivity)}
					</span>
				</a>
			))}
			{canCompose && (
				<form
					className="mt-2 flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						handleStart();
					}}
				>
					<input
						className="min-w-0 flex-1 rounded-sm border border-line bg-surface px-2.5 py-2 text-label text-fg outline-none placeholder:text-faint focus:border-line-strong"
						placeholder="Start a new session on this PR…"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						disabled={starting}
					/>
					<Button
						type="submit"
						variant="primary"
						className="shrink-0 text-label"
						disabled={starting || !prompt.trim()}
					>
						{starting ? "Starting…" : "Start"}
					</Button>
				</form>
			)}
			{error && <div className="mt-1.5 text-label text-red">{error}</div>}
		</div>
	);
}
