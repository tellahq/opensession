import type React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { attachCodeCopy, decorateCodeBlocks } from "../lib/code-copy";

// Lazy loaders live at module scope: the compiler cannot lower dynamic
// imports inside components.
let mermaidPromise: Promise<typeof import("../lib/mermaid")> | null = null;
function loadMermaid() {
  mermaidPromise ??= import("../lib/mermaid");
  return mermaidPromise;
}
let codeHighlightPromise: Promise<typeof import("./CodeHighlight")> | null =
  null;
function loadCodeHighlight() {
  codeHighlightPromise ??= import("./CodeHighlight");
  return codeHighlightPromise;
}
import {
  type EffectiveTheme,
  effectiveTheme,
  onThemeChanged,
} from "../lib/theme";
import { expandIconMarkup } from "./icons";

/**
 * The repo the markdown on this surface is about — what a bare `#5528` in it
 * refers to (see markdown.ts). Ambient rather than a prop because the callers
 * that render markdown are scattered several levels down a transcript
 * (ClampedBody, walkthroughs, ask cards, PR comments) and none of them
 * otherwise care which repo they are inside.
 */
const MarkdownRepoContext = createContext<string | undefined>(undefined);

export function MarkdownRepoProvider({
  repo,
  children,
}: {
  repo: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <MarkdownRepoContext.Provider value={repo || undefined}>
      {children}
    </MarkdownRepoContext.Provider>
  );
}

/** The repo to render markdown against — pass to `renderMarkdown(src, { repo })`. */
export function useMarkdownRepo(): string | undefined {
  return useContext(MarkdownRepoContext);
}

/**
 * Rendered-markdown container that upgrades ```lang fences after mount:
 * ```mermaid fences render as inline diagrams, every other tagged fence gets
 * shiki highlighting. Both libraries are multi-MB, so each is only dynamically
 * imported when a message actually carries a matching fence — plain messages
 * render the marked output untouched. Fences with no (or an unshipped)
 * language keep the stock .markdown <pre> styling.
 */
export function MarkdownBody({
  html,
  className,
  enhance = true,
}: {
  html: string;
  className?: string;
  /** Mermaid and syntax highlighting are landed-content enhancements. A live
   * stream keeps the cheap, readable marked output and upgrades once its
   * durable message replaces it. */
  enhance?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<EffectiveTheme>(effectiveTheme);
  const [visible, setVisible] = useState(false);
  // React 19 re-writes innerHTML whenever the dangerouslySetInnerHTML OBJECT
  // identity changes (it no longer compares the __html strings like 18 did),
  // and a rewrite silently destroys the mermaid/shiki upgrades below. A
  // stable object keeps unrelated re-renders (visibility flips, parent
  // updates) from resetting the DOM back to the plain fences.
  const innerHtml = { __html: html };
  // The (element, html, theme) combination whose upgrade last completed —
  // lets the effect skip redoing (and visibly flashing) work whose output is
  // already in the DOM, e.g. when scrolling a diagram out of and back into
  // the lazy-upgrade window. Keyed on the element too: a React remount gives
  // a fresh node with pristine fences that must upgrade again.
  const upgradedRef = useRef<{ el: HTMLDivElement; key: string } | null>(null);
  useEffect(() => {
    if (!enhance) return;
    return onThemeChanged(() => setTheme(effectiveTheme()));
  }, [enhance]);
  useEffect(() => {
    if (!enhance) return;
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
  }, [enhance]);

  useEffect(() => {
    // marked emits <code class="language-x"> only for tagged fences.
    if (!enhance || !visible || !html.includes('<code class="language-'))
      return;
    const el = ref.current;
    if (!el) return;
    const upgradeKey = `${theme}\u0000${html}`;
    if (
      upgradedRef.current?.el === el &&
      upgradedRef.current.key === upgradeKey
    )
      return;
    let alive = true;
    (async () => {
      // Restore the pristine marked output first: a theme flip re-runs this
      // effect, and both upgrades must start from the original fences, not
      // from the previous pass's shiki/mermaid markup.
      el.innerHTML = html;
      const fences = Array.from(
        el.querySelectorAll('pre > code[class*="language-"]'),
      ).map((code) => ({
        code,
        lang: /language-([^\s"]+)/.exec(code.className)?.[1],
      }));

      // ```mermaid fences become inline diagrams; source that doesn't parse
      // (still streaming, or just wrong) keeps the plain code fence.
      if (fences.some((f) => f.lang === "mermaid")) {
        const m = await loadMermaid().catch(() => null);
        for (const { code, lang } of fences) {
          if (!m || lang !== "mermaid") continue;
          const svg = await m
            .renderMermaidSvg(code.textContent ?? "")
            .catch(() => null);
          const pre = code.parentElement;
          if (!alive || !svg || !pre || !el.contains(pre)) continue;
          // The diagram itself sits in a scroller, with the expand
          // control as its SIBLING rather than a child: a wide diagram
          // scrolls sideways, and a button inside that box would ride
          // off the edge with it.
          const wrap = document.createElement("div");
          wrap.className = "md-mermaid-wrap";
          const well = document.createElement("div");
          well.className = "md-mermaid";
          well.innerHTML = svg;
          // A real button, activated by the same delegated listener that
          // opens session images (MediaLightbox.tsx). Clicking the diagram
          // opens it too; this is what puts it in the tab order, and what
          // makes it discoverable on a touch screen with no hover.
          const expand = document.createElement("button");
          expand.type = "button";
          expand.className = "md-diagram-expand";
          expand.title = "Expand diagram";
          expand.setAttribute("aria-label", "Expand diagram");
          expand.innerHTML = expandIconMarkup();
          wrap.append(well, expand);
          pre.replaceWith(wrap);
        }
      }

      if (!fences.some((f) => f.lang && f.lang !== "mermaid")) return;
      const m = await loadCodeHighlight().catch(() => null);
      if (!m || !alive) return;
      for (const { code, lang } of fences) {
        if (!lang || lang === "mermaid" || !el.contains(code)) continue;
        const raw = code.textContent ?? "";
        // Giant generated files stay a permanent plain <pre>; highlighting
        // them is expensive and adds little reading value.
        if (raw.length > 20_000) continue;
        const out = await m.highlightToHtml(raw, lang);
        const pre = code.parentElement;
        if (!alive || !out || !pre || !el.contains(pre)) continue;
        const tpl = document.createElement("template");
        tpl.innerHTML = out;
        const shikiPre = tpl.content.firstElementChild;
        if (shikiPre) {
          shikiPre.classList.add("md-code");
          // Shiki writes its theme's editor background inline, which beats
          // `.markdown pre`'s well: in light that's #ffffff, so a
          // highlighted fence read as a white card on the page while an
          // un-highlighted one read as sunk. (Dark hid it — #0d1117 against
          // #0c0c10.) The surface is the well's; keep only shiki's ink.
          (shikiPre as HTMLElement).style.backgroundColor = "";
          pre.replaceWith(shikiPre);
        }
      }
    })().then(
      () => {
        // A cancelled pass may have skipped replacements (the alive-gated
        // continues), so only an un-cancelled run counts as upgraded.
        if (alive) upgradedRef.current = { el, key: upgradeKey };
      },
      () => {}, // both upgrades are progressive enhancement, plain pre stays
    );
    return () => {
      alive = false;
    };
  }, [enhance, html, theme, visible]);

  // The copy control on each fence (lib/code-copy.ts). Declared AFTER the
  // upgrade effect on purpose: that one restores the pristine markdown into
  // the DOM before its first await, which would throw these buttons away.
  // Effects run in declaration order, so this re-decorates what the reset just
  // put back. The upgrades that follow are `pre.replaceWith(...)` INSIDE the
  // wrapper this creates, so the button survives them without being rebuilt.
  useEffect(() => {
    if (!enhance) return;
    const el = ref.current;
    if (!el || !html.includes("<pre")) return;
    decorateCodeBlocks(el);
  }, [enhance, html, theme, visible]);

  useEffect(() => {
    if (!enhance) return;
    const el = ref.current;
    return el ? attachCodeCopy(el) : undefined;
  }, [enhance]);

  return (
    <div ref={ref} className={className} dangerouslySetInnerHTML={innerHtml} />
  );
}
