import type React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { attachCodeCopy, decorateCodeBlocks } from "../lib/code-copy";
import {
  FENCE_UPGRADERS,
  type FenceUpgrader,
  finalizeFenceUpgrades,
} from "../lib/fence-upgraders";
import type { MarkdownContext } from "../lib/markdown";
import {
  MATH_PLACEHOLDER_MARK,
  upgradeMathPlaceholders,
} from "../lib/math-block";

// Lazy loaders live at module scope: the compiler cannot lower dynamic
// imports inside components.
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
 * every block kind in the registry (lib/fence-upgraders.ts: mermaid
 * diagrams, vega-lite charts, ...) replaces its fence, every other tagged
 * fence gets shiki highlighting. The renderers are multi-MB, so each is only
 * dynamically imported when a message actually carries a matching fence —
 * plain messages render the marked output untouched. Fences with no (or an
 * unshipped) language keep the stock .markdown <pre> styling.
 */
export function MarkdownBody({
  html,
  className,
  enhance = true,
  markdown,
}: {
  html: string;
  className?: string;
  /** Mermaid and syntax highlighting are landed-content enhancements. A live
   * stream keeps the cheap, readable marked output and upgrades once its
   * durable message replaces it. */
  enhance?: boolean;
  /** The context `html` was rendered with, handed to a block that renders
   * markdown of its own (a slide deck) so its links resolve the same way. */
  markdown?: MarkdownContext;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read through a ref by the upgrade effect: callers build the context
  // object per render, and a new identity must not restart a pass.
  const markdownRef = useRef(markdown);
  useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);
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
    // marked emits <code class="language-x"> only for tagged fences, and the
    // .md-math placeholder only for inline math (lib/math-block.ts).
    if (
      !enhance ||
      !visible ||
      !(
        html.includes('<code class="language-') ||
        html.includes(MATH_PLACEHOLDER_MARK)
      )
    )
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
      // effect, and every upgrade must start from the original fences, not
      // from the previous pass's shiki/diagram/chart markup. A chart is a
      // live view, so it is stopped before the DOM under it disappears.
      finalizeFenceUpgrades(el);
      el.innerHTML = html;
      const isAlive = () => alive;
      const fences = Array.from(
        el.querySelectorAll('pre > code[class*="language-"]'),
      ).map((code) => {
        const lang = /language-([^\s"]+)/
          .exec(code.className)?.[1]
          ?.toLowerCase();
        const source = code.textContent ?? "";
        const upgrader: FenceUpgrader | undefined = lang
          ? FENCE_UPGRADERS.find(
              (u) =>
                u.langs.includes(lang) || u.claims?.(lang, source) === true,
            )
          : undefined;
        return { code, lang, source, upgrader, done: false };
      });

      // Each block kind replaces the fences it claims; one that declines
      // (source that does not parse, still streaming) leaves the plain
      // fence for shiki below. Registry order, one renderer at a time.
      for (const upgrader of FENCE_UPGRADERS) {
        for (const fence of fences) {
          if (fence.upgrader !== upgrader) continue;
          const pre = fence.code.parentElement;
          if (!alive || !pre || !el.contains(pre)) continue;
          fence.done = await upgrader
            .upgrade({
              pre,
              source: fence.source,
              lang: fence.lang ?? "",
              root: el,
              theme,
              markdown: markdownRef.current,
              alive: isAlive,
            })
            .catch(() => false);
        }
      }

      // Inline math is not a fence, so the registry never sees it; its
      // placeholders are typeset here, in the same pass and under the same
      // reset and cancellation as the fences.
      await upgradeMathPlaceholders(el, isAlive);

      if (!fences.some((f) => f.lang && !f.done)) return;
      const m = await loadCodeHighlight().catch(() => null);
      if (!m || !alive) return;
      for (const { code, lang, done } of fences) {
        if (!lang || done || !el.contains(code)) continue;
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
        if (shikiPre instanceof HTMLElement) {
          shikiPre.classList.add("md-code");
          // Shiki writes its theme's editor background inline, which beats
          // `.markdown pre`'s well: in light that's #ffffff, so a
          // highlighted fence read as a white card on the page while an
          // un-highlighted one read as sunk. (Dark hid it — #0d1117 against
          // #0c0c10.) The surface is the well's; keep only shiki's ink.
          shikiPre.style.backgroundColor = "";
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

  // A chart still running when the body unmounts would keep its dataflow and
  // tooltip listeners alive against detached nodes.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) finalizeFenceUpgrades(el);
    };
  }, []);

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
