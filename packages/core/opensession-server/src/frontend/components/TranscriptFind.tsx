import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import type { TranscriptEntry } from "../lib/types";
import {
  entryElement,
  findTranscriptMatches,
  MAX_FIND_MATCHES,
  stepFindIndex,
  textRanges,
  TRANSCRIPT_FIND_EVENT,
  type FindMatch,
} from "../lib/transcript-find";
import {
  scrollToVirtualTranscriptEntry,
  virtualTranscriptRowFor,
} from "../lib/transcript-virtual-navigation";
import { matchesShortcut } from "../lib/shortcuts";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { duration, ease } from "../ui/motion";
import { IconArrowDown, IconArrowUp, IconSearch, IconX } from "./icons";

/** Custom Highlight names, painted in styles/base-global.css. */
const HIGHLIGHT = "find";
const HIGHLIGHT_CURRENT = "find-current";

/** Where a revealed match sits: a third of the way down, so the lines that
 *  lead into it are in view as well. */
const REVEAL_AT = 1 / 3;
/** Frames to keep correcting a jump while virtual rows measure in. */
const SETTLE_FRAMES = 12;

interface Props {
  /** The session is the one in front of the person. */
  focused: boolean;
  entries: readonly TranscriptEntry[];
  /** The transcript's scroll container. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Jumping into history is intent: stop following the live edge. */
  leaveLatest: () => void;
  /** Set when older history is not loaded and can be. */
  onLoadAll?: () => void;
}

function highlightsSupported() {
  return (
    typeof CSS !== "undefined" &&
    !!CSS.highlights &&
    typeof Highlight !== "undefined"
  );
}

function clearHighlights() {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(HIGHLIGHT);
  CSS.highlights.delete(HIGHLIGHT_CURRENT);
}

/** Where one match is drawn: its entry's element, and the occurrence inside
 *  it when that text is drawn too. */
interface DrawnMatch {
  element: HTMLElement | null;
  range: Range | null;
}

/** A message clamped to its head can draw fewer occurrences than it holds;
 *  the last drawn one is the closest stand-in. */
function matchRange(
  container: HTMLElement,
  match: FindMatch,
  query: string,
): DrawnMatch {
  const element = entryElement(container, match.entryId);
  if (!element) return { element: null, range: null };
  const ranges = textRanges(element, query);
  return {
    element,
    range: ranges[Math.min(match.occurrence, ranges.length - 1)] ?? null,
  };
}

/**
 * Bring one match into view, correcting over a few frames. The entry may not
 * be mounted (the virtual list only draws what is near the reader) or may sit
 * inside a folded turn, so each pass asks for what is still missing. Returns
 * a cancel.
 */
function revealMatch(
  container: HTMLElement,
  match: FindMatch,
  query: string,
): () => void {
  let frames = 0;
  let settled = 0;
  let unfolded = false;
  let frame = 0;
  const pass = () => {
    let { element, range } = matchRange(container, match, query);
    if (!element) {
      // Mount the row first; once it is there and the entry still draws
      // nothing, it is folded inside its turn: open the turn, as a browser
      // opens a closed <details> for a match inside it.
      const row = virtualTranscriptRowFor(container, match.entryId);
      if (!row) scrollToVirtualTranscriptEntry(container, match.entryId);
      else if (!unfolded) {
        unfolded = true;
        row
          .querySelector<HTMLButtonElement>("button[aria-expanded='false']")
          ?.click();
      }
      ({ element, range } = matchRange(container, match, query));
    }
    const target = range ?? element;
    if (target) {
      const box = container.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      // A match already in full view on arrival stays where it is.
      if (frames === 0 && rect.top >= box.top && rect.bottom <= box.bottom)
        return;
      const delta = rect.top - box.top - box.height * REVEAL_AT;
      if (Math.abs(delta) <= 2) settled += 1;
      else {
        container.scrollTop += delta;
        settled = 0;
      }
    }
    frames += 1;
    if (settled >= 2 || frames >= SETTLE_FRAMES) return;
    frame = requestAnimationFrame(pass);
  };
  pass();
  return () => cancelAnimationFrame(frame);
}

/**
 * Paint every drawn match, and the current one stronger. Rows mount and
 * unmount as the reader scrolls, so this repaints on scroll and on DOM
 * changes, one frame at a time. Returns a cleanup.
 */
function paintMatches(
  container: HTMLElement,
  entryIds: ReadonlySet<string>,
  current: FindMatch | null,
  query: string,
): () => void {
  let frame = 0;
  const paint = () => {
    frame = 0;
    const all: Range[] = [];
    for (const id of entryIds) {
      const element = entryElement(container, id);
      if (element) all.push(...textRanges(element, query));
    }
    const strong = current ? matchRange(container, current, query).range : null;
    CSS.highlights.set(HIGHLIGHT, new Highlight(...all));
    CSS.highlights.set(
      HIGHLIGHT_CURRENT,
      strong ? new Highlight(strong) : new Highlight(),
    );
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  paint();
  const mutations = new MutationObserver(schedule);
  mutations.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  container.addEventListener("scroll", schedule, { passive: true });
  return () => {
    mutations.disconnect();
    container.removeEventListener("scroll", schedule);
    if (frame) cancelAnimationFrame(frame);
    clearHighlights();
  };
}

/**
 * Find in session (⌘F): a small bar over the transcript that searches every
 * loaded message, including the ones the virtual list has not mounted, and
 * walks them newest first, the way you scroll back through a conversation.
 */
export function TranscriptFind({
  focused,
  entries,
  containerRef,
  leaveLatest,
  onLoadAll,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Index into `matches`, oldest first. Null until the person searches. */
  const [active, setActive] = useState<number | null>(null);
  /** Bumped by Enter on an unchanged match, to reveal it again. */
  const [revealSeq, setRevealSeq] = useState(0);

  const deferredQuery = useDeferredValue(query);
  // A full scan of a transcript that runs to thousands of entries, so it is
  // memoized against the two inputs it reads.
  const matches = useMemo(
    () => (open ? findTranscriptMatches(entries, deferredQuery) : []),
    [open, entries, deferredQuery],
  );
  const count = matches.length;
  // A new query starts from the newest match; new entries arriving while the
  // bar is open keep the one being looked at.
  const [matchedQuery, setMatchedQuery] = useState(deferredQuery);
  if (matchedQuery !== deferredQuery) {
    setMatchedQuery(deferredQuery);
    setActive(count > 0 ? count - 1 : null);
  }
  const index =
    active === null || count === 0 ? null : Math.min(active, count - 1);
  const current = index === null ? undefined : matches[index];
  // Primitives, so a streaming reply that rebuilds `matches` does not count
  // as a new match to jump to.
  const currentEntryId = current?.entryId;
  const currentOccurrence = current?.occurrence ?? 0;

  const openFind = useEffectEvent(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  });

  const close = () => {
    setOpen(false);
    setActive(null);
    clearHighlights();
  };

  // ⌘F from anywhere in this session: the transcript, the composer, or
  // nothing focused at all. A surface that brings its own find (an editor in
  // a side panel) consumes the chord first, and focus outside the session
  // leaves the browser's find alone.
  useEffect(() => {
    if (!focused) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || !matchesShortcut(e, "transcript-find")) return;
      const active = document.activeElement;
      const scope = containerRef.current?.closest("[data-session-find-scope]");
      if (active && active !== document.body && !scope?.contains(active))
        return;
      e.preventDefault();
      openFind();
    }
    const onCommand = () => openFind();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(TRANSCRIPT_FIND_EVENT, onCommand);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(TRANSCRIPT_FIND_EVENT, onCommand);
    };
  }, [focused, containerRef]);

  // Leaving the session closes the bar; its matches belong to this one.
  useEffect(() => {
    if (!focused) setOpen(false);
  }, [focused]);

  const leaveLive = useEffectEvent(() => leaveLatest());

  // Bring the current match into view.
  useEffect(() => {
    const container = containerRef.current;
    if (!open || !container || currentEntryId === undefined) return;
    leaveLive();
    return revealMatch(
      container,
      { entryId: currentEntryId, occurrence: currentOccurrence },
      deferredQuery,
    );
  }, [
    open,
    currentEntryId,
    currentOccurrence,
    deferredQuery,
    revealSeq,
    containerRef,
  ]);

  // Paint every drawn match, the current one stronger.
  useEffect(() => {
    const container = containerRef.current;
    if (!open || !container || !highlightsSupported()) return;
    return paintMatches(
      container,
      new Set(matches.map((match) => match.entryId)),
      currentEntryId === undefined
        ? null
        : { entryId: currentEntryId, occurrence: currentOccurrence },
      deferredQuery,
    );
  }, [
    open,
    matches,
    currentEntryId,
    currentOccurrence,
    deferredQuery,
    containerRef,
  ]);

  const step = (direction: 1 | -1) => {
    if (count === 0) return;
    if (index === null) setActive(count - 1);
    else setActive(stepFindIndex(index, count, direction));
    setRevealSeq((seq) => seq + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Newest first: Enter walks back through the conversation.
      step(e.shiftKey ? 1 : -1);
      return;
    }
    // ⌘F again selects the query for a new search, as in a browser.
    if (matchesShortcut(e, "transcript-find")) {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.select();
    }
  };

  const hasQuery = query.trim().length > 0;
  const counter = !hasQuery
    ? ""
    : count === 0
      ? "No results"
      : `${index === null ? 0 : index + 1} of ${count}${count >= MAX_FIND_MATCHES ? "+" : ""}`;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="transcript-find"
          role="search"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ type: "tween", duration: duration.micro, ease }}
          className={cn(
            "absolute right-3 top-3 z-6 w-[min(380px,calc(100%-24px))]",
            "phone:top-[calc(var(--pane-header-h)+var(--strip-clearance,0px)+8px)]",
          )}
        >
          <div className="flex items-center gap-1 rounded-popup bg-popup py-1 pl-2.5 pr-1 [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md">
            <IconSearch size={20} className="shrink-0 text-faint" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Find in session"
              aria-label="Find in session"
              spellCheck={false}
              autoComplete="off"
              enterKeyHint="search"
              className="min-h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-faint phone:min-h-11 phone:text-input-phone"
            />
            <span
              className="shrink-0 text-label tabular-nums text-faint"
              aria-live="polite"
            >
              {counter}
            </span>
            {hasQuery && count === 0 && onLoadAll && (
              <Button variant="ghost" size="sm" onClick={onLoadAll}>
                Load all
              </Button>
            )}
            <Tooltip label="Older match" shortcut={["↵"]}>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconArrowUp size={20} />}
                aria-label="Older match"
                disabled={count === 0}
                onClick={() => step(-1)}
              />
            </Tooltip>
            <Tooltip label="Newer match" shortcut={["⇧", "↵"]}>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconArrowDown size={20} />}
                aria-label="Newer match"
                disabled={count === 0}
                onClick={() => step(1)}
              />
            </Tooltip>
            <Tooltip label="Close" shortcut={["Esc"]}>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconX size={20} />}
                aria-label="Close find"
                onClick={close}
              />
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
