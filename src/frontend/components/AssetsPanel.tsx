/**
 * Assets tab — the session's scratch folder of agent-produced artifacts
 * (HTML/JS visualizations, reports, diagrams, sample data; see
 * src/server/session-assets.ts). Split view: file tree on top, live preview
 * below. HTML previews in an iframe served from the path-based raw route, so
 * relative references between assets (./style.css, ./data.json) resolve.
 */

import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { marked } from "marked";
import {
	deleteSessionAssetApi,
	fetchSessionAssets,
	sessionAssetRawUrl,
	type SessionAssetFile,
} from "../lib/api";
import type { WSServerMessage } from "../lib/types";
import { parseNewSessionLink, type NewSessionPrefill } from "../lib/new-session-link";
import { Button } from "../ui/button";
import { MarkdownBody } from "./MarkdownBody";

/** Lives in SessionViewer (not the panel) so the tab button can show/hide on
 *  the file count without the panel being mounted. */
export function useSessionAssets(
	sessionId: string,
	addHandler: (h: (msg: WSServerMessage) => void) => () => void,
) {
	const [files, setFiles] = useState<SessionAssetFile[]>([]);
	const refresh = useCallback(() => {
		fetchSessionAssets(sessionId)
			.then((r) => setFiles(r.files || []))
			.catch(() => {});
	}, [sessionId]);
	useEffect(() => {
		setFiles([]);
		refresh();
	}, [refresh]);
	useEffect(
		() =>
			addHandler((msg) => {
				if (msg.type === "assets_changed" && msg.sessionId === sessionId)
					refresh();
			}),
		[addHandler, sessionId, refresh],
	);
	return { files, refresh };
}

type PreviewKind =
	| "html"
	| "pdf"
	| "image"
	| "video"
	| "audio"
	| "markdown"
	| "text"
	| "binary";

function previewKind(path: string): PreviewKind {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "html" || ext === "htm" || ext === "svg") return "html";
	if (ext === "pdf") return "pdf";
	if (["png", "jpg", "jpeg", "gif", "webp", "ico"].includes(ext))
		return "image";
	if (["mp4", "webm", "mov"].includes(ext)) return "video";
	if (["mp3", "wav"].includes(ext)) return "audio";
	if (ext === "md") return "markdown";
	if (
		[
			"txt", "js", "mjs", "ts", "tsx", "jsx", "css", "json", "csv", "tsv",
			"xml", "yaml", "yml", "log", "py", "sh", "sql",
		].includes(ext)
	)
		return "text";
	return "binary";
}

function fmtSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Every ancestor dir across the file set — small trees, keep them all open. */
function allDirs(paths: string[]): string[] {
	const dirs = new Set<string>();
	for (const p of paths) {
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++)
			dirs.add(parts.slice(0, i).join("/"));
	}
	return [...dirs];
}

function AssetsTree({
	paths,
	selected,
	onSelect,
}: {
	paths: string[];
	selected: string | null;
	onSelect: (path: string) => void;
}) {
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const { model } = useFileTree({
		paths,
		initialExpandedPaths: allDirs(paths),
		initialSelectedPaths: selected ? [selected] : undefined,
		onSelectionChange: (sel) => {
			const p = sel[0] ? String(sel[0]) : null;
			// Directory rows also select — only react to real files.
			if (p && paths.includes(p)) onSelectRef.current(p);
		},
	});
	return <FileTree model={model} className="wiki-filetree" />;
}

const TEXT_CAP = 256 * 1024;

export function AssetsPanel({
	sessionId,
	files,
	refresh,
	selectedPath = null,
	showTree = true,
	onOpenNewSession,
}: {
	sessionId: string;
	files: SessionAssetFile[];
	refresh: () => void;
	/** Controlled selection — when the Info-panel assets list opens a specific
	 *  asset, the main-tab panel previews it. */
	selectedPath?: string | null;
	/** Show the built-in file tree. false in the main-tab preview, where the
	 *  Info-panel assets list is the navigator instead. */
	showTree?: boolean;
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
	const [selected, setSelected] = useState<string | null>(selectedPath);
	// Follow the controlled selection when the list opens a new asset.
	useEffect(() => {
		if (selectedPath) setSelected(selectedPath);
	}, [selectedPath]);
	const paths = useMemo(() => files.map((f) => f.path), [files]);

	// Keep the selection while its file survives; otherwise default to the
	// shallowest index.html (the natural entry point of a multi-file viz),
	// else the first file.
	useEffect(() => {
		if (selected && paths.includes(selected)) return;
		const index = [...paths]
			.filter((p) => /(^|\/)index\.html$/.test(p))
			.sort((a, b) => a.split("/").length - b.split("/").length)[0];
		setSelected(index || paths[0] || null);
	}, [paths, selected]);

	const file = files.find((f) => f.path === selected) || null;
	const kind = selected ? previewKind(selected) : null;
	// mtime in the URL busts the iframe/img on every rewrite of the same path.
	const rawUrl =
		selected && file
			? `${sessionAssetRawUrl(sessionId, selected)}?v=${encodeURIComponent(file.mtime)}`
			: null;

	// Text-ish previews fetch the body themselves.
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		setText(null);
		if (!rawUrl || (kind !== "text" && kind !== "markdown")) return;
		let alive = true;
		fetch(rawUrl)
			.then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
			.then((t) => {
				if (alive) setText(t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t);
			})
			.catch(() => {
				if (alive) setText(null);
			});
		return () => {
			alive = false;
		};
	}, [rawUrl, kind]);

	async function onDelete() {
		if (!selected) return;
		if (!confirm(`Delete ${selected}?`)) return;
		try {
			await deleteSessionAssetApi(sessionId, selected);
			refresh();
		} catch {}
	}

	if (!files.length) {
		return (
			<div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
				<div className="text-control-label text-dim">No assets yet</div>
				<div className="max-w-[360px] text-label text-faint">
					Ask the agent to save a visualization, report, or demo page here —
					it writes files with opensession-assets' write_asset and they
					preview live in this tab.
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			{showTree ? (
			<div className="flex max-h-[38%] min-h-[88px] flex-col overflow-hidden border-b border-line">
				<div className="flex items-center justify-between px-3 pt-2 pb-1">
					<span className="text-meta font-medium uppercase tracking-wide text-faint">
						Files · {files.length}
					</span>
					<Button
						variant="ghost"
						size="xs"
						className="text-faint"
						onClick={refresh}
						title="Refresh the file list"
					>
						Refresh
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5">
					<AssetsTree
						key={paths.join("\n")}
						paths={paths}
						selected={selected}
						onSelect={setSelected}
					/>
				</div>
			</div>
			) : null}
			{file && rawUrl ? (
				<>
					<div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
						<span
							className="min-w-0 flex-1 truncate text-label text-fg"
							title={file.path}
						>
							{file.path}
						</span>
						<span className="shrink-0 text-meta text-faint">
							{fmtSize(file.size)}
						</span>
						<a
							className="shrink-0 rounded-sm px-1.5 py-0.5 text-meta text-dim hover:bg-hover hover:text-fg"
							href={rawUrl}
							target="_blank"
							rel="noreferrer"
						>
							Open
						</a>
						<a
							className="shrink-0 rounded-sm px-1.5 py-0.5 text-meta text-dim hover:bg-hover hover:text-fg"
							href={`${rawUrl}&download=1`}
						>
							Download
						</a>
						{/* Sits in a row with the Open/Download links above and matches
						    them exactly; only the hover color differs. */}
						<Button
							variant="ghost"
							size="xs"
							className="min-h-0 shrink-0 rounded-sm border-0 px-1.5 py-0.5 text-meta font-medium hover:bg-hover hover:text-red"
							onClick={onDelete}
						>
							Delete
						</Button>
					</div>
					<div className="min-h-0 flex-1 overflow-auto">
						{kind === "html" ? (
							// allow-same-origin so the page can fetch() sibling assets
							// (./data.json); the sandbox still blocks top navigation. The
							// content is our own agents' output on a tailnet-only UI.
							<iframe
								key={rawUrl}
								title={file.path}
								src={rawUrl}
								sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads"
								onLoad={(event) => {
									const document = event.currentTarget.contentDocument;
									if (!document) return;
									document.addEventListener("click", (clickEvent) => {
										const link = (clickEvent.target as Element | null)?.closest?.("a");
										const prefill = link ? parseNewSessionLink(link.href) : null;
										if (!prefill) return;
										clickEvent.preventDefault();
										onOpenNewSession(prefill);
									});
								}}
								className="h-full w-full border-0 bg-white"
							/>
						) : kind === "pdf" ? (
							// No sandbox: Chrome's built-in PDF viewer won't render in a
							// sandboxed iframe.
							<iframe
								key={rawUrl}
								title={file.path}
								src={rawUrl}
								className="h-full w-full border-0"
							/>
						) : kind === "image" ? (
							<div className="flex h-full items-center justify-center overflow-auto p-3">
								<img
									src={rawUrl}
									alt={file.path}
									className="max-h-full max-w-full object-contain"
								/>
							</div>
						) : kind === "video" ? (
							<video src={rawUrl} controls className="h-full w-full" />
						) : kind === "audio" ? (
							<div className="p-4">
								<audio src={rawUrl} controls className="w-full" />
							</div>
						) : kind === "markdown" ? (
							text === null ? (
								<div className="p-4 text-label text-faint">Loading…</div>
							) : (
								<MarkdownBody
								className="markdown px-4 py-3 text-control-label"
									html={marked.parse(text, { async: false }) as string}
								/>
							)
						) : kind === "text" ? (
							text === null ? (
								<div className="p-4 text-label text-faint">Loading…</div>
							) : (
								<pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-label leading-[1.5] text-fg">
									{text}
									{file.size > TEXT_CAP ? "\n… (truncated preview)" : ""}
								</pre>
							)
						) : (
							<div className="flex h-full items-center justify-center text-label text-faint">
								No inline preview for this file type — use Download.
							</div>
						)}
					</div>
				</>
			) : null}
		</div>
	);
}
