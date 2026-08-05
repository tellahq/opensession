import React, { useEffect, useRef, useState } from "react";
import { effectiveTheme, onThemeChanged, type EffectiveTheme } from "../lib/theme";

// Keep the stable `.markdown` hook for generated HTML while making the rendered
// document own its presentation instead of depending on adapter selectors.
export const MARKDOWN_STYLES = [
	"text-body leading-6 break-words",
	"[&_p]:mb-1.5 [&_p]:mt-0",
	"[&_a]:text-accent [&_a]:no-underline hover:[&_a]:underline",
	"[&_strong]:font-semibold [&_strong]:text-fg",
	"[&_pre]:my-0.5 [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line [&_pre]:bg-[#0c0c10] [&_pre]:px-3 [&_pre]:py-2.5 [&_pre]:font-mono [&_pre]:text-label [&_pre]:leading-[1.55] [html[data-theme=light]_&_*]:[color-scheme:light] [html[data-theme=light]_&_pre]:border-[#d8dee4] [html[data-theme=light]_&_pre]:bg-[#f6f8fa] [html[data-theme=light]_&_pre]:text-[#1f2328]",
	"[&_code]:rounded-sm [&_code]:bg-white/6 [&_code]:px-[5px] [&_code]:py-[1.5px] [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-[#dde1f0] [html[data-theme=light]_&_code]:bg-black/6 [html[data-theme=light]_&_code]:text-[#953b39] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-label [&_pre_code]:text-inherit",
	"[&_ul]:mb-1.5 [&_ul]:mt-0 [&_ul]:pl-5 [&_ol]:mb-1.5 [&_ol]:mt-0 [&_ol]:pl-5 [&_li]:my-[2.5px] [&_li>ul]:mb-0 [&_li>ul]:mt-0.5 [&_li>ol]:mb-0 [&_li>ol]:mt-0.5",
	"[&_h1]:mb-px [&_h1]:mt-1.5 [&_h1]:text-item-title [&_h1]:font-semibold [&_h1]:leading-[1.3] [&_h1]:text-fg [&_h2]:mb-px [&_h2]:mt-1.5 [&_h2]:text-body [&_h2]:font-semibold [&_h2]:leading-[1.3] [&_h2]:text-fg [&_h3]:mb-px [&_h3]:mt-1.5 [&_h3]:text-control-label [&_h3]:font-semibold [&_h3]:leading-[1.3] [&_h3]:text-fg [&_h4]:mb-px [&_h4]:mt-1.5 [&_h4]:text-control-label [&_h4]:font-semibold [&_h4]:leading-[1.3] [&_h4]:text-fg",
	"[&>:first-child]:mt-0 [&>:last-child]:mb-0",
	"[&_blockquote]:my-0.5 [&_blockquote]:mb-2 [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:px-3 [&_blockquote]:py-[3px] [&_blockquote]:text-dim",
	"[&_table]:my-0.5 [&_table]:mb-2.5 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-supporting [&_th]:border-b [&_th]:border-line-strong [&_th]:pb-[5px] [&_th]:pr-4 [&_th]:pt-1 [&_th]:text-left [&_th]:text-meta [&_th]:font-semibold [&_th]:tracking-[-0.01em] [&_th]:text-faint [&_td]:border-b [&_td]:border-line [&_td]:py-1.5 [&_td]:pr-4 [&_td]:align-top [&_tr:last-child_td]:border-b-0",
	"[&_hr]:my-3 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-line",
	"[&_img]:my-1.5 [&_img]:block [&_img]:h-auto [&_img]:max-h-[360px] [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-[#7f7f7f]/25",
	"[&_.md-details]:my-2 [&_.md-details]:overflow-hidden [&_.md-details]:rounded-md [&_.md-details]:border [&_.md-details]:border-line [&_.md-details]:bg-surface [&_.md-details>summary]:flex [&_.md-details>summary]:cursor-pointer [&_.md-details>summary]:items-center [&_.md-details>summary]:gap-1.5 [&_.md-details>summary]:px-3 [&_.md-details>summary]:py-2 [&_.md-details>summary]:font-semibold [&_.md-details>summary]:text-fg",
].join(" ");

/**
 * Rendered-markdown container that upgrades ```lang fences to shiki-highlighted
 * blocks after mount. Shiki is multi-MB, so it's only dynamically imported when
 * a message actually carries a language-tagged fence — plain messages render
 * the marked output untouched. Fences with no (or an unshipped) language keep
 * the stock .markdown <pre> styling.
 */
export function MarkdownBody({
	html,
	className,
}: {
	html: string;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [theme, setTheme] = useState<EffectiveTheme>(effectiveTheme);
	const [visible, setVisible] = useState(false);
	useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);
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

	useEffect(() => {
		// marked emits <code class="language-x"> only for tagged fences.
		if (!visible || !html.includes('<code class="language-')) return;
		const el = ref.current;
		if (!el) return;
		let alive = true;
		import("./CodeHighlight")
			.then(async (m) => {
				if (!alive || !ref.current) return;
				// Restore the pristine marked output first: a theme flip re-runs this
				// effect, and highlighting must start from the original fences, not
				// from the previous pass's shiki markup.
				ref.current.innerHTML = html;
				const blocks = Array.from(
					ref.current.querySelectorAll('pre > code[class*="language-"]'),
				);
				for (const code of blocks) {
					const lang = /language-([^\s"]+)/.exec(code.className)?.[1];
					if (!lang) continue;
					const raw = code.textContent ?? "";
					// Giant generated files stay a permanent plain <pre>; highlighting
					// them is expensive and adds little reading value.
					if (raw.length > 20_000) continue;
					const out = await m.highlightToHtml(raw, lang);
					const pre = code.parentElement;
					if (!alive || !out || !pre || !ref.current?.contains(pre)) continue;
					const tpl = document.createElement("template");
					tpl.innerHTML = out;
					const shikiPre = tpl.content.firstElementChild;
					if (shikiPre) {
						shikiPre.classList.add("md-code");
						pre.replaceWith(shikiPre);
					}
				}
			})
			.catch(() => {}); // highlight is progressive enhancement — plain pre stays
		return () => {
			alive = false;
		};
	}, [html, theme, visible]);

	return (
		<div
			ref={ref}
			className={[MARKDOWN_STYLES, className].filter(Boolean).join(" ")}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
