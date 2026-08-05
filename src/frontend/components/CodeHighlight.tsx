import React, { useEffect, useRef, useState } from "react";
import type { ShikiRequest } from "../lib/shiki-engine";

const MAX_HIGHLIGHT_CHARS = 20_000;
const CACHE_MAX = 300;
const cache = new Map<string, string | null>();
const pending = new Map<
	number,
	{ resolve: (html: string | null) => void; reject: (error: unknown) => void }
>();
let worker: Worker | null = null;
let requestId = 0;

function resolvedTheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useResolvedTheme(): "dark" | "light" {
	const [theme, setTheme] = useState<"dark" | "light">(resolvedTheme);
	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => setTheme(resolvedTheme()));
		observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return theme;
}

function cacheKey(request: ShikiRequest): string {
	let hash = 2166136261;
	for (let i = 0; i < request.code.length; i++) {
		hash ^= request.code.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return [
		request.theme,
		request.lang,
		request.gutter ? 1 : 0,
		request.requireGutter ? 1 : 0,
		request.code.length,
		hash >>> 0,
	].join(":");
}

function remember(key: string, value: string | null) {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/**
 * Imported by the blob worker. Keeping the engine behind this dynamic import
 * means the multi-MB grammars are neither parsed nor initialized on the UI
 * thread in the normal path.
 */
export async function runShikiWorker(request: ShikiRequest) {
	const { renderShiki } = await import("../lib/shiki-engine");
	return renderShiki(request);
}

function getWorker(): Worker | null {
	if (worker || typeof Worker === "undefined") return worker;
	try {
		const moduleUrl = import.meta.url;
		const source = `
			import { runShikiWorker } from ${JSON.stringify(moduleUrl)};
			self.onmessage = async ({ data }) => {
				try {
					const html = await runShikiWorker(data.request);
					self.postMessage({ id: data.id, html });
				} catch (error) {
					self.postMessage({ id: data.id, error: String(error) });
				}
			};
		`;
		const url = URL.createObjectURL(
			new Blob([source], { type: "text/javascript" }),
		);
		worker = new Worker(url, { type: "module", name: "chat-shiki" });
		URL.revokeObjectURL(url);
		worker.onmessage = ({ data }) => {
			const job = pending.get(data.id);
			if (!job) return;
			pending.delete(data.id);
			if (data.error) job.reject(new Error(data.error));
			else job.resolve(data.html ?? null);
		};
		worker.onerror = (error) => {
			for (const job of pending.values()) job.reject(error);
			pending.clear();
			worker?.terminate();
			worker = null;
		};
	} catch {
		worker = null;
	}
	return worker;
}

async function highlight(request: ShikiRequest): Promise<string | null> {
	if (request.code.length > MAX_HIGHLIGHT_CHARS) return null;
	const key = cacheKey(request);
	if (cache.has(key)) return cache.get(key)!;
	const target = getWorker();
	let html: string | null;
	if (target) {
		html = await new Promise<string | null>((resolve, reject) => {
			const id = ++requestId;
			pending.set(id, { resolve, reject });
			target.postMessage({ id, request });
		}).catch(async () => runShikiWorker(request));
	} else {
		html = await runShikiWorker(request);
	}
	remember(key, html);
	return html;
}

export async function highlightToHtml(
	code: string,
	lang: string,
): Promise<string | null> {
	return highlight({ code, lang, theme: resolvedTheme() });
}

function useVisible<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const node = ref.current;
		if (!node || typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const root = node.closest(".viewer-messages");
		const observer = new IntersectionObserver(
			([entry]) => setVisible(Boolean(entry?.isIntersecting)),
			{ root, rootMargin: "800px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return [ref, visible] as const;
}

interface Props {
	code: string;
	lang: string;
	gutter?: boolean;
	requireGutter?: boolean;
}

/** Plain immediately; worker-highlighted only once inside the viewport overscan. */
export function CodeHighlight({ code, lang, gutter, requireGutter }: Props) {
	const [html, setHtml] = useState<string | null>(null);
	const [theme, setTheme] = useState<"dark" | "light">(resolvedTheme);
	const [ref, visible] = useVisible<HTMLDivElement>();

	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => setTheme(resolvedTheme()));
		observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!visible || code.length > MAX_HIGHLIGHT_CHARS) return;
		let alive = true;
		setHtml(null);
		highlight({ code, lang, theme, gutter, requireGutter })
			.then((next) => {
				if (alive) setHtml(next);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [code, gutter, lang, requireGutter, theme, visible]);

	return (
		<div ref={ref} className="[&_.tool-pre]:m-0 [&_.tool-pre]:max-h-80 [&_.tool-pre]:overflow-y-auto [&_.tool-pre]:break-words [&_.tool-pre]:whitespace-pre-wrap [&_.tool-pre]:font-mono [&_.tool-pre]:text-supporting [&_.tool-pre]:leading-normal [&_.tool-pre]:text-dim [&_.tool-pre]:[tab-size:2] [&_.tool-pre-code_pre.shiki]:m-0 [&_.tool-pre-code_pre.shiki]:bg-transparent! [&_.tool-pre-code_pre.shiki]:p-0 [&_.tool-pre-code_pre.shiki]:font-inherit [&_.tool-pre-code_pre.shiki]:text-inherit [&_.tool-pre-code_pre.shiki]:leading-inherit [&_.tool-pre-code_pre.shiki]:whitespace-pre-wrap [&_.tool-pre-code_pre.shiki]:break-words [&_.shiki-gutter]:select-none [&_.shiki-gutter]:text-faint">
			{html === null ? (
				<pre className="tool-pre">{code}</pre>
			) : (
				<div
					className="tool-pre tool-pre-code"
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			)}
		</div>
	);
}
