import { repoLabel } from "../lib/repo-label";
import React, {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { FileMention } from "../lib/api";
import { UserAvatar } from "./UserAvatar";
import { cn } from "../ui/cn";
import { FLOATING_OVERLAY_LAYER } from "../ui/popup-classes";
import { IconTile } from "./BrandTile";
import { displayName as brandDisplayName } from "../brand-logos";
import {
  IconBolt,
  IconFile,
  IconFolder,
  IconMessage,
  IconPlug,
  IconStack,
} from "./icons";
import { peopleMentionMatches, usePeople } from "../lib/people";
import { useCurrentUser } from "./UserPicker";
import {
  actionMentionSuggestions,
  groupMentionSuggestions,
  mergeMentionSuggestions,
  type MentionAction,
  type MentionSuggestion,
} from "../lib/mention-palette";
import { emojiContextAt, emojiMentionSuggestions } from "../lib/emoji";
import { caretPoint } from "../lib/caret-coords";
import { PHONE_QUERY } from "../lib/breakpoints";

/**
 * Find the active "@"-mention being typed at the caret. Returns the index of
 * the "@" and the query typed after it, or null when the caret isn't inside a
 * mention token. A mention starts at "@" that is at the start of the text or
 * preceded by whitespace, and runs until the first whitespace.
 */
interface TriggerContext {
  start: number;
  query: string;
  kind: "file" | "skill" | "emoji";
}

function mentionContextAt(
  value: string,
  caret: number,
): { start: number; query: string } | null {
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
function slashContextAt(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  if (value[0] !== "/" || caret < 1) return null;
  const query = value.slice(1, caret);
  if (/\s/.test(query)) return null;
  return { start: 0, query };
}

function sameTrigger(
  a: TriggerContext | null,
  b: TriggerContext | null,
): boolean {
  if (!a || !b) return a === b;
  return a.start === b.start && a.query === b.query && a.kind === b.kind;
}

const NO_SUGGESTIONS: FileMention[] = [];

interface Options {
  value: string;
  /** Return a remapped caret when the host projects a different visible value. */
  onChange: (
    value: string,
    selectionStart?: number,
    selectionEnd?: number,
  ) => number | void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Enables "@"-mention file autocomplete. Given the text typed after the "@",
   * returns matching files. When omitted, the hook is inert.
   */
  mentionFetch?: (query: string) => Promise<FileMention[]>;
  /** Fast non-file rows for "@". Resolves independently of repository search. */
  paletteFetch?: (query: string) => Promise<FileMention[]>;
  /**
   * Enables "/"-skill autocomplete when the input starts with "/". Given the
   * text typed after the "/", returns matching skills/commands.
   */
  skillsFetch?: (query: string) => Promise<FileMention[]>;
  /** Contextual commands offered after people, tools, and sessions. */
  actions?: MentionAction[];
}

interface FileMentions {
  /** Ref for the wrapper the popup is measured against. */
  inputWrapRef: React.RefObject<HTMLDivElement | null>;
  /** Compiler-safe callback ref for hosts that also own the wrapper node. */
  setInputWrap: (node: HTMLDivElement | null) => void;
  /** The suggestion popup (portaled to <body>), or null when closed. */
  popup: React.ReactNode;
  /** True while the popup is open (suggestions visible). */
  open: boolean;
  /** Combobox wiring for the textarea that keeps focus while the popup opens. */
  inputProps: Pick<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    | "role"
    | "aria-autocomplete"
    | "aria-expanded"
    | "aria-controls"
    | "aria-activedescendant"
    | "aria-haspopup"
  >;
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
 * popup node plus handlers to wire into a host textarea. Used by both the session
 * Composer and the New-session prompt field so they behave identically.
 */
export function useFileMentions({
  value,
  onChange,
  textareaRef,
  mentionFetch,
  paletteFetch,
  skillsFetch,
  actions = [],
}: Options): FileMentions {
  const [mention, setMention] = useState<TriggerContext | null>(null);
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  // The trigger that produced the rows currently on screen. Skill lookup is
  // asynchronous, so a narrowed query briefly keeps the previous rows rather
  // than unmounting and remounting the whole popup. Selection stays disabled
  // until the new query's rows arrive.
  const suggestionsFor = useRef<TriggerContext | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const popupId = useId();
  const people = usePeople();
  const currentUser = useCurrentUser();
  // Caret-target to apply after a programmatic value change (insertion).
  const pendingCaret = useRef<number | null>(null);
  // Guards against a stale async fetch overwriting a newer query's results.
  const fetchSeq = useRef(0);
  // The trigger token Escape dismissed, held until the caret moves off it or
  // its query changes. A ref rather than state: it must be readable by the
  // sync() that the very same key's keyup runs, before any re-render.
  const dismissed = useRef<TriggerContext | null>(null);
  // Latest fetchers in refs: callers pass inline closures, so depending on
  // them directly would re-run the fetch effect on every render — which loops
  // (fetch → setSuggestions → render → new closure → fetch) while open.
  const mentionFetchRef = useRef(mentionFetch);
  const paletteFetchRef = useRef(paletteFetch);
  const skillsFetchRef = useRef(skillsFetch);
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    mentionFetchRef.current = mentionFetch;
    paletteFetchRef.current = paletteFetch;
    skillsFetchRef.current = skillsFetch;
    actionsRef.current = actions;
  });
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const setInputWrap = (node: HTMLDivElement | null) => {
    inputWrapRef.current = node;
  };
  const popupRef = useRef<HTMLDivElement>(null);
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
  }, [value, textareaRef]);

  // Every state write here keeps the previous value when nothing moved. sync()
  // runs several times per keystroke by design (the value effect below, plus
  // each caller's keyup/click), and a fresh object or a fresh empty array would
  // make each of those a real state change, so a host as large as the
  // new-session palette re-rendered three extra times per character typed.
  function clearSuggestions() {
    suggestionsFor.current = null;
    setSuggestions((prev) => (prev.length ? NO_SUGGESTIONS : prev));
  }

  function sync() {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const slash = skillsFetch ? slashContextAt(el.value, caret) : null;
    const at =
      !slash && mentionFetch ? mentionContextAt(el.value, caret) : null;
    // ":cr" opens the emoji picker. It needs no fetcher, so it stays available
    // in every host the hook is wired into, including ones with no repository
    // search behind them.
    const colon = !slash && !at ? emojiContextAt(el.value, caret) : null;
    const ctx: TriggerContext | null = slash
      ? { ...slash, kind: "skill" }
      : at
        ? { ...at, kind: "file" }
        : colon
          ? { ...colon, kind: "emoji" }
          : null;
    // Escape dismissed this exact token, and the caret has not left it since.
    // sync() runs on keyup, so without this the picker reopened between the
    // keydown that closed it and the release of the same key — Escape looked
    // like it did nothing at all. Typing on (or moving off the token) makes a
    // different context and the suggestions come back.
    if (ctx && sameTrigger(dismissed.current, ctx)) {
      setMention((prev) => (prev === null ? prev : null));
      clearSuggestions();
      return;
    }
    dismissed.current = null;
    setMention((prev) => (sameTrigger(prev, ctx) ? prev : ctx));
    if (!ctx) clearSuggestions();
  }

  // Controlled textarea updates are not guaranteed to commit before a caller's
  // queued microtask. Re-sync from the committed value so soft keyboards,
  // dictation and the toolbar's programmatic "@" insertion all open reliably.
  const runSync = useEffectEvent(() => sync());
  useEffect(() => {
    runSync();
  }, [value]);

  // People are already in the page-level directory cache, so paint them before
  // the file/tool/session request resolves. A bare "@" should feel like opening
  // a palette, not like waiting for a repository search.
  const loadSuggestions = useEffectEvent(() => {
    if (!mention) {
      clearSuggestions();
      return;
    }
    const seq = ++fetchSeq.current;
    if (mention.kind === "emoji") {
      suggestionsFor.current = mention;
      setSuggestions(emojiMentionSuggestions(mention.query));
      setActiveIdx(0);
      return;
    }
    const local =
      mention.kind === "file"
        ? mergeMentionSuggestions(
            peopleMentionMatches(mention.query, people, currentUser),
            actionMentionSuggestions(mention.query, actionsRef.current),
          )
        : [];
    setActiveIdx(0);
    if (mention.kind === "skill") {
      // Keep a skill menu mounted while its next local lookup resolves. Clearing
      // it here made every typed character flash the popup off and back on.
      // suggestionsFor keeps stale rows inert during that short handoff.
      if (suggestionsFor.current?.kind !== "skill") clearSuggestions();
      const fetcher = skillsFetchRef.current;
      if (!fetcher) return;
      void fetcher(mention.query)
        .then((items) => {
          if (seq !== fetchSeq.current) return;
          suggestionsFor.current = mention;
          setActiveIdx(0);
          setSuggestions(items);
        })
        .catch(() => {
          if (seq === fetchSeq.current) clearSuggestions();
        });
      return;
    }
    // Local people/actions already belong to this query, so Enter can use them
    // immediately while the fetched rows merge underneath.
    suggestionsFor.current = mention;
    setSuggestions(local);
    let paletteItems: FileMention[] = [];
    let fileItems: FileMention[] = [];
    const publish = () => {
      if (seq !== fetchSeq.current) return;
      suggestionsFor.current = mention;
      setSuggestions(mergeMentionSuggestions(local, paletteItems, fileItems));
    };
    const paletteFetcher = paletteFetchRef.current;
    if (paletteFetcher) {
      void paletteFetcher(mention.query)
        .then((items) => {
          paletteItems = items;
          publish();
        })
        .catch(() => {});
    }
    const fileFetcher = mentionFetchRef.current;
    if (fileFetcher) {
      void fileFetcher(mention.query)
        .then((items) => {
          fileItems = items;
          publish();
        })
        .catch(() => {});
    }
  });
  useEffect(() => {
    loadSuggestions();
  }, [mention?.query, mention?.start, mention?.kind, people, currentUser]);

  const open = !!mention && suggestions.length > 0;

  // The popup renders in a portal with fixed viewport coordinates so an
  // overflow:hidden ancestor cannot clip it. Every inline trigger anchors to
  // its character. Slash commands start at the field's left edge, but still
  // belong under the slash itself rather than under a tall textarea.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const el = inputWrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const POPUP_MAX = 420;
      const field = textareaRef.current;
      const caret = mention ? caretPoint(field, mention.start) : null;
      if (caret) {
        const GUTTER = window.matchMedia(PHONE_QUERY).matches ? 16 : 8;
        const fieldRect = field?.getBoundingClientRect();
        const width =
          mention?.kind === "emoji"
            ? 240
            : Math.min(
                520,
                mention?.kind === "skill" && fieldRect
                  ? fieldRect.width
                  : rect.width,
                window.innerWidth - GUTTER * 2,
              );
        const targetLeft =
          mention?.kind === "skill" && fieldRect
            ? fieldRect.left
            : caret.left - 8;
        const left = Math.max(
          GUTTER,
          Math.min(targetLeft, window.innerWidth - width - GUTTER),
        );
        const spaceAbove = caret.top;
        const spaceBelow = window.innerHeight - caret.bottom;
        const down = spaceAbove < POPUP_MAX && spaceBelow > spaceAbove;
        setPos({
          left,
          width,
          ...(down
            ? {
                top: caret.bottom + 6,
                maxHeight: Math.min(POPUP_MAX, spaceBelow - 12),
              }
            : {
                bottom: window.innerHeight - caret.top + 6,
                maxHeight: Math.min(POPUP_MAX, spaceAbove - 12),
              }),
        });
        return;
      }
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
  }, [open, suggestions.length, mention, value, textareaRef]);

  useEffect(() => {
    if (!open) return;
    popupRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  function applySuggestion(item: MentionSuggestion) {
    if (!mention || !sameTrigger(suggestionsFor.current, mention)) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    if (item.action) {
      setMention(null);
      setSuggestions([]);
      pendingCaret.current =
        onChange(before + after, before.length, before.length) ?? before.length;
      queueMicrotask(item.action);
      return;
    }
    // An emoji row replaces the whole ":shortcode" with the character, so the
    // sent text carries the emoji itself rather than a code the reader has to
    // decode. No trailing space: emoji usually end a sentence.
    const insert =
      mention.kind === "emoji"
        ? item.insert
        : `${mention.kind === "skill" ? "/" : "@"}${item.insert} `;
    const next = before + insert + after;
    const nextCaret = before.length + insert.length;
    setMention(null);
    setSuggestions([]);
    pendingCaret.current = onChange(next, nextCaret, nextCaret) ?? nextCaret;
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
      // The picker is its own layer, so closing it must not also close what
      // hosts the field. Base UI's dialog watches for Escape twice — an
      // onKeyDown on the popup and a keydown listener on the document
      // (floating-ui's useDismiss) — and both sit above this handler, so the
      // whole new-session palette used to go with the picker. Stopping
      // propagation here settles both, because React dispatches from its root
      // container and the native event never reaches the document either.
      //
      // Only ever reached while the picker is open (`open` is checked above),
      // so every host's own Escape is untouched when it is closed: the session
      // composer still asks to stop a running turn, and a second press in
      // either host still reaches the layer above.
      e.preventDefault();
      e.stopPropagation();
      dismissed.current = mention;
      setMention(null);
      setSuggestions([]);
      return true;
    }
    return false;
  }

  function close() {
    setMention(null);
  }

  const groups = groupMentionSuggestions(suggestions);
  const popup =
    open && pos
      ? createPortal(
          <div
            ref={popupRef}
            className={cn(
              "fixed overflow-y-auto rounded-xl bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] p-1 smooth-shadow-ring-md",
              FLOATING_OVERLAY_LAYER,
            )}
            id={popupId}
            role="listbox"
            style={pos}
          >
            {groups.map((group, groupIndex) => (
              <div
                key={group.category}
                role="group"
                aria-label={group.category}
              >
                <div
                  className={cn(
                    "px-2.5 pb-1 text-meta font-medium text-faint",
                    groupIndex === 0 ? "pt-1" : "pt-2",
                  )}
                >
                  {group.category}
                </div>
                {group.items.map(({ item, index: i }) => {
                  const isWorkspace = item.kind === "workspace";
                  const isSession = item.kind === "session";
                  const isSkill = item.kind === "skill";
                  const isDir = item.kind === "dir";
                  const isPerson = item.kind === "person";
                  const isTool = item.kind === "tool";
                  const isAction = item.kind === "action";
                  const isEmoji = item.kind === "emoji";
                  const path = item.display;
                  const slash =
                    isWorkspace ||
                    isSession ||
                    isSkill ||
                    isPerson ||
                    isTool ||
                    isAction ||
                    isEmoji
                      ? -1
                      : path.lastIndexOf("/");
                  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
                  const base = slash >= 0 ? path.slice(slash + 1) : path;
                  const label = isTool
                    ? brandDisplayName(base)
                    : isSkill
                      ? `/${base}`
                      : isDir
                        ? `${base}/`
                        : base;
                  return (
                    <div
                      key={`${item.kind || "file"}:${item.insert}`}
                      role="option"
                      id={`${popupId}-option-${i}`}
                      aria-selected={i === activeIdx}
                      data-mention-index={i}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-control px-2.5 py-2 text-label leading-[1.3] whitespace-nowrap",
                        i === activeIdx && "bg-pressed",
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applySuggestion(item);
                      }}
                      onMouseEnter={() => setActiveIdx(i)}
                    >
                      {isEmoji ? (
                        <span className="flex size-5 shrink-0 items-center justify-center text-[17px] leading-none">
                          {item.display}
                        </span>
                      ) : isPerson ? (
                        <UserAvatar name={item.display} size={20} />
                      ) : isTool ? (
                        <IconTile name={item.insert} size={20} />
                      ) : isWorkspace ? (
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-active text-dim">
                          <IconStack size={14} />
                        </span>
                      ) : isSession ? (
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-active text-dim">
                          <IconMessage size={14} />
                        </span>
                      ) : isAction ? (
                        <span className="flex size-5 shrink-0 items-center justify-center text-dim">
                          {item.icon || <IconPlug size={16} />}
                        </span>
                      ) : item.repo ? (
                        <span className="shrink-0 rounded-md bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-[5px] py-px text-meta font-semibold text-accent">
                          {repoLabel(item.repo)}
                        </span>
                      ) : (
                        <span className="flex size-5 shrink-0 items-center justify-center text-faint">
                          {isSkill ? (
                            <IconBolt size={16} />
                          ) : isDir ? (
                            <IconFolder size={16} />
                          ) : (
                            <IconFile size={16} />
                          )}
                        </span>
                      )}
                      {!isEmoji && (
                        <span className="shrink-0 font-medium text-fg">
                          {label}
                        </span>
                      )}
                      {isEmoji ? (
                        <span className="overflow-hidden text-ellipsis font-medium text-fg">
                          {item.sub}
                        </span>
                      ) : isTool ? (
                        <span className="overflow-hidden text-ellipsis text-meta text-faint">
                          @{item.insert}
                        </span>
                      ) : isWorkspace ||
                        isSession ||
                        isSkill ||
                        isPerson ||
                        isAction ? (
                        item.sub && (
                          <span className="overflow-hidden text-ellipsis text-meta text-faint">
                            {item.sub}
                          </span>
                        )
                      ) : dir ? (
                        <span className="overflow-hidden text-ellipsis text-left text-meta text-faint [direction:rtl]">
                          {dir}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body,
        )
      : null;

  const inputProps: FileMentions["inputProps"] = {
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": open,
    "aria-haspopup": "listbox",
  };
  if (open) {
    inputProps["aria-controls"] = popupId;
    inputProps["aria-activedescendant"] = `${popupId}-option-${activeIdx}`;
  }

  return {
    inputWrapRef,
    setInputWrap,
    popup,
    open,
    inputProps,
    sync,
    handleKeyDown,
    close,
  };
}
