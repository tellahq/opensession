import { repoLabel } from "../lib/repo-label";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import {
	fetchOpenPrs,
	relativeTime,
	searchTranscripts,
	type OpenPr,
} from "../lib/api";
import { IconPullRequest, IconSearch } from "./icons";
import { Modal, useEnterOnMount } from "../ui/modal";

export interface CommandPaletteAction {
	id: string;
	label: string;
	description?: string;
	category: "Actions" | "Navigate";
	keywords?: string[];
	shortcut?: string[];
	icon?: React.ReactNode;
	run: () => void;
}

interface Props {
	sessions: UnifiedSession[];
	actions: CommandPaletteAction[];
	/** Open a session or PR (also closes the palette). */
	onSelectSession: (id: string) => void;
	onSelectPr: (pr: OpenPr) => void;
	onClose: () => void;
}

const DEFAULT_PROJECT = "repository";

function sessionRepo(s: UnifiedSession): string {
	return s.repo || DEFAULT_PROJECT;
}

// The status buckets a session can fall into, mirroring the sidebar's triage
// order: a blocked question first, then live activity, then PR lifecycle.
type Status = "needsinput" | "running" | "review" | "merged" | "pending";

const STATUS_META: Record<Status, { label: string; dotClass: string }> = {
	needsinput: { label: "Needs input", dotClass: "ss-dot-accent bg-accent" },
	running: { label: "Running", dotClass: "ss-dot-green bg-green" },
	review: { label: "In review", dotClass: "ss-dot-yellow bg-yellow" },
	merged: { label: "Merged", dotClass: "ss-dot-purple bg-purple" },
	pending: { label: "Pending", dotClass: "ss-dot-dim bg-faint" },
};

const STATUS_ORDER: Status[] = [
	"needsinput",
	"running",
	"review",
	"merged",
	"pending",
];

function sessionStatus(s: UnifiedSession): Status {
	// A blocked question — or a run that died on a terminal error (credits/
	// usage limits, API failures) — needs a human before anything else.
	if (s.waitingForInput || (s.lastRunError && !s.isRunning))
		return "needsinput";
	if (s.isRunning) return "running";
	if (s.prState === "OPEN") return "review";
	if (s.prState === "MERGED") return "merged";
	// Idle-but-unfinished — not "Done"; finishing is explicit (Archive).
	return "pending";
}

// The searchable haystack for a session — title plus every field a person might
// recall it by (branch, owner, automation, repo, Linear id).
function haystack(s: UnifiedSession): string {
	return [
		s.title,
		s.branch,
		s.startedBy,
		s.automation,
		sessionRepo(s),
		s.linearIssue?.identifier,
		s.linearIssue?.title,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

function prStatus(pr: OpenPr): string {
	if (pr.isDraft) return "Draft";
	if (pr.checks.failed > 0)
		return `${pr.checks.failed} failing check${pr.checks.failed === 1 ? "" : "s"}`;
	if (pr.checks.pending > 0)
		return `${pr.checks.pending} check${pr.checks.pending === 1 ? "" : "s"} running`;
	if (pr.reviewDecision === "APPROVED") return "Approved";
	if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
	if (pr.reviewRequested?.length) return "Review requested";
	return "Open";
}

type PaletteResult =
	| { type: "action"; category: string; action: CommandPaletteAction }
	| { type: "pr"; category: string; pr: OpenPr }
	| {
			type: "session";
			category: string;
			session: UnifiedSession;
			snippet?: string;
	  };

function resultKey(result: PaletteResult): string {
	if (result.type === "action") return `action:${result.action.id}`;
	if (result.type === "pr") return `pr:${result.pr.url}`;
	return `session:${result.session.id}`;
}

function FilterPill({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
}) {
	const active = value !== "all";
	const current = options.find((option) => option.value === value);
	return (
		<div className={`ss-pill relative inline-flex cursor-pointer items-center gap-1 rounded-full border border-line-strong bg-raised px-2 py-1 text-supporting text-dim transition-[border-color,color] hover:border-faint hover:text-fg${active ? " ss-pill-active border-accent text-fg" : ""}`}>
			<span className={`ss-pill-key font-medium text-faint${active ? " text-accent" : ""}`}>{label}</span>
			<span className="ss-pill-val font-medium">{current?.label ?? value}</span>
			<span className="ss-pill-caret text-[8px] text-faint">▾</span>
			<select
				className="ss-pill-select absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 opacity-0"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				aria-label={label}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
}

export function SessionSearch({
	sessions,
	actions,
	onSelectSession,
	onSelectPr,
	onClose,
}: Props) {
	const [query, setQuery] = useState("");
	const [person, setPerson] = useState("all");
	const [repo, setRepo] = useState("all");
	const [status, setStatus] = useState<Status | "all">("all");
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [openPrs, setOpenPrs] = useState<OpenPr[]>([]);
	const [loadingPrs, setLoadingPrs] = useState(true);
	// Content matches from the backend transcript search, keyed by session id →
	// snippet. Populated (debounced) as the query changes; empty when the query
	// is too short or nothing matched inside any conversation.
	const [snippets, setSnippets] = useState<Map<string, string>>(new Map());
	const [searching, setSearching] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	// One frame closed so the palette animates in; App mounts us already-open.
	const open = useEnterOnMount();

	useEffect(() => {
		let alive = true;
		fetchOpenPrs()
			.then((prs) => {
				if (alive) setOpenPrs(prs);
			})
			.catch(() => {})
			.finally(() => {
				if (alive) setLoadingPrs(false);
			});
		return () => {
			alive = false;
		};
	}, []);

	// Search inside conversations too — the metadata filter is instant/local, but
	// transcript text lives on disk, so we debounce a backend call and fold its
	// hits into the result set. A stale/aborted request never clobbers newer
	// state (AbortController + the trailing-edge guard).
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setSnippets(new Map());
			setSearching(false);
			return;
		}
		setSearching(true);
		const ctrl = new AbortController();
		const t = setTimeout(async () => {
			try {
				const matches = await searchTranscripts(q, ctrl.signal);
				setSnippets(new Map(matches.map((m) => [m.id, m.snippet])));
			} catch (e) {
				if (!ctrl.signal.aborted) setSnippets(new Map());
			} finally {
				if (!ctrl.signal.aborted) setSearching(false);
			}
		}, 250);
		return () => {
			clearTimeout(t);
			ctrl.abort();
		};
	}, [query]);

	// Only live sessions are searchable. The sideChatOf check is a compatibility
	// guard for older/cloud servers that may still return removed side-chat rows.
	const pool = useMemo(
		() => sessions.filter((s) => !s.archived && !s.sideChatOf),
		[sessions],
	);

	const personOptions = useMemo(() => {
		const seen = new Map<string, string>();
		for (const session of pool) {
			if (session.automation || !session.startedBy) continue;
			const key = session.startedBy.toLowerCase();
			if (!seen.has(key)) seen.set(key, session.startedBy);
		}
		return [
			{ value: "all", label: "Anyone" },
			...Array.from(seen.entries())
				.sort((a, b) => a[1].localeCompare(b[1]))
				.map(([value, label]) => ({ value, label })),
		];
	}, [pool]);

	const repoOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of pool) {
			const project = sessionRepo(session);
			counts.set(project, (counts.get(project) || 0) + 1);
		}
		return [
			{ value: "all", label: "Any repo" },
			...Array.from(counts.entries())
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([value]) => ({ value, label: value })),
		];
	}, [pool]);

	const statusOptions = useMemo(
		() => [
			{ value: "all", label: "Any status" },
			...STATUS_ORDER.map((value) => ({ value, label: STATUS_META[value].label })),
		],
		[],
	);
	const hasSessionFilter = person !== "all" || repo !== "all" || status !== "all";

	// Commands, PRs, and chats share one flat result list so arrow-key navigation
	// crosses group boundaries just like Tella's command menu.
	const results = useMemo<PaletteResult[]>(() => {
		const q = query.trim().toLowerCase();
		const terms = q.split(/\s+/).filter(Boolean);
		const matches = (values: Array<string | undefined>) => {
			if (terms.length === 0) return true;
			const text = values.filter(Boolean).join(" ").toLowerCase();
			return terms.every((term) => text.includes(term));
		};
		const actionResults: PaletteResult[] = (hasSessionFilter ? [] : actions)
			.filter((action) =>
				matches([
					action.label,
					action.description,
					...(action.keywords || []),
					...(action.shortcut || []),
				]),
			)
			.map((action) => ({ type: "action", category: action.category, action }));
		const prResults: PaletteResult[] = (hasSessionFilter ? [] : openPrs)
			.filter((pr) =>
				matches([
					pr.title,
					pr.repo,
					pr.branch,
					pr.author,
					`#${pr.number}`,
					prStatus(pr),
				]),
			)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, 40)
			.map((pr) => ({ type: "pr", category: "Pull requests", pr }));
		let sessionResults = pool.filter((s) => {
			if (person !== "all" && (s.startedBy || "").toLowerCase() !== person)
				return false;
			if (repo !== "all" && sessionRepo(s) !== repo) return false;
			if (status !== "all" && sessionStatus(s) !== status) return false;
			if (terms.length === 0) return true;
			// A session shows if its metadata matches every term OR the query turned
			// up inside its conversation (the backend transcript search).
			const hay = haystack(s);
			return terms.every((t) => hay.includes(t)) || snippets.has(s.id);
		});
		// Most-recently-active first — the same order the sidebar defaults to.
		sessionResults = sessionResults.sort(
			(a, b) =>
				new Date(b.lastActivity).getTime() -
				new Date(a.lastActivity).getTime(),
		);
		const sessionRows: PaletteResult[] = sessionResults.slice(0, 100).map((s) => {
			// Show the snippet only when the title/metadata didn't already match —
			// otherwise the row explains itself.
			const metaMatch = terms.length > 0 && terms.every((t) => haystack(s).includes(t));
			return {
				type: "session",
				category: "Sessions",
				session: s,
				snippet: metaMatch ? undefined : snippets.get(s.id),
			};
		});
		return [...actionResults, ...prResults, ...sessionRows];
	}, [actions, hasSessionFilter, openPrs, person, pool, query, repo, snippets, status]);
	const keyedActive = results.findIndex((result) => resultKey(result) === activeKey);
	const active = keyedActive >= 0 ? keyedActive : 0;

	// Keep the highlighted row scrolled into view during keyboard nav.
	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-idx="${active}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [active, activeKey, results.length]);

	// Result navigation only. Tab cycling, Escape and backdrop dismissal are the
	// dialog's job now (Modal → Base UI), so this handler no longer duplicates
	// them. A focused native <select> keeps its own arrow/Enter behavior.
	function onKeyDown(e: React.KeyboardEvent) {
		if (e.target instanceof HTMLSelectElement) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			const next = Math.min(active + 1, results.length - 1);
			if (results[next]) setActiveKey(resultKey(results[next]));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			const next = Math.max(active - 1, 0);
			if (results[next]) setActiveKey(resultKey(results[next]));
		} else if (e.key === "Enter") {
			e.preventDefault();
			selectResult(results[active]);
		}
	}

	function selectResult(result?: PaletteResult) {
		if (!result) return;
		onClose();
		if (result.type === "action") result.action.run();
		else if (result.type === "pr") onSelectPr(result.pr);
		else onSelectSession(result.session.id);
	}

	return (
		<Modal.Root
			open={open}
			// Escape and outside presses both land here; App unmounts us in turn.
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			// Focus is trapped, but the page isn't inerted or scroll-locked — the
			// palette has never done either, and inerting would break popups that
			// portal outside it.
			modal="trap-focus"
		>
			<Modal.Content
				variant="palette"
				// .ss-card also scopes the touch rule that hides the keyboard chrome.
				widthClassName="w-[min(640px,100%)]"
				className="ss-card flex h-[min(500px,76vh)] w-[min(640px,100%)] flex-col max-[560px]:h-[min(560px,82vh)]"
				aria-label="Command menu"
				initialFocus={inputRef}
				onKeyDown={onKeyDown}
			>
				<div className="ss-search-row flex items-center gap-2.5 border-b border-line px-4 py-3.5">
					<IconSearch className="ss-search-icon shrink-0 text-faint" size={22} />
					<input
						ref={inputRef}
						className="ss-search-input min-w-0 flex-1 border-0 bg-transparent font-sans text-item-title leading-snug text-fg outline-none placeholder:text-faint"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setActiveKey(null);
						}}
						placeholder="Search actions, pull requests & conversations…"
						spellCheck={false}
						role="combobox"
						aria-label="Search commands and conversations"
						aria-autocomplete="list"
						aria-expanded="true"
						aria-controls="command-palette-results"
						aria-activedescendant={results[active] ? `command-result-${active}` : undefined}
					/>
					{(searching || loadingPrs) && (
						<span className="ss-searching h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-label="Searching" />
					)}
					<kbd className="ss-kbd">esc</kbd>
				</div>

				<div className="ss-filters flex flex-wrap items-center gap-1.5 border-b border-line px-3.5 py-2" aria-label="Session filters">
					<FilterPill
						label="Person"
						value={person}
						options={personOptions}
						onChange={setPerson}
					/>
					<FilterPill
						label="Repo"
						value={repo}
						options={repoOptions}
						onChange={setRepo}
					/>
					<FilterPill
						label="Status"
						value={status}
						options={statusOptions}
						onChange={(value) => setStatus(value as Status | "all")}
					/>
					{hasSessionFilter && (
						<button
							className="ss-clear ml-auto rounded-md border-0 bg-transparent px-1.5 py-1 text-supporting text-faint hover:bg-hover hover:text-fg"
							onClick={() => {
								setPerson("all");
								setRepo("all");
								setStatus("all");
							}}
						>
							Clear
						</button>
					)}
				</div>

				<div
					id="command-palette-results"
					className="ss-results min-h-0 flex-1 overflow-y-auto p-1.5"
					ref={listRef}
					role="listbox"
				>
					{results.length === 0 && (
							<div className="ss-empty px-4 py-7 text-center text-control-label text-faint">
							{searching ? "Searching conversations…" : "Nothing found"}
						</div>
					)}
					{results.map((result, i) => {
						const startsGroup = i === 0 || results[i - 1]?.category !== result.category;
						if (result.type === "action") {
							return (
								<React.Fragment key={`action:${result.action.id}`}>
									{startsGroup && <div className="ss-group-heading px-2.5 pb-1 pt-2.5 text-label font-semibold text-faint">{result.category}</div>}
									<button
										id={`command-result-${i}`}
										data-idx={i}
										type="button"
										role="option"
										aria-selected={i === active}
										tabIndex={-1}
										className={`ss-item ss-command-item flex w-full items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left text-fg${i === active ? " ss-item-active bg-active" : ""}`}
										onMouseMove={() => setActiveKey(resultKey(result))}
										onClick={() => selectResult(result)}
									>
										{result.action.icon && (
											<span className={`ss-command-icon inline-flex h-5 w-5 shrink-0 items-center justify-center text-dim${i === active ? " text-fg" : ""}`}>{result.action.icon}</span>
										)}
										<span className="ss-item-main flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="ss-item-title truncate text-control-label font-medium">{result.action.label}</span>
											{result.action.description && (
												<span className="ss-item-snippet line-clamp-1 text-meta leading-snug text-faint">{result.action.description}</span>
											)}
										</span>
										{result.action.shortcut && (
											<span className="ss-shortcut inline-flex shrink-0 items-center gap-0.5">
												{result.action.shortcut.map((key) => <kbd key={key} className="ss-kbd">{key}</kbd>)}
											</span>
										)}
									</button>
								</React.Fragment>
							);
						}
						if (result.type === "pr") {
							const pr = result.pr;
							return (
								<React.Fragment key={`pr:${pr.url}`}>
									{startsGroup && <div className="ss-group-heading px-2.5 pb-1 pt-2.5 text-label font-semibold text-faint">{result.category}</div>}
									<button
										id={`command-result-${i}`}
										data-idx={i}
										type="button"
										role="option"
										aria-selected={i === active}
										tabIndex={-1}
										className={`ss-item flex w-full items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left text-fg${i === active ? " ss-item-active bg-active" : ""}`}
										onMouseMove={() => setActiveKey(resultKey(result))}
										onClick={() => selectResult(result)}
									>
										<span className={`ss-command-icon inline-flex h-5 w-5 shrink-0 items-center justify-center text-dim${i === active ? " text-fg" : ""}`}><IconPullRequest size={18} /></span>
										<span className="ss-item-main flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="ss-item-title truncate text-control-label font-medium">{pr.title}</span>
											<span className="ss-item-meta flex min-w-0 items-center gap-1.5 text-meta text-faint">
												<span className="ss-item-repo">{repoLabel(pr.repo)} #{pr.number}</span>
												<span className="ss-item-branch">{pr.branch}</span>
												<span>{pr.author}</span>
											</span>
										</span>
										<span className="ss-item-status shrink-0 text-meta text-dim">{prStatus(pr)}</span>
									</button>
								</React.Fragment>
							);
						}
						const s = result.session;
						const st = sessionStatus(s);
						const meta = STATUS_META[st];
						return (
							<React.Fragment key={`session:${s.id}`}>
								{startsGroup && <div className="ss-group-heading px-2.5 pb-1 pt-2.5 text-label font-semibold text-faint">{result.category}</div>}
								<button
									id={`command-result-${i}`}
									data-idx={i}
									type="button"
									role="option"
									aria-selected={i === active}
									tabIndex={-1}
									className={`ss-item flex w-full items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left text-fg${i === active ? " ss-item-active bg-active" : ""}`}
									onMouseMove={() => setActiveKey(resultKey(result))}
									onClick={() => selectResult(result)}
								>
									<span className={`ss-item-dot h-2 w-2 shrink-0 rounded-full ${meta.dotClass}`} />
									<span className="ss-item-main flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="ss-item-title truncate text-control-label font-medium">{s.title}</span>
										{result.snippet && (
											<span className="ss-item-snippet line-clamp-1 text-meta leading-snug text-faint">{result.snippet}</span>
										)}
										<span className="ss-item-meta flex min-w-0 items-center gap-1.5 text-meta text-faint">
											{s.automation ? (
												<span className="ss-tag ss-tag-auto">{s.automation}</span>
											) : (
												s.startedBy && <span>{s.startedBy}</span>
											)}
											<span className="ss-item-repo">{sessionRepo(s)}</span>
											{s.branch && <span className="ss-item-branch">{s.branch}</span>}
											<span className="ss-item-time">{relativeTime(s.lastActivity)}</span>
										</span>
									</span>
									<span className="ss-item-status shrink-0 text-meta text-dim">{meta.label}</span>
								</button>
							</React.Fragment>
						);
					})}
				</div>

				<div className="ss-hint flex items-center gap-3 border-t border-line px-4 py-2 text-meta text-faint">
					<span>
						<kbd className="ss-kbd">↑</kbd>
						<kbd className="ss-kbd">↓</kbd> navigate
					</span>
					<span>
						<kbd className="ss-kbd">↵</kbd> open
					</span>
					<span className="ss-hint-count ml-auto">
						{results.length} result{results.length === 1 ? "" : "s"}
					</span>
				</div>
			</Modal.Content>
		</Modal.Root>
	);
}
