import { repoLabel } from "../lib/repo-label";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FileMention } from "../lib/api";
import { cn } from "../ui/cn";

/**
 * Find the active "@"-mention being typed at the caret. Returns the index of
 * the "@" and the query typed after it, or null when the caret isn't inside a
 * mention token. A mention starts at "@" that is at the start of the text or
 * preceded by whitespace, and runs until the first whitespace.
 */
interface TriggerContext {
  start: number;
  query: string;
  kind: "file" | "skill";
}

function mentionContextAt(value: string, caret: number): { start: number; query: string } | null {
  // Walk back from the caret to the "@", bailing on whitespace.
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i > 0 ? value[i - 1] : " ";
      if (prev === " " || prev === "\n" || prev === "\t") {
        return { start: i, query: value.slice(i + 1, caret) };
      }
      return null;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    i--;
  }
  return null;
}

/**
 * Find the active "/"-skill being typed. Only triggers when "/" is the very
 * first character of the whole input (like a CLI slash command) and the caret
 * is still inside that first token — so typing a path like `src/foo` mid-text
 * never opens it.
 */
function slashContextAt(value: string, caret: number): { start: number; query: string } | null {
  if (value[0] !== "/" || caret < 1) return null;
  const query = value.slice(1, caret);
  if (/\s/.test(query)) return null;
  return { start: 0, query };
}

interface Options {
  value: string;
  onChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Enables "@"-mention file autocomplete. Given the text typed after the "@",
   * returns matching files. When omitted, the hook is inert.
   */
  mentionFetch?: (query: string) => Promise<FileMention[]>;
  /**
   * Enables "/"-skill autocomplete when the input starts with "/". Given the
   * text typed after the "/", returns matching skills/commands.
   */
  skillsFetch?: (query: string) => Promise<FileMention[]>;
}

interface FileMentions {
  /** Ref for the wrapper the popup is measured against. */
  inputWrapRef: React.RefObject<HTMLDivElement | null>;
  /** The suggestion popup (portaled to <body>), or null when closed. */
  popup: React.ReactNode;
  /** True while the popup is open (suggestions visible). */
  open: boolean;
  /** Re-evaluate the mention context; call on keyup/click and after value changes. */
  sync: () => void;
  /**
   * Handle a keydown while the popup is open (arrows/enter/tab/escape). Returns
   * true when it consumed the key — callers should then `return` from their own
   * keydown handler so it doesn't also send/newline.
   */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Close the popup (e.g. on blur, after letting a click win the race). */
  close: () => void;
}

/**
 * Shared "@"-mention file-path autocomplete for textareas. Manages the popup
 * state, debounced fetching, keyboard navigation and insertion, and returns a
 * popup node plus handlers to wire into a host textarea. Used by both the chat
 * Composer and the New-session prompt field so they behave identically.
 */
export function useFileMentions({ value, onChange, textareaRef, mentionFetch, skillsFetch }: Options): FileMentions {
  const [mention, setMention] = useState<TriggerContext | null>(null);
  const [suggestions, setSuggestions] = useState<FileMention[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  // Caret-target to apply after a programmatic value change (insertion).
  const pendingCaret = useRef<number | null>(null);
  // Guards against a stale async fetch overwriting a newer query's results.
  const fetchSeq = useRef(0);
  // Latest fetchers in refs: callers pass inline closures, so depending on
  // them directly would re-run the fetch effect on every render — which loops
  // (fetch → setSuggestions → render → new closure → fetch) while open.
  const mentionFetchRef = useRef(mentionFetch);
  mentionFetchRef.current = mentionFetch;
  const skillsFetchRef = useRef(skillsFetch);
  skillsFetchRef.current = skillsFetch;
  const inputWrapRef = useRef<HTMLDivElement>(null);
  // Fixed viewport coordinates for the portaled popup, measured from the
  // wrapper. Null until the first measure after opening.
  const [pos, setPos] = useState<React.CSSProperties | null>(null);

  // Apply a pending caret position after a programmatic value change.
  useEffect(() => {
    if (pendingCaret.current == null) return;
    const el = textareaRef.current;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }, [value]);

  function sync() {
    if (!mentionFetch && !skillsFetch) return;
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const slash = skillsFetch ? slashContextAt(el.value, caret) : null;
    const at = !slash && mentionFetch ? mentionContextAt(el.value, caret) : null;
    const ctx: TriggerContext | null = slash
      ? { ...slash, kind: "skill" }
      : at
        ? { ...at, kind: "file" }
        : null;
    setMention(ctx);
    if (!ctx) setSuggestions([]);
  }

  // Controlled textarea updates are not guaranteed to commit before a caller's
  // queued microtask. Re-sync from the committed value so soft keyboards,
  // dictation and the toolbar's programmatic "@" insertion all open reliably.
  useEffect(() => {
    sync();
  }, [value]);

  // Fetch immediately: file results are cached server-side, and waiting after
  // every keystroke made the picker feel sticky despite a warm index.
  useEffect(() => {
    const fetcher = mention?.kind === "skill" ? skillsFetchRef.current : mentionFetchRef.current;
    if (!mention || !fetcher) {
      setSuggestions([]);
      return;
    }
    const seq = ++fetchSeq.current;
    // Never let Enter select rows belonging to the previous query.
    setSuggestions([]);
    void fetcher(mention.query)
      .then((files) => {
        if (seq === fetchSeq.current) {
          setSuggestions(files);
          setActiveIdx(0);
        }
      })
      .catch(() => {
        if (seq === fetchSeq.current) setSuggestions([]);
      });
  }, [mention?.query, mention?.start, mention?.kind]);

  const open = !!mention && suggestions.length > 0;

  // Position the popup against the wrapper. It renders in a portal with fixed
  // viewport coordinates so an overflow:hidden ancestor (e.g. the new-session
  // palette card) can't clip it. Opens upward by default, flips downward when
  // there isn't room above.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const el = inputWrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const POPUP_MAX = 240;
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      const down = spaceAbove < POPUP_MAX && spaceBelow > spaceAbove;
      setPos({
        left: rect.left,
        width: Math.min(520, rect.width),
        ...(down
          ? {
              top: rect.bottom + 6,
              maxHeight: Math.min(POPUP_MAX, spaceBelow - 12),
            }
          : {
              bottom: window.innerHeight - rect.top + 6,
              maxHeight: Math.min(POPUP_MAX, spaceAbove - 12),
            }),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, suggestions.length]);

  function applySuggestion(item: FileMention) {
    if (!mention) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    const insert = `${mention.kind === "skill" ? "/" : "@"}${item.insert} `;
    const next = before + insert + after;
    pendingCaret.current = before.length + insert.length;
    setMention(null);
    setSuggestions([]);
    onChange(next);
  }

  function handleKeyDown(e: React.KeyboardEvent): boolean {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applySuggestion(suggestions[activeIdx]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setMention(null);
      setSuggestions([]);
      return true;
    }
    return false;
  }

  function close() {
    setMention(null);
  }

  const popup = open && pos ? createPortal(
    <div className="mention-popup fixed z-[10500] max-h-60 overflow-y-auto rounded-lg border border-line bg-control p-1 shadow-[0_8px_28px_rgba(0,0,0,0.28)]" role="listbox" style={pos}>
      {suggestions.map((item, i) => {
        const isSession = item.kind === "session";
        const isSkill = item.kind === "skill";
        const isDir = item.kind === "dir";
        const isPerson = item.kind === "person";
        const path = item.display;
        const slash = isSession || isSkill || isPerson ? -1 : path.lastIndexOf("/");
        const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        return (
          <div
            key={`${item.insert}-${i}`}
            role="option"
            aria-selected={i === activeIdx}
            className={cn("mention-item flex cursor-pointer items-baseline gap-2 overflow-hidden rounded-md px-[9px] py-1.5 text-supporting leading-[1.3] whitespace-nowrap", i === activeIdx && "mention-item-active bg-pressed")}
            onMouseDown={(e) => {
              e.preventDefault();
              applySuggestion(item);
            }}
            onMouseEnter={() => setActiveIdx(i)}
          >
            {isSession && <span className="mention-repo shrink-0 self-center rounded-sm bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-[5px] py-px text-meta font-semibold text-accent">session</span>}
            {isPerson && <span className="mention-repo shrink-0 self-center rounded-sm bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-[5px] py-px text-meta font-semibold text-accent">person</span>}
            {!isSession && !isSkill && !isPerson && item.repo && <span className="mention-repo shrink-0 self-center rounded-sm bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-[5px] py-px text-meta font-semibold text-accent">{repoLabel(item.repo)}</span>}
            <span className="mention-base shrink-0 font-medium text-fg">{isSkill ? `/${base}` : isDir ? `${base}/` : base}</span>
            {isSession || isSkill || isPerson
              ? item.sub && <span className="mention-dir overflow-hidden text-meta text-ellipsis text-left text-faint [direction:rtl]">{item.sub}</span>
              : dir && <span className="mention-dir overflow-hidden text-meta text-ellipsis text-left text-faint [direction:rtl]">{dir}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return { inputWrapRef, popup, open, sync, handleKeyDown, close };
}
