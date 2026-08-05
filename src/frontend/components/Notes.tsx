import { BASE_PATH } from "../lib/base";
import { shareOrCopyLink } from "../lib/share-link";
import React, {
	Suspense,
	lazy,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { marked } from "marked";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
	fetchWikiTree,
	fetchWikiFile,
	searchWikiApi,
	searchNotesApi,
	fetchNote,
	fetchNoteBacklinks,
	createNoteApi,
	deleteNoteApi,
	promptNoteApi,
	type NoteMeta,
	type NoteSearchHit,
} from "../lib/api";
import type { WSClientMessage, WSServerMessage } from "../lib/types";
import type { MentionKind } from "./NoteEditor";
import { PRODUCT_NAME, DEFAULT_DOC_TITLE } from "../lib/brand";
import { cn } from "../ui/cn";

const NoteEditor = lazy(() => import("./NoteEditor"));

interface WikiNode {
	name: string;
	path: string;
	type: "dir" | "file";
	children?: WikiNode[];
}
interface SearchHit {
	path: string;
	title: string;
	line: number;
	snippet: string;
}

export type NotesSelection =
	| { kind: "note"; id: string }
	| { kind: "doc"; path: string }
	| null;

interface Props {
	sel: NotesSelection;
	notes: NoteMeta[];
	refreshNotes: () => void;
	pinnedNoteIds: Set<string>;
	onTogglePinNote: (id: string) => void;
	onSelectNote: (id: string) => void;
	onSelectDoc: (path: string | null) => void;
	sessions: { id: string; title: string }[];
	onOpenSession: (id: string) => void;
	user: string;
	connected: boolean;
	send: (msg: WSClientMessage) => void;
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
}

function flattenPaths(nodes: WikiNode[]): string[] {
	const out: string[] = [];
	const walk = (ns: WikiNode[]) => {
		for (const n of ns) {
			if (n.type === "file") out.push(n.path);
			else if (n.children) walk(n.children);
		}
	};
	walk(nodes);
	return out;
}
function ancestorDirs(docPath: string): string[] {
	const parts = docPath.split("/");
	const dirs: string[] = [];
	for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
	return dirs;
}
function stripFrontmatter(md: string): string {
	if (!md.startsWith("---\n")) return md;
	const end = md.indexOf("\n---", 4);
	if (end === -1) return md;
	return md.slice(end + 4).replace(/^\n+/, "");
}

function WikiTree({
	paths,
	docPath,
	onOpen,
}: {
	paths: string[];
	docPath: string | null;
	onOpen: (path: string) => void;
}) {
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const { model } = useFileTree({
		paths,
		initialExpandedPaths: docPath ? ancestorDirs(docPath) : [],
		initialSelectedPaths: docPath ? [docPath] : undefined,
		onSelectionChange: (selected) => {
			const p = selected[0] ? String(selected[0]) : null;
			if (p && /\.(md|mdx)$/.test(p)) onOpenRef.current(p);
		},
	});
	return <FileTree model={model} className="wiki-filetree" />;
}

export function Notes({
	sel,
	notes,
	refreshNotes,
	pinnedNoteIds,
	onTogglePinNote,
	onSelectNote,
	onSelectDoc,
	sessions,
	onOpenSession,
	user,
	connected,
	send,
	addHandler,
}: Props) {
	const [tree, setTree] = useState<WikiNode[]>([]);
	const [docContent, setDocContent] = useState<string | null>(null);
	const [loadingDoc, setLoadingDoc] = useState(false);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[] | null>(null);
	const [noteHits, setNoteHits] = useState<NoteSearchHit[]>([]);
	const [navOpen, setNavOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newTitle, setNewTitle] = useState("");

	const selNoteId = sel?.kind === "note" ? sel.id : null;
	const selDocPath = sel?.kind === "doc" ? sel.path : null;

	useEffect(() => {
		fetchWikiTree()
			.then(setTree)
			.catch(() => {});
	}, []);

	const paths = useMemo(() => flattenPaths(tree), [tree]);

	useEffect(() => {
		const note = selNoteId ? notes.find((n) => n.id === selNoteId) : null;
		document.title = note
			? `${note.title} — Notes — ${PRODUCT_NAME}`
			: selDocPath
				? `${selDocPath.split("/").pop()} — Docs — ${PRODUCT_NAME}`
				: `Notes — ${PRODUCT_NAME}`;
		return () => {
			document.title = DEFAULT_DOC_TITLE;
		};
	}, [selNoteId, selDocPath, notes]);

	// Load a selected doc (read-only).
	useEffect(() => {
		if (!selDocPath) {
			setDocContent(null);
			return;
		}
		setLoadingDoc(true);
		fetchWikiFile(selDocPath)
			.then((f) => setDocContent(f.content))
			.catch(() => setDocContent("*Document not found.*"))
			.finally(() => setLoadingDoc(false));
	}, [selDocPath]);

	// Debounced search — notes and docs in one box.
	useEffect(() => {
		if (query.trim().length < 2) {
			setHits(null);
			setNoteHits([]);
			return;
		}
		const t = setTimeout(() => {
			searchWikiApi(query)
				.then(setHits)
				.catch(() => {});
			searchNotesApi(query)
				.then(setNoteHits)
				.catch(() => {});
		}, 250);
		return () => clearTimeout(t);
	}, [query]);

	const docHtml = useMemo(() => {
		if (!docContent) return "";
		try {
			return marked.parse(stripFrontmatter(docContent), {
				async: false,
			}) as string;
		} catch {
			return `<pre>${docContent}</pre>`;
		}
	}, [docContent]);

	function openDoc(path: string) {
		setQuery("");
		setHits(null);
		setNavOpen(false);
		onSelectDoc(path);
	}

	async function doCreate() {
		const title = newTitle.trim();
		setCreating(false);
		setNewTitle("");
		try {
			const note = await createNoteApi(title || undefined);
			refreshNotes();
			onSelectNote(note.id);
		} catch (e) {
			console.error("Create note failed:", e);
		}
	}

	async function doDelete(id: string, e: React.MouseEvent) {
		e.stopPropagation();
		if (!confirm("Delete this note? This affects everyone.")) return;
		try {
			await deleteNoteApi(id);
			refreshNotes();
			if (selNoteId === id) onSelectDoc(null);
		} catch (err) {
			console.error("Delete note failed:", err);
		}
	}

	function navigateMention(kind: MentionKind, target: string) {
		if (kind === "session") onOpenSession(target);
		else if (kind === "note") onSelectNote(target);
		else onSelectDoc(target);
	}

	return (
        <div className="flex min-h-0 flex-1">
            <div className={cn("flex min-h-0 w-[300px] shrink-0 flex-col border-r border-line bg-raised max-[920px]:fixed max-[920px]:inset-y-[var(--header-h)] max-[920px]:left-0 max-[920px]:z-30 max-[920px]:w-[min(320px,88vw)] max-[920px]:-translate-x-full max-[920px]:shadow-[12px_0_32px_rgba(0,0,0,0.5)] max-[920px]:transition-transform", navOpen && "max-[920px]:translate-x-0")}>
				{/* Notes section (writable, shared) */}
                <div className="flex min-h-0 flex-col">
                    <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5 text-meta font-bold text-faint">
						<span>Notes</span>
						<button
                            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-body leading-none text-dim hover:bg-hover hover:text-fg"
							title="New note"
							onClick={() => setCreating((c) => !c)}
						>
							＋
						</button>
					</div>
					{creating && (
						<input
                            className="mx-2.5 mb-1.5 mt-0.5 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-control-label text-fg outline-none focus:border-accent"
							autoFocus
							placeholder="Note title…"
							value={newTitle}
							onChange={(e) => setNewTitle(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") doCreate();
								else if (e.key === "Escape") {
									setCreating(false);
									setNewTitle("");
								}
							}}
							onBlur={() => doCreate()}
						/>
					)}
                    <div className="max-h-[38vh] overflow-y-auto px-1.5 pb-1.5">
						{notes.length === 0 && !creating ? (
                            <div className="px-3.5 py-1.5 text-label text-faint">No notes yet</div>
						) : (
							notes.map((n) => (
								<div
									key={n.id}
                                    className={cn("group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-dim hover:bg-hover hover:text-fg", selNoteId === n.id && "bg-active text-fg")}
									onClick={() => {
										setNavOpen(false);
										onSelectNote(n.id);
									}}
									title={n.title}
								>
                                    <span className="flex-1 truncate text-control-label">{n.title}</span>
									<span
                                        className={cn("px-0.5 text-label text-faint opacity-0 group-hover:opacity-80", pinnedNoteIds.has(n.id) && "text-yellow opacity-100")}
										title={pinnedNoteIds.has(n.id) ? "Unpin tab" : "Pin as tab"}
										onClick={(e) => {
											e.stopPropagation();
											onTogglePinNote(n.id);
										}}
									>
										{pinnedNoteIds.has(n.id) ? "★" : "☆"}
									</span>
									<span
                                        className="px-0.5 text-label text-faint opacity-0 group-hover:opacity-80 hover:text-red"
										title="Delete note"
										onClick={(e) => doDelete(n.id, e)}
									>
										✕
									</span>
								</div>
							))
						)}
					</div>
				</div>

				{/* Docs section (read-only wiki) */}
                <div className="mt-1.5 flex min-h-0 flex-1 flex-col border-t border-line pt-1">
                    <div className="flex items-center justify-between px-3.5 pb-1 pt-2.5 text-meta font-bold text-faint">
						<span>Docs</span>
					</div>
                    <div className="border-b border-line p-3">
						<input
                            className="w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-control-label text-fg outline-none placeholder:text-faint focus:border-accent"
							placeholder="Search notes + docs…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
					</div>
					{hits !== null ? (
                        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-6 pt-2">
							{noteHits.map((h) => (
								<button
									key={`note-${h.id}`}
                                    className="flex w-full min-w-0 flex-col gap-px rounded-md border-0 bg-transparent px-2.5 py-2 text-left hover:bg-hover"
									onClick={() => {
										setQuery("");
										setHits(null);
										setNavOpen(false);
										onSelectNote(h.id);
									}}
								>
                                    <span className="text-control-label font-semibold text-fg">📝 {h.title}</span>
                                    <span className="truncate text-label text-dim">{h.snippet}</span>
                                    <span className="truncate font-mono text-meta text-faint">note</span>
								</button>
							))}
							{hits.length === 0 && noteHits.length === 0 ? (
                                <div className="px-0 py-6 text-center text-control-label text-faint">No results</div>
							) : (
								hits.map((h, i) => (
									<button
										key={i}
                                        className="flex w-full min-w-0 flex-col gap-px rounded-md border-0 bg-transparent px-2.5 py-2 text-left hover:bg-hover"
										onClick={() => openDoc(h.path)}
									>
                                        <span className="text-control-label font-semibold text-fg">{h.title}</span>
                                        <span className="truncate text-label text-dim">{h.snippet}</span>
                                        <span className="truncate font-mono text-meta text-faint">{h.path}</span>
									</button>
								))
							)}
						</div>
					) : (
                        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-4 pt-1.5">
							{paths.length > 0 && (
								<WikiTree paths={paths} docPath={selDocPath} onOpen={openDoc} />
							)}
						</div>
					)}
				</div>
			</div>

			<div
                className={cn("min-w-0 flex-1 overflow-y-auto px-8 pb-20 pt-6 max-[920px]:px-4 max-[920px]:pb-[60px] max-[920px]:pt-4", selNoteId && "flex overflow-hidden p-0")}
			>
				<button
                    className="mb-3.5 hidden rounded-md border border-line-strong bg-panel px-3 py-1.5 text-control-label text-dim max-[920px]:inline-block"
					onClick={() => setNavOpen(!navOpen)}
				>
					☰ Browse
				</button>

				{selNoteId ? (
					<NotePane
						key={selNoteId}
						noteId={selNoteId}
						user={user}
						connected={connected}
						send={send}
						addHandler={addHandler}
						sessions={sessions}
						notes={notes.map((n) => ({ id: n.id, title: n.title }))}
						onOpenMention={navigateMention}
					/>
				) : selDocPath ? (
					loadingDoc ? (
						<div className="loading">Loading…</div>
					) : (
						<>
                            <div className="mb-4 font-mono text-meta text-faint">{selDocPath}</div>
							<div
								className="markdown wiki-doc"
								dangerouslySetInnerHTML={{ __html: docHtml }}
							/>
						</>
					)
				) : (
                    <div className="mx-auto my-[60px] max-w-[560px] text-center text-dim">
						<h2>Notes</h2>
						<p>
							Shared, real-time collaborative notes — todos and longer ideas,
							edited live together. Create one with <b>＋</b>, @-tag
							sessions/notes/docs, pin a note as a tab, or prompt Haiku to
							update it.
						</p>
                        <p className="text-control-label text-faint">
							The <b>Docs</b> section below is the read-only knowledge base from{" "}
							<code>the default repository's docs</code>.
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

/** Right pane for an open note: presence + editor (top) + prompt bar (bottom). */
function NotePane({
	noteId,
	user,
	connected,
	send,
	addHandler,
	sessions,
	notes,
	onOpenMention,
}: {
	noteId: string;
	user: string;
	connected: boolean;
	send: Props["send"];
	addHandler: Props["addHandler"];
	sessions: Props["sessions"];
	notes: { id: string; title: string }[];
	onOpenMention: (kind: MentionKind, target: string) => void;
}) {
	const [viewers, setViewers] = useState<string[]>([]);
	const [promptOpen, setPromptOpen] = useState(true);
	const [prompt, setPrompt] = useState("");
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<string | null>(null); // rendered HTML, null = editing
	const [backlinks, setBacklinks] = useState<Array<{ id: string; title: string }>>([]);
	const [discussing, setDiscussing] = useState(false);

	// Presence for this note.
	useEffect(() => {
		setViewers([]);
		return addHandler((msg) => {
			if (msg.type === "note_presence" && msg.noteId === noteId)
				setViewers(msg.viewers);
		});
	}, [noteId, addHandler]);

	// Who links here — refreshed when the note changes.
	useEffect(() => {
		setBacklinks([]);
		setPreview(null);
		fetchNoteBacklinks(noteId)
			.then(setBacklinks)
			.catch(() => {});
	}, [noteId]);

	async function togglePreview() {
		if (preview !== null) {
			setPreview(null);
			return;
		}
		try {
			const note = await fetchNote(noteId);
			setPreview(marked.parse(note.text, { async: false }) as string);
		} catch {
			setPreview(null);
		}
	}

	// Spin off an Ask session seeded with the note — "discuss this with
	// the agent". The App navigates into it on session_created.
	async function discuss() {
		if (discussing) return;
		setDiscussing(true);
		try {
			const note = await fetchNote(noteId);
			send({
				type: "create_session",
				mode: "ask",
				branch: "",
				prompt: `We're discussing the shared note "${note.title}" (open it at ${BASE_PATH}/notes/${noteId}). Read it below, then help me think it through / answer questions about it. If we land on changes, propose the new text — I can paste it into the note or run it through the note's prompt bar.\n\n---\n\n${note.text}`,
				user,
				createWorkspace: {},
			} as any);
		} catch {
			setDiscussing(false);
		}
	}

	async function runPrompt() {
		const text = prompt.trim();
		if (!text || running) return;
		setRunning(true);
		setError(null);
		try {
			await promptNoteApi(noteId, text);
			setPrompt(""); // the rewrite arrives live over the WS
		} catch (e: any) {
			setError(e?.message || "Update failed");
		} finally {
			setRunning(false);
		}
	}

	const others = viewers.filter((v) => v !== user);
	const [copied, setCopied] = useState(false);

	function shareNote() {
		const link = `${location.origin}${BASE_PATH}/notes/${encodeURIComponent(noteId)}`;
		// Phone: native share sheet. Elsewhere: copy ("✓ Link copied" flash).
		shareOrCopyLink(link, {
			onCopied: () => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1600);
			},
		});
	}

	return (
        <div className="flex h-full min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-3.5 py-2">
                <span className="font-mono text-label text-faint">{noteId}</span>
				{others.length > 0 && (
					<span
                        className="inline-flex items-center gap-1"
						title={`Also here: ${others.join(", ")}`}
					>
						{others.slice(0, 4).map((v, i) => (
                            <span key={i} className="inline-flex size-[18px] items-center justify-center rounded-full bg-purple text-meta font-bold text-white">
								{v.charAt(0).toUpperCase()}
							</span>
						))}
                        <span className="ml-0.5 text-meta text-dim">editing</span>
					</span>
				)}
				<button
                    className="ml-auto whitespace-nowrap rounded-md border border-line-strong bg-panel px-2.5 py-1 text-label text-dim hover:bg-hover hover:text-fg"
					onClick={togglePreview}
					title={preview !== null ? "Back to editing" : "Preview the rendered markdown"}
				>
					{preview !== null ? "✎ Edit" : "◫ Preview"}
				</button>
				<button
                    className="whitespace-nowrap rounded-md border border-line-strong bg-panel px-2.5 py-1 text-label text-dim hover:bg-hover hover:text-fg"
					onClick={discuss}
					disabled={discussing}
					title="Start an Ask session seeded with this note"
				>
					{discussing ? "Starting…" : "💬 Discuss"}
				</button>
				<button
                    className="whitespace-nowrap rounded-md border border-line-strong bg-panel px-2.5 py-1 text-label text-dim hover:bg-hover hover:text-fg"
					onClick={shareNote}
					title="Copy a link to this note"
				>
					{copied ? "✓ Link copied" : "⤴ Share"}
				</button>
			</div>

            <div className="flex min-h-0 flex-1 overflow-hidden">
				{preview !== null ? (
					<div
						className="markdown wiki-doc overflow-y-auto px-[18px] py-4"
						dangerouslySetInnerHTML={{ __html: preview }}
					/>
				) : (
					<Suspense fallback={<div className="loading">Loading editor…</div>}>
						<NoteEditor
							noteId={noteId}
							user={user}
							connected={connected}
							send={send}
							addHandler={addHandler}
							sessions={sessions}
							notes={notes}
							onOpenMention={onOpenMention}
						/>
					</Suspense>
				)}
			</div>

			{backlinks.length > 0 && (
				<div className="flex items-baseline gap-1.5 flex-wrap px-[18px] py-1.5 border-t border-line text-label">
					<span className="text-faint shrink-0">Linked from</span>
					{backlinks.map((b) => (
						<button
							key={b.id}
                            className="inline-flex cursor-pointer items-center gap-px whitespace-nowrap rounded-full border border-green/30 bg-green-soft px-1.5 py-px text-label text-green hover:brightness-110"
							onClick={() => onOpenMention("note", b.id)}
							title={`Open “${b.title}”`}
						>
							📝 {b.title}
						</button>
					))}
				</div>
			)}

			<div
                className="shrink-0 border-t border-line bg-raised px-2.5 pb-2 pt-1.5"
			>
				<button
                    className={cn("inline-flex items-center gap-1.5 border-0 bg-transparent py-px text-meta text-faint hover:text-dim", running && "text-accent")}
					onClick={() => setPromptOpen((o) => !o)}
					title={promptOpen ? "Collapse" : "Expand"}
				>
                    <span className={cn("inline-block transition-transform", promptOpen && "rotate-90")}>
						›
					</span>
					prompt
                    {running && <span className="inline-block size-[11px] animate-spin rounded-full border-2 border-line-strong border-t-accent" />}
				</button>
				{promptOpen &&
					(running ? (
                        <div className="flex items-center gap-2 rounded-md border border-line-strong bg-panel px-3 py-2 text-control-label text-dim">
                            <span className="inline-block size-[15px] animate-spin rounded-full border-2 border-line-strong border-t-accent" />
							<span>Haiku is updating the note…</span>
						</div>
					) : (
						<textarea
                            className="block h-[30px] min-h-[30px] max-h-[140px] w-full resize-none rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-control-label leading-snug text-fg outline-none focus:border-accent"
							placeholder="Ask Haiku to update this note… (↵ to run)"
							value={prompt}
							onChange={(e) => {
								setPrompt(e.target.value);
								// Auto-grow with the draft — the CSS height is a fixed single
								// row, so a Shift+Enter newline would otherwise land invisibly.
								const el = e.target;
								el.style.height = "auto";
								el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									runPrompt();
								}
							}}
						/>
					))}
                {error && <div className="mt-1 text-label text-red">{error}</div>}
			</div>
		</div>
	);
}
