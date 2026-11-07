import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";
import { createThreadApi } from "../../lib/api";
import { rangeForAnchor, anchorEntryElement } from "../../lib/comment-anchor";
import { stackCards } from "../../lib/comment-layout";
import {
  inlineThreads,
  sendThreadToSession,
  threadPreview,
} from "../../lib/comment-threads";
import { errorMessage } from "../../lib/error-message";
import { onThreadFocusRequest, takeThreadFocus } from "../../lib/thread-focus";
import type { CommentThread } from "../../lib/types";
import { useCommentDraft } from "../../lib/comment-draft";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { duration, ease } from "../../ui/motion";
import { ResponsiveDialog } from "../../ui/sheet";
import { toast } from "../../ui/toast";
import { IconMessages, IconX } from "../icons";
import { UserAvatar } from "../UserAvatar";
import { useCurrentUser } from "../UserPicker";
import { CommentComposer } from "./CommentComposer";
import {
  CommentThreadView,
  ThreadPassage,
  commentTime,
} from "./CommentThreadView";

const HIGHLIGHT = "comment";
const HIGHLIGHT_ACTIVE = "comment-active";
const DRAFT_ID = "__draft__";
/** Narrowest margin card, and the air either side of it. */
const CARD_MIN_W = 260;
const CARD_MAX_W = 340;
const CARD_GUTTER = 24;

type Mode = "margin" | "float" | "sheet";

interface PassageBox {
  /** Content coordinates: relative to the scroller's top, scroll included. */
  top: number;
  bottom: number;
  left: number;
}

interface Geometry {
  boxes: Map<string, PassageBox>;
  /** Region coordinates of the reading column. */
  columnLeft: number;
  columnRight: number;
  /** Right edge of the free margin: the region's edge, or the workspace
   *  summary popover's left edge when it sits over the margin. */
  marginRight: number;
  regionWidth: number;
  /** Visible height of the transcript scroller: the tallest a card gets. */
  viewHeight: number;
  /** Scroller top within the region. */
  scrollerTop: number;
}

function liveRange(range: Range): boolean {
  return (
    range.startContainer.isConnected &&
    range.endContainer.isConnected &&
    !range.collapsed
  );
}

function sameRanges(a: Map<string, Range>, b: Map<string, Range>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, range] of b) {
    const other = a.get(id);
    if (
      !other ||
      other.startContainer !== range.startContainer ||
      other.startOffset !== range.startOffset ||
      other.endContainer !== range.endContainer ||
      other.endOffset !== range.endOffset
    )
      return false;
  }
  return true;
}

function sameGeometry(a: Geometry, b: Geometry): boolean {
  if (
    a.columnLeft !== b.columnLeft ||
    a.columnRight !== b.columnRight ||
    a.marginRight !== b.marginRight ||
    a.regionWidth !== b.regionWidth ||
    a.viewHeight !== b.viewHeight ||
    a.scrollerTop !== b.scrollerTop ||
    a.boxes.size !== b.boxes.size
  )
    return false;
  for (const [id, box] of b.boxes) {
    const other = a.boxes.get(id);
    if (
      !other ||
      other.top !== box.top ||
      other.bottom !== box.bottom ||
      other.left !== box.left
    )
      return false;
  }
  return true;
}

function hitTest(range: Range, x: number, y: number): boolean {
  for (const rect of Array.from(range.getClientRects()))
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      return true;
  return false;
}

/**
 * Inline comments on the session transcript.
 *
 * Passages with an open thread are painted with Custom Highlights (no change
 * to the transcript's DOM). Where the window has room beside the reading
 * column, every open thread gets a card in the right margin, level with its
 * words, the way a document editor shows comments. A narrower desktop shows
 * only the thread you clicked, floating under its passage, and a phone opens
 * it in a bottom sheet. A "Comments" control lists every thread, including
 * resolved ones and team notes.
 */
export function InlineComments({
  sessionId,
  threads,
  containerRef,
  isPhone,
}: {
  sessionId: string;
  threads: CommentThread[];
  /** The transcript scroller. */
  containerRef: React.RefObject<HTMLElement | null>;
  isPhone: boolean;
}) {
  // The comment being written, handed over by the selection pill.
  const [draft, onDraftChange] = useCommentDraft(sessionId);
  const me = useCurrentUser();
  const overlayRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const rangesRef = useRef(new Map<string, Range>());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const [listOpen, setListOpen] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const anchored = useMemo(() => inlineThreads(threads), [threads]);
  const shown = useMemo(
    () => anchored.filter((t) => t.status === "open" || t.id === activeId),
    [anchored, activeId],
  );
  const openCount = useMemo(
    () => threads.filter((t) => t.status === "open").length,
    [threads],
  );

  // A thread just posted from the draft: keep the draft on screen until the
  // stored thread arrives, then hand the highlight and focus over to it.
  useEffect(() => {
    if (!savingId || !threads.some((t) => t.id === savingId)) return;
    setActiveId(savingId);
    setSavingId(null);
    onDraftChange(null);
  }, [savingId, threads, onDraftChange]);

  // ── Geometry ────────────────────────────────────────────────────────────
  const frame = useRef(0);
  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const container = containerRef.current;
      const overlay = overlayRef.current;
      if (!container || !overlay) return;
      const ranges = new Map<string, Range>();
      for (const thread of shown) {
        const range = thread.anchor && rangeForAnchor(container, thread.anchor);
        if (range) ranges.set(thread.id, range);
      }
      if (draft) {
        const range = liveRange(draft.range)
          ? draft.range
          : rangeForAnchor(container, draft.anchor);
        if (range) ranges.set(DRAFT_ID, range);
      }
      const unchangedRanges = sameRanges(rangesRef.current, ranges);
      rangesRef.current = ranges;

      const scrollerRect = container.getBoundingClientRect();
      const regionRect = overlay.getBoundingClientRect();
      const boxes = new Map<string, PassageBox>();
      for (const [id, range] of ranges) {
        const rects = Array.from(range.getClientRects()).filter(
          (r) => r.width > 0 || r.height > 0,
        );
        if (!rects.length) continue;
        const first = rects[0]!;
        const last = rects[rects.length - 1]!;
        boxes.set(id, {
          top: first.top - scrollerRect.top + container.scrollTop,
          bottom: last.bottom - scrollerRect.top + container.scrollTop,
          left: first.left - regionRect.left,
        });
      }
      // Measure the rendered reading column (as MessageRail does) rather
      // than computing it from --session-col: rows already sit under any
      // translate the pane applies.
      const row = container.querySelector<HTMLElement>(".msg");
      const rowRect = row?.getBoundingClientRect();
      const columnLeft = rowRect
        ? rowRect.left - regionRect.left
        : Math.max(0, (regionRect.width - 780) / 2);
      const columnRight = rowRect
        ? rowRect.right - regionRect.left
        : Math.min(regionRect.width, columnLeft + 780);
      // The workspace summary floats over the top of the right margin when
      // it is open (WorkspaceSummary.tsx; `.ws-summary-band` is its row
      // hook). Cards must not slide under it.
      const summary = document
        .querySelector(".ws-summary-band")
        ?.closest<HTMLElement>("[role='dialog']");
      const summaryRect = summary?.getBoundingClientRect();
      const marginRight =
        summaryRect &&
        summaryRect.width > 0 &&
        summaryRect.left - regionRect.left > columnRight
          ? summaryRect.left - regionRect.left
          : regionRect.width;
      const next: Geometry = {
        boxes,
        columnLeft,
        columnRight,
        marginRight,
        regionWidth: regionRect.width,
        viewHeight: container.clientHeight,
        scrollerTop: scrollerRect.top - regionRect.top,
      };
      // Streaming and scrolling mutate the transcript many times a second,
      // usually without moving a passage. Keep the old value then, so the
      // overlay does not re-render and the highlights are not rebuilt.
      setGeometry((current) =>
        current && unchangedRanges && sameGeometry(current, next)
          ? current
          : next,
      );
      const layer = layerRef.current;
      if (layer) {
        layer.style.transform = `translateY(${scrollerRect.top - regionRect.top - container.scrollTop}px)`;
        layer.style.setProperty("--comment-scroll", `${container.scrollTop}px`);
      }
    });
  }, [containerRef, shown, draft]);

  useLayoutEffect(() => {
    measure();
  }, [measure, activeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Content streams in, ranges hydrate and blocks expand: re-anchor on
    // any change, coalesced to one pass per frame.
    const mutations = new MutationObserver(measure);
    mutations.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const resize = new ResizeObserver(measure);
    resize.observe(container);
    // Popovers (the workspace summary) mount as portals on <body>.
    const portals = new MutationObserver(measure);
    portals.observe(document.body, { childList: true });
    // Scrolling only moves the layer; the passages keep their content
    // coordinates, so no re-measure is needed.
    const onScroll = () => {
      const layer = layerRef.current;
      const overlay = overlayRef.current;
      if (!layer || !overlay) return;
      const offset =
        container.getBoundingClientRect().top -
        overlay.getBoundingClientRect().top;
      layer.style.transform = `translateY(${offset - container.scrollTop}px)`;
      // Cards size themselves to the room below their top on screen.
      layer.style.setProperty("--comment-scroll", `${container.scrollTop}px`);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      mutations.disconnect();
      resize.disconnect();
      portals.disconnect();
      container.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame.current);
    };
  }, [containerRef, measure]);

  // ── Highlights ──────────────────────────────────────────────────────────
  useEffect(() => {
    const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!highlights || typeof Highlight === "undefined") return;
    const quiet: Range[] = [];
    const strong: Range[] = [];
    for (const [id, range] of rangesRef.current) {
      const thread = anchored.find((t) => t.id === id);
      const isActive = id === DRAFT_ID || id === activeId;
      if (isActive) strong.push(range);
      else if (thread?.status === "open") quiet.push(range);
    }
    highlights.set(HIGHLIGHT, new Highlight(...quiet));
    highlights.set(HIGHLIGHT_ACTIVE, new Highlight(...strong));
  }, [geometry, anchored, activeId]);

  useEffect(
    () => () => {
      CSS.highlights?.delete(HIGHLIGHT);
      CSS.highlights?.delete(HIGHLIGHT_ACTIVE);
    },
    [],
  );

  // ── Choosing a thread ───────────────────────────────────────────────────
  // A click on highlighted words opens that thread. A drag that selects text
  // is not a click on a comment.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (event: MouseEvent) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      for (const [id, range] of rangesRef.current) {
        if (id === DRAFT_ID) continue;
        if (hitTest(range, event.clientX, event.clientY)) {
          setActiveId(id);
          return;
        }
      }
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [containerRef]);

  // Pressing anywhere outside a card or a highlight lets the thread go, as
  // does Escape. The sheet handles its own dismissal.
  useEffect(() => {
    if (!activeId || isPhone) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-comment-card], [role='menu'], [role='dialog']"))
        return;
      for (const [id, range] of rangesRef.current)
        if (id !== DRAFT_ID && hitTest(range, event.clientX, event.clientY))
          return;
      setActiveId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setActiveId(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [activeId, isPhone]);

  // A new draft takes focus from any open thread.
  useEffect(() => {
    if (draft) setActiveId(null);
  }, [draft]);

  const scrollToThread = useCallback(
    (thread: CommentThread) => {
      const container = containerRef.current;
      if (!container) return;
      const note = container.querySelector<HTMLElement>(
        `[data-note-thread="${CSS.escape(thread.id)}"]`,
      );
      const target = thread.anchor
        ? rangeForAnchor(container, thread.anchor)
        : null;
      const element = target
        ? null
        : thread.anchor
          ? anchorEntryElement(container, thread.anchor)
          : note;
      const rect =
        target?.getBoundingClientRect() ?? element?.getBoundingClientRect();
      if (!rect) {
        toast(
          "That part of the session isn't loaded yet. Scroll up to load it.",
        );
        return;
      }
      const box = container.getBoundingClientRect();
      container.scrollTo({
        top: container.scrollTop + rect.top - box.top - box.height / 3,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      if (thread.anchor) {
        if (!target && thread.anchor)
          toast(
            "The commented text has changed since. The thread is still here.",
          );
        setActiveId(thread.id);
      }
    },
    [containerRef],
  );

  // ── Deep link: a session link with ?thread=<id> (lib/thread-focus.ts) ──
  const [focusRequests, setFocusRequests] = useState(0);
  useEffect(
    () => onThreadFocusRequest(() => setFocusRequests((n) => n + 1)),
    [],
  );
  useEffect(() => {
    const id = takeThreadFocus((wanted) =>
      threads.some((t) => t.id === wanted),
    );
    const thread = id ? threads.find((t) => t.id === id) : undefined;
    if (!thread) return;
    // Let the transcript lay out first. Not cancelled on a re-render: the
    // request is already taken, and a thread update must not drop it.
    window.setTimeout(() => scrollToThread(thread), 300);
  }, [threads, scrollToThread, focusRequests]);

  // ── Layout ──────────────────────────────────────────────────────────────
  const marginRoom = geometry ? geometry.marginRight - geometry.columnRight : 0;
  const mode: Mode = isPhone
    ? "sheet"
    : marginRoom >= CARD_MIN_W + CARD_GUTTER * 2
      ? "margin"
      : "float";
  const cardWidth =
    mode === "margin"
      ? Math.min(CARD_MAX_W, marginRoom - CARD_GUTTER * 2)
      : Math.min(
          420,
          Math.max(
            CARD_MIN_W,
            (geometry?.columnRight ?? 0) - (geometry?.columnLeft ?? 0),
          ),
        );

  const cards = useMemo(() => {
    if (!geometry || mode === "sheet") return [];
    const ids: string[] =
      mode === "margin" ? shown.map((t) => t.id) : activeId ? [activeId] : [];
    if (draft) ids.push(DRAFT_ID);
    const slots = ids
      .filter((id) => geometry.boxes.has(id))
      .map((id) => {
        const box = geometry.boxes.get(id)!;
        return {
          id,
          want: mode === "margin" ? box.top - 4 : box.bottom + 8,
          height: heights.get(id) ?? 120,
        };
      });
    const tops =
      mode === "margin"
        ? stackCards(slots, draft ? DRAFT_ID : activeId)
        : new Map(slots.map((s) => [s.id, s.want]));
    return slots.map((slot) => {
      const box = geometry.boxes.get(slot.id)!;
      const left =
        mode === "margin"
          ? geometry.columnRight + CARD_GUTTER
          : Math.max(
              geometry.columnLeft,
              Math.min(box.left, geometry.columnRight - cardWidth),
            );
      return { id: slot.id, top: tops.get(slot.id)!, left };
    });
  }, [geometry, mode, shown, activeId, draft, heights, cardWidth]);

  const reportHeight = useCallback((id: string, height: number) => {
    setHeights((prev) => {
      if (prev.get(id) === height) return prev;
      const next = new Map(prev);
      next.set(id, height);
      return next;
    });
  }, []);

  // Wheel over a margin card scrolls the card while a long thread has more
  // to show in that direction, then the transcript, as it would over the
  // margin itself. Never both at once.
  const forwardWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const card = event.currentTarget;
    const canScroll =
      event.deltaY > 0
        ? card.scrollTop + card.clientHeight < card.scrollHeight - 1
        : event.deltaY < 0 && card.scrollTop > 0;
    if (canScroll) return;
    container.scrollBy({ top: event.deltaY });
  };
  // A card never runs past the bottom of the visible transcript: a long
  // answer scrolls inside it, so its end and the reply box stay reachable.
  // The room below a card's top changes as the transcript scrolls, which
  // the layer tracks in --comment-scroll without re-rendering.
  const viewHeight = geometry?.viewHeight ?? 600;
  const cardMaxHeight = (top: number) =>
    `clamp(200px, calc(${viewHeight - top - 16}px + var(--comment-scroll, 0px)), ${Math.max(200, viewHeight - 24)}px)`;

  async function postDraft(text: string): Promise<boolean> {
    if (!draft) return false;
    try {
      const thread = await createThreadApi(sessionId, {
        text,
        user: me,
        anchor: draft.anchor,
      });
      setSavingId(thread.id);
      return true;
    } catch (error) {
      toast(errorMessage(error, "Failed to add comment"));
      return false;
    }
  }

  const activeThread = activeId
    ? (threads.find((t) => t.id === activeId) ?? null)
    : null;

  const draftComposer = (
    <CommentComposer
      autoFocus
      placeholder="Add a comment. @ to mention"
      submitLabel="Comment"
      onSubmit={postDraft}
      onCancel={() => onDraftChange(null)}
    />
  );

  const renderCard = (id: string) => {
    if (id === DRAFT_ID)
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <UserAvatar name={me} size={20} />
            <span className="text-supporting font-semibold text-fg">{me}</span>
          </div>
          {draftComposer}
        </div>
      );
    const thread = threads.find((t) => t.id === id);
    if (!thread) return null;
    const isActive = id === activeId;
    return (
      <CommentThreadView
        thread={thread}
        sessionId={sessionId}
        showReply={isActive}
        autoFocusReply={false}
        onSendToSession={(t) => sendThreadToSession(sessionId, t)}
        onResolved={() => setActiveId(null)}
      />
    );
  };

  return (
    <>
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      >
        <div ref={layerRef} className="absolute inset-x-0 top-0">
          {cards.map((card) => {
            const isActive = card.id === activeId || card.id === DRAFT_ID;
            return (
              <MarginCard
                key={card.id}
                id={card.id}
                top={card.top}
                left={card.left}
                width={cardWidth}
                maxHeight={cardMaxHeight(card.top)}
                active={isActive}
                onHeight={reportHeight}
                onActivate={() => {
                  if (card.id !== DRAFT_ID) setActiveId(card.id);
                }}
                onWheel={forwardWheel}
              >
                {renderCard(card.id)}
              </MarginCard>
            );
          })}
        </div>
      </div>

      {openCount > 0 || threads.length > 0 ? (
        <Button
          variant="soft"
          size="sm"
          icon={<IconMessages size={16} />}
          onClick={() => setListOpen(true)}
          aria-label={`Comments, ${openCount} open`}
          className="absolute top-2 z-[6] phone:top-[calc(var(--header-h)+4px)] phone:min-h-11"
          // Beside the workspace summary when it covers the corner.
          style={{
            right: geometry
              ? geometry.regionWidth - geometry.marginRight + 12
              : 12,
          }}
        >
          {openCount > 0 ? String(openCount) : "Comments"}
        </Button>
      ) : null}

      {/* Phone: the thread or the draft in a bottom sheet. */}
      <ResponsiveDialog
        open={mode === "sheet" && (!!activeThread || !!draft)}
        onClose={() => {
          setActiveId(null);
          if (draft && !savingId) onDraftChange(null);
        }}
        phone={isPhone}
        label={draft ? "New comment" : "Comment"}
      >
        <div className="flex max-h-[80dvh] flex-col gap-3 overflow-y-auto px-4 pb-4 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-item-title font-semibold text-fg">
              {draft ? "New comment" : "Comment"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconX size={18} />}
              aria-label="Close"
              onClick={() => {
                setActiveId(null);
                if (draft && !savingId) onDraftChange(null);
              }}
              className="ml-auto min-h-11 min-w-11"
            />
          </div>
          {draft ? (
            <>
              <blockquote className="m-0 line-clamp-3 border-l-2 border-[color:var(--yellow)] pl-2.5 text-supporting text-dim">
                {draft.anchor.exact}
              </blockquote>
              {draftComposer}
            </>
          ) : activeThread ? (
            <>
              <ThreadPassage thread={activeThread} />
              <CommentThreadView
                thread={activeThread}
                sessionId={sessionId}
                onSendToSession={(t) => {
                  sendThreadToSession(sessionId, t);
                  setActiveId(null);
                }}
                onResolved={() => setActiveId(null)}
              />
            </>
          ) : null}
        </div>
      </ResponsiveDialog>

      <CommentsList
        open={listOpen}
        onClose={() => setListOpen(false)}
        isPhone={isPhone}
        threads={threads}
        onOpen={(thread) => {
          setListOpen(false);
          scrollToThread(thread);
        }}
      />
    </>
  );
}

function MarginCard({
  id,
  top,
  left,
  width,
  maxHeight,
  active,
  onHeight,
  onActivate,
  onWheel,
  children,
}: {
  id: string;
  top: number;
  left: number;
  width: number;
  /** A CSS length; see cardMaxHeight. */
  maxHeight: string;
  active: boolean;
  onHeight: (id: string, height: number) => void;
  onActivate: () => void;
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => onHeight(id, node.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, onHeight]);
  return (
    <motion.div
      ref={ref}
      data-comment-card={id}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "tween", duration: duration.micro, ease }}
      onPointerDown={onActivate}
      onWheel={onWheel}
      className={cn(
        "pointer-events-auto absolute overflow-y-auto overscroll-contain rounded-xl bg-popup p-3 [--smooth-ring-color:var(--popup-ring)] motion-safe:transition-[top,box-shadow] motion-safe:duration-150",
        active ? "z-[2] smooth-shadow-ring-md" : "smooth-shadow-ring-sm",
      )}
      style={{ top, left, width, maxHeight }}
    >
      {children}
    </motion.div>
  );
}

function CommentsList({
  open,
  onClose,
  isPhone,
  threads,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  isPhone: boolean;
  threads: CommentThread[];
  onOpen: (thread: CommentThread) => void;
}) {
  const me = useCurrentUser();
  const [filter, setFilter] = useState<"open" | "mine" | "resolved">("open");
  const key = me.trim().toLowerCase();
  const forMe = (t: CommentThread) =>
    t.assignee?.toLowerCase() === key ||
    t.comments.some((c) => c.text.toLowerCase().includes(`@${key}`));
  const shown = threads
    .filter((t) =>
      filter === "resolved"
        ? t.status === "resolved"
        : t.status === "open" && (filter === "open" || forMe(t)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <ResponsiveDialog
      open={open}
      onClose={onClose}
      phone={isPhone}
      label="Comments"
      modalClassName="w-[min(560px,92vw)]"
    >
      <div className="flex max-h-[80dvh] min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          <span className="text-item-title font-semibold text-fg">
            Comments
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconX size={18} />}
            aria-label="Close"
            onClick={onClose}
            className="ml-auto phone:min-h-11 phone:min-w-11"
          />
        </div>
        <div className="flex gap-1 px-4 pb-2" role="tablist">
          {(
            [
              ["open", "Open"],
              ["mine", "For you"],
              ["resolved", "Resolved"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "soft" : "ghost"}
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className="phone:min-h-11"
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          {shown.length === 0 ? (
            <div className="px-2 py-8 text-center text-supporting text-faint">
              {filter === "resolved"
                ? "No resolved comments"
                : filter === "mine"
                  ? "Nothing waiting on you"
                  : "No open comments"}
            </div>
          ) : (
            shown.map((thread) => {
              const last = thread.comments[thread.comments.length - 1]!;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => onOpen(thread)}
                  className="focus-ring flex w-full flex-col gap-1.5 rounded-row px-2.5 py-2.5 text-left hover:bg-hover"
                >
                  {thread.anchor ? (
                    <ThreadPassage thread={thread} className="line-clamp-2" />
                  ) : (
                    <span className="text-meta text-faint">
                      Note on the session
                    </span>
                  )}
                  <span className="flex min-w-0 items-center gap-2">
                    <UserAvatar name={thread.createdBy} size={18} />
                    <span className="min-w-0 truncate text-supporting text-fg">
                      <span className="font-semibold">{thread.createdBy}</span>{" "}
                      {threadPreview(thread)}
                    </span>
                  </span>
                  <span className="text-meta text-faint">
                    {thread.comments.length > 1
                      ? `${thread.comments.length - 1} ${thread.comments.length === 2 ? "reply" : "replies"} · `
                      : ""}
                    {commentTime(last.ts)}
                    {thread.assignee ? ` · Assigned to ${thread.assignee}` : ""}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </ResponsiveDialog>
  );
}
