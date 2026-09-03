import { useIsPhone } from "../../hooks/useIsPhone";
import { useShortcutKeys } from "../../hooks/useShortcutBindings";
import { hasDraft } from "../../lib/drafts";
import { markRead, markUnread } from "../../lib/reads";
import {
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_RAIL_GAP,
  SIDEBAR_RAIL_PAD,
  SIDEBAR_ROW_CHIP,
  SIDEBAR_STATUS_DOT,
  SIDEBAR_SWIPE_ACTION,
  SIDEBAR_SWIPE_ACTION_ARCHIVE,
  SIDEBAR_SWIPE_ACTION_OPEN,
  SIDEBAR_SWIPE_ACTION_STAR,
  SIDEBAR_SWIPE_ACTION_STAR_ON,
  SIDEBAR_SWIPE_ACTION_TRANSITION,
  SIDEBAR_SWIPE_ROW,
  SIDEBAR_WS_DRAFT,
} from "../../lib/sidebar-classes";
import {
  isClaimed,
  mineStatus,
  pinnedLane,
  runNeedsAttention,
  stripPrTitlePrefix,
} from "../../lib/sidebar-lanes";
import { sessionWasAgentStarted } from "../../lib/sidebar-placement";
import { shouldEmphasizeUnread } from "../../lib/sidebar-unread-session";
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  SWIPE_AXIS_LOCK_PX,
  SWIPE_COMMIT_MS,
  SWIPE_OPEN_THRESHOLD,
  SWIPE_REVEAL_PX,
  clampSwipe,
  fullSwipeThreshold,
  swipeCommitOffset,
  type SwipeAction,
} from "../../lib/sidebar-swipe";
import type { LaneChoice } from "../../lib/sidebar-types";
import type { UnifiedSession } from "../../lib/types";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import {
  BottomSheet,
  SheetBody,
  SheetItem,
  SheetSeparator,
  SheetTitle,
} from "../../ui/sheet";
import { Tooltip } from "../../ui/tooltip";
import { RowCardPopup, useRowHoverCard } from "../SidebarRowCards";
import { AutoCreatedMark } from "./AutoCreatedMark";
import { KeepInSidebarMark } from "./KeepInSidebarMark";
import {
  LanePickerPage,
  LaneStatusMark,
  SheetDrillInItem,
  lanePickerLabel,
} from "./MobileSheetPages";
import { OriginMark } from "./OriginMark";
import {
  IconArchive,
  IconInbox,
  IconMail,
  IconPencil,
  IconPin,
} from "../icons";
import { SessionCardBody, WsPrStatusMark } from "../sidebar/HoverCards";
import { SidebarCtxMenu } from "../sidebar/SidebarCtxMenu";
import { UserAvatar } from "../UserAvatar";
import React, { useEffect, useRef, useState } from "react";

type SwipeRowStyle = React.CSSProperties & { "--swipe-action-w": string };

/** The sidebar's selectable row — the shape every list family wears: session,
 *  workspace, PR, support, feed and archived rows. Migrated off the
 *  legacy row family, so the state that used to live in `-selected` /
 *  `-waiting` / `-unread` modifier classes now rides `data-*` attributes on
 *  the row itself and descendants read it through `group-data-[…]` variants.
 *  `data-sidebar-row` is the hook the ⌘↑/⌘↓ row walker queries by.
 *
 *  Rows wrapped in a swipe shell add `mt-0` — the wrapper carries the 2px gap
 *  for them — plus the swipe transform; bare rows keep the margin. On phones,
 *  row marks sit on the same 16px rail as tool and repo marks. The inset is
 *  written against `--sidebar-icon-left` (12px at its default 16) rather than
 *  as a flat 4, so a family that nests by overriding that variable, today the
 *  runs under an automation, indents at phone width too and not only on
 *  desktop, where the rail pad already reads it.
 *
 *  `--sidebar-row-pad` around the 22px rail is the sidebar's ITEM height (see
 *  the height scale in lib/sidebar-classes.ts): 7px for a 36px box, and 4px
 *  for the 30px one the compact density asks for. It is the same box the tool
 *  rows and the item headings take at either setting, so a repo band and its
 *  sessions run as one regular column. It was a flat 9px, which made a session
 *  row the tallest thing in the rail and 12px taller than a tool row saying the
 *  same kind of thing.
 *  Phones keep `py-[13px]` at both densities: 36px is a reading height, not a
 *  tap target, so the compact values are gated to desktop where they are set. */
export const SIDEBAR_ROW = `group relative mt-0.5 w-full rounded-row border-0 bg-transparent py-[var(--sidebar-row-pad)] pr-2 ${SIDEBAR_RAIL_PAD} text-left text-fg phone:pr-2 phone:pl-[calc(var(--sidebar-icon-left,16px)-12px)] phone:py-[13px]`;

/** A row's title: one line that fades smoothly at the available edge instead
 *  of ending in an ellipsis. Read conversations stay quiet; unread ones
 *  brighten immediately, then bold once the agent finishes. A blocked one
 *  also bolds because it needs a person. */
/* Pin + one trailing action, hover-revealed on desktop: Archive for your own
   sessions, Keep for somebody else's. They take the metadata's place at the
   far right so they don't crowd the title. Long titles run under
   that spot, and what used to cover them was an opaque plate per button — which
   only ever worked because the row it sat on was opaque too. Now that a row's
   states are translucent ink, a solid chip cuts a hole in the material behind
   it, so the row reserves the space instead (`hover:pr-[68px]` below) and the
   buttons carry nothing but their own hover wash.
   The reveal is `group-hover`, which Tailwind gates to real hover devices for
   us. Team's add action is the exception: it stays visible with a 44px touch
   target because every row there is waiting to be added. */
const ROW_ACTION = cn(
  "absolute top-1/2 hidden size-[var(--sidebar-row-action,26px)] -translate-y-1/2 items-center justify-center rounded-md text-[15px] leading-none text-faint group-hover:flex hover:text-fg",
  // Not a wash — a lid. See SIDEBAR_ROW_CHIP.
  SIDEBAR_ROW_CHIP,
);

export const SIDEBAR_ROW_TITLE =
  "min-w-0 flex-1 overflow-hidden whitespace-nowrap [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_24px),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%_-_24px),transparent)] text-body font-medium leading-[1.35] text-dim desktop:text-item-title group-data-[selected]:text-fg group-data-[waiting]:font-semibold group-data-[finished-unread]:font-semibold group-data-[unread]:text-fg";

export function SidebarItem({
  session,
  selected,
  unread,
  mention,
  mine,
  showOwner = !mine,
  alwaysShowAddToSidebar = false,
  onClick,
  onArchive: onArchiveRequest,
  pinned,
  onTogglePin,
  shipsDirectlyToMain = false,
  onRename,
  onSetStatus,
}: {
  session: UnifiedSession;
  selected: boolean;
  /** New activity since this session was last opened — brightens and bolds the
	    title, like an unread Slack conversation. */
  unread: boolean;
  /** Who @-mentioned you in this session, if anyone. Cleared by opening it
	    (lib/mentions.ts), so it only ever marks a session you have not read
	    since being tagged. */
  mention?: string | null;
  /** The current user's own session — the owner name is redundant, so it's
	    dropped and the timestamp moves up onto the title line. */
  mine: boolean;
  /** Show the starter below the title. Person-group rows set this false because
	    their heading already names the starter without claiming the session as mine. */
  showOwner?: boolean;
  /** Team rows are all unkept work, so their add affordance stays visible. */
  alwaysShowAddToSidebar?: boolean;
  onClick: () => void;
  onArchive: (current: HTMLButtonElement | null) => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** The session commits to the repo's default branch, so no PR is expected. */
  shipsDirectlyToMain?: boolean;
  onRename: (title: string) => void;
  /** Pin this session into a sidebar lane (null = back to derived). Present on
	    automation rows — it's how an automation run graduates into your lanes. */
  onSetStatus?: (status: LaneChoice | null) => void;
}) {
  const isPhone = useIsPhone();
  // The row's tooltips advertise whatever the user has these bound to.
  const pinKeys = useShortcutKeys("session-pin");
  const archiveKeys = useShortcutKeys("session-archive");
  const waitingForInput = !!session.waitingForInput;
  const failed = runNeedsAttention(session);
  const canKeepInSidebar = !!onSetStatus && !mine && !isClaimed(session);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Desktop right-click menu (mobile long-press opens the action sheet).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctxMenu]);

  // Hover card: after a short dwell, the row's detail card — the same one
  // every other sidebar row raises. Held back while renaming (the input the
  // row turns into owns the interaction).
  const btnRef = useRef<HTMLButtonElement>(null);
  const card = useRowHoverCard(editing);
  const closeHover = card.close;
  const onArchive = () => onArchiveRequest(btnRef.current);

  // Mobile long-press → action sheet, and — importantly — the *tap* to open a
  // session is driven from `touchend`, not the synthesized `click`. The row
  // has `:hover` styles (the reveal-on-hover X, the hover background), and iOS
  // treats the first tap on a hover-styled element as a hover-in, swallowing the
  // click — so a click-driven open needs a second tap ("first tap doesn't work").
  // Firing on touchend sidesteps that entirely. A hold that stays roughly in
  // place for LONG_PRESS_MS opens the sheet instead; any real finger travel (a
  // scroll) cancels both.
  const [sheetOpen, setSheetOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const moved = useRef(false);
  const swipeOrigin = useRef<{ x: number; y: number; width: number } | null>(
    null,
  );
  const swiping = useRef(false);
  const swipeOffsetRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [swipeAction, setSwipeAction] = useState<SwipeAction | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  useEffect(() => {
    if (selected || !isPhone) {
      setSwipeOffset(0);
      swipeOffsetRef.current = 0;
      setSwipeAction(null);
      setDragging(false);
    }
  }, [isPhone, selected]);

  function clearPress() {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressOrigin.current = null;
  }
  function onTouchStart(e: React.TouchEvent) {
    if (editing || e.touches.length !== 1) return;
    const t = e.touches[0];
    longPressed.current = false;
    moved.current = false;
    swiping.current = false;
    clearPress();
    // After clearPress (which nulls it) so it survives to onTouchMove/onTouchEnd.
    pressOrigin.current = { x: t.clientX, y: t.clientY };
    swipeOrigin.current = {
      x: t.clientX - swipeOffset,
      y: t.clientY,
      width: e.currentTarget.clientWidth,
    };
    setSwipeAction(null);
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      closeHover();
      navigator.vibrate?.(10);
      setSheetOpen(true);
    }, LONG_PRESS_MS);
  }
  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const swipeO = swipeOrigin.current;
    if (swipeO && !longPressed.current) {
      const dx = t.clientX - swipeO.x;
      const dy = t.clientY - swipeO.y;
      const swipeDx = canKeepInSidebar && dx < 0 ? 0 : dx;
      if (
        swiping.current ||
        (Math.abs(swipeDx) > SWIPE_AXIS_LOCK_PX &&
          Math.abs(swipeDx) > Math.abs(dy))
      ) {
        swiping.current = true;
        moved.current = true;
        setDragging(true);
        clearPress();
        e.preventDefault();
        const offset = clampSwipe(swipeDx, swipeO.width);
        swipeOffsetRef.current = offset;
        setSwipeOffset(offset);
        return;
      }
    }
    const o = pressOrigin.current;
    if (!o) return;
    if (
      Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
      Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
    ) {
      moved.current = true;
      clearPress();
    }
  }
  function onTouchEnd(e: React.TouchEvent) {
    const hadOrigin = pressOrigin.current !== null;
    const wasSwiping = swiping.current;
    const rowWidth = swipeOrigin.current?.width ?? e.currentTarget.clientWidth;
    const currentOffset = swipeOffsetRef.current;
    clearPress();
    swipeOrigin.current = null;
    swiping.current = false;
    setDragging(false);
    if (editing) return;
    if (wasSwiping) {
      e.preventDefault();
      if (Math.abs(currentOffset) >= fullSwipeThreshold(rowWidth)) {
        const action: SwipeAction = currentOffset < 0 ? "archive" : "star";
        setSwipeAction(action);
        setSwipeOffset(swipeCommitOffset(action, rowWidth));
        window.setTimeout(() => {
          if (action === "archive") onArchive();
          else {
            onTogglePin();
            setSwipeOffset(0);
            window.setTimeout(() => setSwipeAction(null), SWIPE_COMMIT_MS);
          }
          swipeOffsetRef.current = 0;
        }, SWIPE_COMMIT_MS);
        return;
      }
      const snapped =
        Math.abs(currentOffset) > SWIPE_OPEN_THRESHOLD
          ? currentOffset > 0
            ? SWIPE_REVEAL_PX
            : -SWIPE_REVEAL_PX
          : 0;
      swipeOffsetRef.current = snapped;
      setSwipeOffset(snapped);
      return;
    }
    // A clean tap: it started on this row, never became a long-press, and
    // never turned into a scroll. Open now and swallow the ghost click iOS
    // would fire ~300ms later (which the :hover heuristic may drop anyway).
    if (hadOrigin && !longPressed.current && !moved.current) {
      e.preventDefault();
      if (swipeOffset !== 0) {
        setSwipeOffset(0);
        swipeOffsetRef.current = 0;
        return;
      }
      onClick();
    }
  }

  function commitRename() {
    onRename(draft.trim());
    setEditing(false);
  }

  const metaParts: React.ReactNode[] = [];
  // In "My sessions" and under a person's own heading, the owner is already
  // stated by the surrounding list, so repeating it makes every row two lines.
  if (showOwner && session.startedBy && !session.automation) {
    metaParts.push(<span key="u">{session.startedBy}</span>);
  }
  const compactMeta = mine || !showOwner;
  // No idle "time since" here: times only appear while a run is live. The
  // hover card dropped its "Updated 8m ago" for the same reason, and the Info
  // tab is where an exact last-activity stamp belongs.
  if (session.linearIssue) {
    metaParts.push(
      <span key="lin" className="text-[#7b86e8]">
        {session.linearIssue.identifier}
      </span>,
    );
  }

  const visibleSwipeOffset = isPhone ? swipeOffset : 0;
  // The swipe row is "open" — a revealed action sits behind it, so the slide
  // back and forth runs at the shorter duration.
  const swipeOpen = swipeAction !== null || visibleSwipeOffset !== 0;
  // Which side the gesture has revealed. This used to ride the wrapper as
  // `is-swipe-archive` / `is-swipe-star` for a descendant selector to read;
  // the two actions read it directly now, so each one is handed exactly one
  // `display` instead of competing for it through the cascade.
  const openSide: SwipeAction | null =
    swipeAction === "archive" || visibleSwipeOffset < 0
      ? "archive"
      : swipeAction === "star" || visibleSwipeOffset > 0
        ? "star"
        : null;
  const swipeRowStyle: SwipeRowStyle | undefined = visibleSwipeOffset
    ? {
        "--swipe-action-w": `${Math.max(
          SWIPE_REVEAL_PX,
          Math.abs(visibleSwipeOffset),
        )}px`,
      }
    : undefined;

  return (
    <Popover.Root {...card.rootProps}>
      <div
        className={SIDEBAR_SWIPE_ROW}
        data-swipe-row=""
        style={swipeRowStyle}
      >
        {isPhone && !canKeepInSidebar && (
          <button
            className={cn(
              SIDEBAR_SWIPE_ACTION,
              SIDEBAR_SWIPE_ACTION_ARCHIVE,
              openSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
              dragging ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
            )}
            data-swipe-action="archive"
            onClick={(e) => {
              e.stopPropagation();
              setSwipeOffset(0);
              onArchive();
            }}
            title="Archive session"
          >
            <IconArchive size={22} />
            <span>Archive</span>
          </button>
        )}
        {isPhone && (
          <button
            className={cn(
              SIDEBAR_SWIPE_ACTION,
              pinned ? SIDEBAR_SWIPE_ACTION_STAR_ON : SIDEBAR_SWIPE_ACTION_STAR,
              openSide === "star" && SIDEBAR_SWIPE_ACTION_OPEN,
              dragging ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
            )}
            data-swipe-action="star"
            onClick={(e) => {
              e.stopPropagation();
              setSwipeOffset(0);
              onTogglePin();
            }}
            title={pinned ? "Unpin session" : "Pin session"}
          >
            <IconPin size={22} fill={pinned ? "currentColor" : "none"} />
            <span>{pinned ? "Unpin" : "Pin"}</span>
          </button>
        )}
        <Popover.Trigger
          {...card.triggerProps}
          render={
            <button
              ref={btnRef}
              className={cn(
                SIDEBAR_ROW,
                // Inside a swipe row: the wrapper owns the gap, the row owns the
                // slide. Hover paints over selected/waiting here, as it always
                // has — as a layer now, so it lifts those states rather than
                // replacing them (see SIDEBAR_HOVER_LAYER).
                "z-1 mt-0 block touch-pan-y",
                SIDEBAR_HOVER_LAYER,
                // The row gives up its right end to the pin plus one trailing
                // action, the same reserve workspace rows make (SIDEBAR_WS_ROW).
                // Team's add action is standing, so its first chip is reserved
                // even at rest. Other actions remain hover-only. `hover:`, not
                // `group-hover:` — this element is the group itself.
                alwaysShowAddToSidebar
                  ? pinned
                    ? "pr-[38px] hover:pr-[68px] phone:pr-[52px]"
                    : "pr-[38px] phone:pr-[52px]"
                  : pinned
                    ? "hover:pr-[68px]"
                    : "hover:pr-[38px]",
                // No trim here for other people's sessions, which stack a meta
                // line under the title. That used to re-state `py-[7px]` against
                // a 9px base; the base is now the shared `--sidebar-row-pad`, and
                // a hard second `py-*` would out-rank it on Tailwind's output
                // order alone and pin those rows at one density.
                // No fill for "needs you" — the blue mark in the rail and the
                // bold title carry it, and the row's one background slot stays
                // with selection (see the workspace row, which matches).
                selected && "bg-selected",
                dragging
                  ? "transition-none"
                  : swipeOpen
                    ? "transition-transform duration-(--dur-micro)"
                    : "transition-transform duration-(--dur)",
                // One compositor layer for the row under the finger, none for
                // the idle list (dozens of retina-sized layers is a real tax).
                (dragging || swipeOpen) && "will-change-transform",
              )}
              data-sidebar-row=""
              data-sidebar-item-key={`session:${session.id}`}
              data-selected={selected || undefined}
              data-waiting={waitingForInput || undefined}
              data-failed={failed || undefined}
              data-running={session.isRunning || undefined}
              data-unread={unread || undefined}
              data-finished-unread={
                shouldEmphasizeUnread(unread, session.isRunning) || undefined
              }
              style={
                visibleSwipeOffset
                  ? { transform: `translateX(${visibleSwipeOffset}px)` }
                  : undefined
              }
              onClick={(e) => {
                // Touch taps are handled on touchend (and their ghost click is
                // preventDefault'd), so this path is the mouse/desktop one. Still
                // swallow a click that ends a long-press, as a belt-and-suspenders.
                if (longPressed.current) {
                  longPressed.current = false;
                  e.preventDefault();
                  return;
                }
                onClick();
              }}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onTouchCancel={() => {
                clearPress();
                swipeOrigin.current = null;
                swiping.current = false;
                setDragging(false);
              }}
              onContextMenu={(e) => {
                // The sidebar's background carries a menu of its own, so this
                // row's has to claim the event rather than let both open.
                e.stopPropagation();
                // On touch this is the long-press callout: the action sheet
                // owns that gesture, so suppress the native text-selection
                // callout rather than stacking both.
                if (longPressed.current || pressOrigin.current) {
                  e.preventDefault();
                  return;
                }
                e.preventDefault();
                closeHover();
                setCtxMenu({ x: e.clientX, y: e.clientY });
              }}
            />
          }
        >
          {/* The shared rail gap, as every other family takes it: with the
			    SIDEBAR_RAIL slot in front, that pair is what puts every title on
			    one rail. */}
          <div className={cn("flex min-w-0 items-center", SIDEBAR_RAIL_GAP)}>
            {/* Questions stay blue. A stopped run is red, so it cannot look as
				    though it is waiting for a reply. */}
            <span className={SIDEBAR_RAIL}>
              {waitingForInput && (
                <span className="sr-only">Waiting for your input</span>
              )}
              {failed && <span className="sr-only">Last run failed</span>}
              {waitingForInput ? (
                <span
                  className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.waiting}`}
                />
              ) : failed ? (
                <span
                  className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.failed}`}
                />
              ) : session.isRunning ? (
                <span
                  className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.running}`}
                />
              ) : (
                <WsPrStatusMark
                  sessions={[session]}
                  size={18}
                  shipsDirectlyToMain={shipsDirectlyToMain}
                />
              )}
            </span>
            {editing ? (
              <input
                className="min-w-0 flex-1 rounded-md border border-accent bg-bg px-[3px] py-0 text-body font-medium text-inherit outline-none desktop:text-item-title phone:text-input-phone"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setEditing(false);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span
                className={SIDEBAR_ROW_TITLE}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setDraft(session.title);
                  setEditing(true);
                }}
              >
                {stripPrTitlePrefix(session.title)}
              </span>
            )}
            {/* Machine origin stays passive beside the title. Keep belongs with
				    the row's other actions at the right edge. */}
            {!editing && sessionWasAgentStarted(session) && <AutoCreatedMark />}
            {/* Started somewhere else: a Slack thread, a Linear issue. Same slot
				    and ink as the mark above, since both answer "where did this row
				    come from" for a list that mixes origins. */}
            {!editing && <OriginMark source={session.source} />}
            {mention &&
              !editing && (
                // Somebody tagged you here. It takes the slot the unread dot would
                // use and wins over it, because "you were asked" is the stronger
                // signal — and it names who asked, which a dot cannot.
                <span
                  className="relative ml-1 flex shrink-0 items-center"
                  title={`${mention} mentioned you`}
                  aria-label={`${mention} mentioned you`}
                >
                  <UserAvatar name={mention} size={16} className="shrink-0" />
                  <span
                    aria-hidden="true"
                    className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-accent text-[8px] font-bold leading-none text-on-accent ring-2 ring-panel"
                  >
                    @
                  </span>
                </span>
              )}
            {/* Own sessions collapse to one line: the timestamp (+ any PR/Linear
				    badge) rides to the right of the title, flush with the row edge. On
				    hover it fades and the trailing action takes its place. */}
            {compactMeta && !editing && metaParts.length > 0 && (
              <span
                className={cn(
                  "ml-auto flex min-w-10 shrink-0 items-center justify-end gap-1 pl-2.5 whitespace-nowrap text-meta text-faint phone:text-label group-data-[unread]:text-dim",
                  !isPhone && "group-hover:opacity-0",
                )}
              >
                {metaParts.map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="opacity-50">·</span>}
                    {part}
                  </React.Fragment>
                ))}
              </span>
            )}
            {!editing && hasDraft(`session:${session.id}`) && (
              <span
                className={cn(SIDEBAR_WS_DRAFT, "ml-1.5")}
                data-ws-draft=""
                aria-label="Unsent draft. Return to finish it."
              >
                <IconPencil size={20} />
              </span>
            )}
          </div>
          {/* The block meta lives on its own line below the title. The row itself
			    clears the hover-revealed buttons, so this line needs no reserve of
			    its own. */}
          {!compactMeta && (
            <div className="mt-[3px] flex items-center gap-1 overflow-hidden pl-7 whitespace-nowrap text-meta text-faint phone:text-label group-data-[unread]:text-dim">
              {metaParts.map((part, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="opacity-50">·</span>}
                  {part}
                </React.Fragment>
              ))}
            </div>
          )}
          {/* Pin is not one of the row's standing actions. An unpinned row
			    reveals Archive or Keep alone, and pinning stays on the context menu, the
			    keyboard chord and the swipe. A pinned row gets the chip back,
			    because unpinning has to be reachable from the thing it marks. */}
          {!isPhone && pinned && (
            <Tooltip
              label="Unpin session"
              shortcut={selected ? (pinKeys ?? undefined) : undefined}
            >
              <span
                className={cn(
                  ROW_ACTION,
                  // One chip's width plus the archive's 7px edge and the 4px
                  // between them — the ws rows' `gap-1` cluster, spelled as an
                  // offset because these two are positioned rather than laid out.
                  // It has to be a calc: the chip narrows with the density.
                  "right-[calc(var(--sidebar-row-action,26px)_+_11px)] data-[on]:bg-pressed data-[on]:text-fg",
                )}
                data-on=""
                role="button"
                aria-label="Unpin session"
                onMouseEnter={closeHover}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
              >
                <IconPin size={19} fill="currentColor" />
              </span>
            </Tooltip>
          )}
          {!isPhone && !canKeepInSidebar && (
            <Tooltip
              label="Archive session"
              shortcut={selected ? (archiveKeys ?? undefined) : undefined}
            >
              <span
                className={cn(ROW_ACTION, "right-[7px]")}
                role="button"
                aria-label="Archive session"
                onMouseEnter={closeHover}
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive();
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                >
                  <rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
                  <path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
                  <path d="M6.5 8.5h3" strokeLinecap="round" />
                </svg>
              </span>
            </Tooltip>
          )}
          {(!isPhone || alwaysShowAddToSidebar) && canKeepInSidebar && (
            <KeepInSidebarMark
              label="Add to your sidebar"
              className={cn(
                ROW_ACTION,
                "right-[7px]",
                alwaysShowAddToSidebar && "flex phone:right-0 phone:size-11",
              )}
              onMouseEnter={closeHover}
              onKeep={() => onSetStatus?.("mine")}
            />
          )}
        </Popover.Trigger>
      </div>
      <RowCardPopup>
        <SessionCardBody session={session} />
      </RowCardPopup>
      {sheetOpen && (
        <MobileActionSheet
          session={session}
          mine={mine}
          onRename={() => {
            setDraft(session.title);
            setEditing(true);
          }}
          onArchive={onArchive}
          onSetStatus={onSetStatus}
          onClose={() => setSheetOpen(false)}
        />
      )}
      {ctxMenu && (
        <SidebarCtxMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          entries={[
            {
              kind: "item",
              icon: <IconMail size={20} />,
              // Offer the move you can actually make, not both directions.
              label: unread ? "Mark as read" : "Mark as unread",
              onClick: () =>
                unread
                  ? markRead(session.id, session.lastActivity)
                  : markUnread(session.id),
            },
            {
              kind: "item",
              icon: (
                <IconPin size={20} fill={pinned ? "currentColor" : "none"} />
              ),
              label: pinned ? "Unpin" : "Pin",
              onClick: onTogglePin,
            },
            ...(onSetStatus
              ? [
                  // Claim this run into your own lanes (per-user — it
                  // moves only in YOUR sidebar), where it then follows
                  // its live state instead of staying parked in the
                  // Automations band. Your own sessions are already
                  // there, so they don't offer it.
                  ...(!mine || isClaimed(session)
                    ? [
                        {
                          kind: "item",
                          icon: <IconInbox size={20} />,
                          label: isClaimed(session)
                            ? "Stop keeping in sidebar"
                            : "Add to your sidebar",
                          onClick: () =>
                            onSetStatus(isClaimed(session) ? null : "mine"),
                        } as const,
                      ]
                    : []),
                  {
                    kind: "status",
                    current: pinnedLane(session) ?? null,
                    onPick: onSetStatus,
                  } as const,
                ]
              : []),
            {
              kind: "item",
              icon: <IconPencil size={20} />,
              label: "Rename",
              onClick: () => {
                setDraft(session.title);
                setEditing(true);
              },
            },
            ...(!canKeepInSidebar
              ? [
                  { kind: "sep" } as const,
                  {
                    kind: "item",
                    icon: <IconArchive size={20} />,
                    label: "Archive",
                    onClick: onArchive,
                  } as const,
                ]
              : []),
          ]}
        />
      )}
    </Popover.Root>
  );
}

// The bottom sheet raised by long-pressing a session row on touch. It gathers
// the available per-session actions into thumb-sized rows on the shared
// `BottomSheet` — backdrop, grabber, drag-to-dismiss and focus handling come
// from the primitive.
function MobileActionSheet({
  session,
  mine,
  onRename,
  onArchive,
  onSetStatus,
  onClose,
}: {
  session: UnifiedSession;
  /** Your own session — it's already in your lanes, so no claim action. */
  mine: boolean;
  onRename: () => void;
  onArchive: () => void;
  /** Pin the session into a lane (see SidebarItem) — automation rows only. */
  onSetStatus?: (status: LaneChoice | null) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<"actions" | "status">("actions");
  const currentLane = pinnedLane(session) ?? null;
  const displayedLane = currentLane ?? mineStatus(session);
  const canKeepInSidebar = !!onSetStatus && !mine && !isClaimed(session);
  // Lock the page behind the sheet so a scroll drags the list, not the page.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <BottomSheet label={`Actions for ${session.title}`} onClose={onClose}>
      {(dismiss) => {
        if (page === "status" && onSetStatus) {
          return (
            <LanePickerPage
              current={currentLane}
              onBack={() => setPage("actions")}
              onSelect={(status) => {
                onSetStatus(status);
                dismiss();
              }}
            />
          );
        }
        return (
          <SheetBody>
            <SheetTitle>{session.title}</SheetTitle>
            <SheetItem
              onClick={() => {
                onRename();
                dismiss();
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
                <path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />
              </svg>
              Rename
            </SheetItem>
            {/* Claim this run into your own lanes, where it follows its live
					    state — the phone twin of the row's right-click action. */}
            {onSetStatus && (!mine || isClaimed(session)) && (
              <SheetItem
                onClick={() => {
                  onSetStatus(isClaimed(session) ? null : "mine");
                  dismiss();
                }}
              >
                <IconInbox size={22} />
                {isClaimed(session)
                  ? "Stop keeping in sidebar"
                  : "Add to your sidebar"}
              </SheetItem>
            )}
            {onSetStatus && (
              <SheetDrillInItem
                icon={<LaneStatusMark value={displayedLane} />}
                label="Status"
                value={lanePickerLabel(displayedLane)}
                onClick={() => setPage("status")}
              />
            )}
            {!canKeepInSidebar && (
              <>
                <SheetSeparator />
                <SheetItem
                  tone="danger"
                  onClick={() => {
                    onArchive();
                    dismiss();
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  >
                    <rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
                    <path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
                    <path d="M6.5 8.5h3" strokeLinecap="round" />
                  </svg>
                  Archive
                </SheetItem>
              </>
            )}
          </SheetBody>
        );
      }}
    </BottomSheet>
  );
}
