import React from "react";
import { facepileAvatarStyle, otherViewers } from "../../lib/presence";
import { reviewAskerFor, wsPrRequestsReviewFrom } from "../../lib/review-queue";
import {
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_STATUS_DOT,
  SIDEBAR_SWIPE_ACTION,
  SIDEBAR_SWIPE_ACTION_ARCHIVE,
  SIDEBAR_SWIPE_ACTION_OPEN,
  SIDEBAR_SWIPE_ACTION_STAR,
  SIDEBAR_SWIPE_ACTION_STAR_ON,
  SIDEBAR_SWIPE_ACTION_TRANSITION,
  SIDEBAR_SWIPE_ROW,
  SIDEBAR_WS_ACTION,
  SIDEBAR_WS_ACTIONS,
  SIDEBAR_WS_ACTIONS_HOVER,
  SIDEBAR_WS_FACE,
  SIDEBAR_WS_FACES,
  SIDEBAR_WS_ROW,
  SIDEBAR_WS_TIME,
  SIDEBAR_WS_TIME_HOVER,
} from "../../lib/sidebar-classes";
import {
  isClaimed,
  ownedBy,
  stripPrTitlePrefix,
  workspaceRunNeedingAttention,
} from "../../lib/sidebar-lanes";
import {
  rowOriginSource,
  rowWasAgentStarted,
} from "../../lib/sidebar-placement";
import { SWIPE_REVEAL_PX, type SwipeAction } from "../../lib/sidebar-swipe";
import type { WsRow } from "../../lib/sidebar-types";
import { shouldEmphasizeUnread } from "../../lib/sidebar-unread-session";
import { shortTime } from "../../lib/time";
import type { WsTimePref } from "../../lib/workspace-time";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { RepoTile } from "../RepoTile";
import { ReviewAskerFace } from "../ReviewAskerFace";
import { UserAvatar } from "../UserAvatar";
import { IconArchive, IconMoon, IconPin, IconTrash } from "../icons";
import { AutoCreatedMark } from "./AutoCreatedMark";
import {
  RunTicker,
  SnoozeBadge,
  WsPrStatusMark,
  WsStatusMark,
} from "./HoverCards";
import { KeepInSidebarMark } from "./KeepInSidebarMark";
import { OriginMark } from "./OriginMark";
import { SIDEBAR_ROW, SIDEBAR_ROW_TITLE } from "./SidebarItem";
import { WorkspaceDraftIndicator } from "./WorkspaceDraftIndicator";

export type WorkspaceRowEditing = {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
} | null;

export interface WorkspaceRowSwipe {
  offset: number;
  action: SwipeAction | null;
  dragging: boolean;
  dragSide: SwipeAction | null;
}

interface WorkspaceRowEvents {
  onActivate: React.MouseEventHandler<HTMLButtonElement>;
  onMouseEnter: React.MouseEventHandler<HTMLButtonElement>;
  onMouseLeave: React.MouseEventHandler<HTMLButtonElement>;
  onMouseDown: React.MouseEventHandler<HTMLButtonElement>;
  onTouchStart: React.TouchEventHandler<HTMLButtonElement>;
  onTouchMove: React.TouchEventHandler<HTMLButtonElement>;
  onTouchEnd: React.TouchEventHandler<HTMLButtonElement>;
  onTouchCancel: React.TouchEventHandler<HTMLButtonElement>;
  onContextMenu: React.MouseEventHandler<HTMLButtonElement>;
}

interface WorkspaceRowPresentation {
  inbox: boolean;
  active: boolean;
  isPhone: boolean;
  isDraft: boolean;
  hasSectionHeading: boolean;
  groupsByRepo: boolean;
  repoName: string;
  runStartSeenMs: number | null;
  snoozed: boolean;
  snoozeIso: string | null;
  timePreference: WsTimePref;
  shipsDirectlyToMain: boolean;
  pinned: boolean;
}

interface WorkspaceRowContext {
  editing: WorkspaceRowEditing;
  currentUser: string;
  mePersonKey: string;
  teamViewing: Array<{ user: string; sessionId: string }>;
}

interface WorkspaceRowShortcuts {
  pinShortcutKeys?: string[];
  archiveShortcutKeys?: string[];
}

interface WorkspaceRowActions {
  onCloseSwipe: () => void;
  onTogglePin: () => void;
  onToggleSnooze: () => void;
  onArchive: (current?: HTMLButtonElement | null) => void;
  onDeleteDraft: () => void;
  onConfirmDeleteDraft: (onConfirm: () => void) => void;
  onOpenMention: (sessionId: string) => void;
  onStartWorkspaceRename: () => void;
  onStartSessionRename: () => void;
  onKeepInSidebar: () => void;
}

interface WorkspaceRowProps {
  row: WsRow;
  presentation: WorkspaceRowPresentation;
  context: WorkspaceRowContext;
  swipe: WorkspaceRowSwipe;
  shortcuts: WorkspaceRowShortcuts;
  events: WorkspaceRowEvents;
  actions: WorkspaceRowActions;
}

export function WorkspaceRow({
  row,
  presentation: {
    inbox,
    active,
    isPhone,
    isDraft,
    hasSectionHeading,
    groupsByRepo,
    repoName,
    runStartSeenMs,
    snoozed,
    snoozeIso,
    timePreference,
    shipsDirectlyToMain,
    pinned,
  },
  context: { editing, currentUser, mePersonKey, teamViewing },
  swipe,
  shortcuts: { pinShortcutKeys, archiveShortcutKeys },
  events,
  actions: {
    onCloseSwipe,
    onTogglePin,
    onToggleSnooze,
    onArchive,
    onDeleteDraft,
    onConfirmDeleteDraft,
    onOpenMention,
    onStartWorkspaceRename,
    onStartSessionRename,
    onKeepInSidebar,
  },
}: WorkspaceRowProps) {
  const hasQuestion = row.sessions.some((session) => session.waitingForInput);
  const failed = !hasQuestion && !!workspaceRunNeedingAttention(row.sessions);
  // A manually pinned Needs input lane remains blue, but a failed top-level
  // run gets its own red marker rather than masquerading as a question.
  const waiting = !failed && row.status === "needsinput";
  // A review GitHub is still asking you for. Blocked on you, like an
  // unanswered question, so it wears the same blue mark — and it wears it in
  // every band, not only under Needs review, because the whole point is that
  // you can see you were asked without opening anything.
  const needsMyReview = wsPrRequestsReviewFrom(row, mePersonKey);
  // Who is waiting. Covers the Reviewer picker's request as well as the
  // GitHub one: "somebody is waiting on you" is a poor prompt to act on
  // until you know which somebody.
  const reviewAsker = reviewAskerFor(row, currentUser);
  // The "in progress" ticker start: the earliest running session's start, so a
  // workspace with several live sessions shows how long it's been busy overall.
  // Done/idle sessions don't count — only sessions actually running feed the clock.
  // Prefer the server's runStartedAt (survives refresh); fall back to the
  // first moment we saw this row running. Pruned when the row goes idle.
  let runStartMs: number | null = null;
  if (row.running) {
    const stamps = row.sessions
      .filter((c) => c.isRunning && c.runStartedAt)
      .map((c) => Date.parse(c.runStartedAt!))
      .filter((n) => !Number.isNaN(n));
    if (stamps.length) runStartMs = Math.min(...stamps);
    else runStartMs = runStartSeenMs;
  }
  // The yellow duration is a live status, not a sort key. Stable creation
  // ordering makes that distinction honest without taking the useful timer
  // away from Inbox and Project layouts.
  const showRunDuration = runStartMs !== null;
  const swipeOffset = isPhone ? swipe.offset : 0;
  const swipeAction = isPhone ? swipe.action : null;
  const draggingRow = swipe.dragging;
  // Which underlay to show: the in-flight drag reveals its side via
  // wsDragSide (per-frame offsets live only in the DOM now), an open or
  // committing row falls back to the reconciled wsSwipe state.
  const swipeSide: SwipeAction | null = draggingRow
    ? swipe.dragSide
    : swipeAction === "archive" || swipeOffset < 0
      ? "archive"
      : swipeAction === "star" || swipeOffset > 0
        ? "star"
        : null;
  const claimed = row.sessions.some((session) => isClaimed(session));
  const naturallyInSidebar = row.sessions.some(
    (session) =>
      !session.spawnedBy &&
      !session.automation &&
      ownedBy(session, currentUser),
  );
  const canKeepInSidebar =
    row.sessions.length > 0 && !claimed && !naturallyInSidebar;
  // Active snooze → the row wears a wake countdown instead of the idle time.
  // Scratch workspaces are the one group with no heading over them (they
  // have no project, and they sit above the bands rather than in one), so
  // their rows carry a full status mark instead of the plain dot.
  const noSectionHeading = !hasSectionHeading;

  return (
    <div
      className={SIDEBAR_SWIPE_ROW}
      data-swipe-row=""
      style={
        swipeOffset
          ? ({
              "--swipe-action-w": `${Math.max(
                SWIPE_REVEAL_PX,
                Math.abs(swipeOffset),
              )}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      {isPhone && row.sessions.length > 0 && (
        <button
          className={cn(
            SIDEBAR_SWIPE_ACTION,
            SIDEBAR_SWIPE_ACTION_ARCHIVE,
            swipeSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
            draggingRow ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
          )}
          data-swipe-action="archive"
          onClick={(e) => {
            e.stopPropagation();
            onCloseSwipe();
            onArchive();
          }}
          title="Archive workspace"
        >
          <IconArchive size={22} />
          <span>Archive</span>
        </button>
      )}
      {/* A draft row's left swipe deletes instead: it has no session
            lifecycle yet, and the confirm-on-delete elsewhere (right-click,
            long-press sheet) would defeat the point of a swipe. */}
      {isPhone && isDraft && (
        <button
          className={cn(
            SIDEBAR_SWIPE_ACTION,
            SIDEBAR_SWIPE_ACTION_ARCHIVE,
            swipeSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
            draggingRow ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
          )}
          data-swipe-action="delete"
          onClick={(e) => {
            e.stopPropagation();
            onCloseSwipe();
            onDeleteDraft();
          }}
          title="Delete draft"
        >
          <IconTrash size={22} />
          <span>Delete</span>
        </button>
      )}
      {isPhone && (
        <button
          className={cn(
            SIDEBAR_SWIPE_ACTION,
            pinned ? SIDEBAR_SWIPE_ACTION_STAR_ON : SIDEBAR_SWIPE_ACTION_STAR,
            swipeSide === "star" && SIDEBAR_SWIPE_ACTION_OPEN,
            draggingRow ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
          )}
          data-swipe-action="star"
          onClick={(e) => {
            e.stopPropagation();
            onCloseSwipe();
            onTogglePin();
          }}
          title={pinned ? "Unpin workspace" : "Pin workspace"}
        >
          <IconPin size={22} fill={pinned ? "currentColor" : "none"} />
          <span>{pinned ? "Unpin" : "Pin"}</span>
        </button>
      )}
      <button
        className={cn(
          SIDEBAR_ROW,
          // Inside a swipe row: the wrapper carries the 2px gap and the
          // row carries the slide. The drag writes --swipe-x straight onto
          // the node, so the transform reads it rather than a React style.
          SIDEBAR_WS_ROW,
          // The reserve follows the chips that actually appear. Keep sits
          // rightmost after Archive, adding one chip; an unpinned row without
          // it still reveals only Snooze + Archive.
          pinned && canKeepInSidebar
            ? "hover:pr-[128px]"
            : !pinned && !canKeepInSidebar
              ? "hover:pr-[68px]"
              : null,
          "z-1 mt-0 touch-pan-y transform-[translateX(var(--swipe-x,0))]",
          SIDEBAR_HOVER_LAYER,
          // "Needs you" paints no fill of its own: it is a question
          // waiting, not a failure, and the row's one background slot
          // belongs to selection. The blue mark in the rail and the bold
          // title carry it — same as the native app.
          active && "bg-selected",
          draggingRow
            ? "transition-none"
            : swipeSide
              ? "transition-transform duration-(--dur-micro)"
              : "transition-transform duration-(--dur)",
          (draggingRow || swipeSide) && "will-change-transform",
        )}
        data-sidebar-row=""
        data-ws-row=""
        data-sidebar-item-key={`workspace:${row.key}`}
        data-selected={active || undefined}
        data-waiting={waiting || undefined}
        data-running={row.running || undefined}
        data-unread={row.unread || undefined}
        data-finished-unread={
          shouldEmphasizeUnread(row.unread, row.running) || undefined
        }
        style={
          swipeOffset
            ? ({ "--swipe-x": `${swipeOffset}px` } as React.CSSProperties)
            : undefined
        }
        onClick={events.onActivate}
        onMouseEnter={events.onMouseEnter}
        onMouseLeave={events.onMouseLeave}
        onMouseDown={events.onMouseDown}
        onTouchStart={events.onTouchStart}
        onTouchMove={events.onTouchMove}
        onTouchEnd={events.onTouchEnd}
        onTouchCancel={events.onTouchCancel}
        onContextMenu={events.onContextMenu}
        // The button's label replaces its content for assistive tech, so
        // the blocked state — now carried visually by the row's wash —
        // rides here rather than on a marker element.
        aria-label={
          failed
            ? `${row.name}, last run failed`
            : waiting
              ? `${row.name}, needs your attention`
              : needsMyReview
                ? `${row.name}, needs your review`
                : row.name
        }
      >
        {/* A question or requested review is blue. A stopped run is red, so
            the marker states what happened instead of implying a reply exists. */}
        <span className={SIDEBAR_RAIL}>
          {waiting || needsMyReview ? (
            <span
              className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.waiting}`}
            />
          ) : failed ? (
            <span
              className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.failed}`}
            />
          ) : noSectionHeading ? (
            <WsStatusMark row={row} size={18} />
          ) : row.running ? (
            <span
              className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.running}`}
            />
          ) : (
            <WsPrStatusMark
              sessions={row.sessions}
              size={18}
              workspace={row.workspace}
              shipsDirectlyToMain={shipsDirectlyToMain}
            />
          )}
        </span>
        {/* Inbox rows name their repo with the tile alone, in front of the
            title — the repo/branch meta line it replaces cost a second line
            per row for two words most of the list repeats. */}
        {inbox && !editing && hasSectionHeading && (
          <RepoTile name={repoName} size={14} />
        )}
        {editing ? (
          <input
            className="min-w-0 flex-1 rounded-md border border-[var(--accent,#6b8afd)] bg-bg px-[3px] text-body font-medium text-inherit outline-none desktop:text-item-title"
            value={editing?.value ?? ""}
            autoFocus
            onChange={(e) => editing?.onChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onBlur={() => editing?.onCommit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") editing?.onCommit();
              else if (e.key === "Escape") editing?.onCancel();
              e.stopPropagation();
            }}
          />
        ) : (
          <span
            // Same class as a session row's title, so workspace rows pick up
            // the shared type scale (incl. the phone bump) and the
            // selected/waiting/unread emphasis from the row's data attributes.
            // Unread only gains weight after the aggregate run has finished.
            className={SIDEBAR_ROW_TITLE}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (row.workspace) onStartWorkspaceRename();
              else if (row.sessions[0]) onStartSessionRename();
            }}
          >
            {stripPrTitlePrefix(row.name)}
          </span>
        )}
        {/* Machine origin stays passive beside the title. Keep belongs with
            the row's other actions at the right edge. */}
        {!editing && rowWasAgentStarted(row) && <AutoCreatedMark />}
        {/* Where the work came from, when the whole row came from one place:
            a Slack thread, a Linear issue. Same slot and ink as the mark
            above (SidebarItem carries the session-row half). */}
        {!editing && <OriginMark source={rowOriginSource(row)} />}
        {row.mention &&
          !editing && (
            // Same badge as a session row (SidebarItem): the face of whoever
            // tagged you, with an accent @ so it can't read as a viewer.
            // Clicking it jumps to the member session the mention lives on —
            // the row's own click can open a different sibling, and opening
            // the exact session is what clears the badge (lib/mentions.ts).
            <span
              className="relative ml-1 flex shrink-0 cursor-pointer items-center"
              title={`${row.mention} mentioned you — open`}
              aria-label={`${row.mention} mentioned you — open`}
              onClick={
                row.mentionSessionId
                  ? (e) => {
                      e.stopPropagation();
                      const target = row.mentionSessionId;
                      if (!target) return;
                      onOpenMention(target);
                    }
                  : undefined
              }
            >
              <UserAvatar name={row.mention} size={16} className="shrink-0" />
              <span
                aria-hidden="true"
                className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-accent text-[8px] font-bold leading-none text-on-accent ring-2 ring-panel"
              >
                @
              </span>
            </span>
          )}
        {reviewAsker && !editing && <ReviewAskerFace asker={reviewAsker} />}
        {/* Teammates currently focused on a session in this workspace. */}
        {!editing &&
          (() => {
            const viewers = otherViewers(
              teamViewing
                .filter((v) =>
                  row.sessions.some((session) => session.id === v.sessionId),
                )
                .map((v) => v.user),
              currentUser,
            );
            if (!viewers.length) return null;
            return (
              <span
                className={SIDEBAR_WS_FACES}
                aria-label={`Viewing: ${viewers.join(", ")}`}
              >
                {viewers.slice(0, 3).map((viewer, index, shown) => (
                  <UserAvatar
                    key={viewer}
                    name={viewer}
                    size={16}
                    className={SIDEBAR_WS_FACE}
                    style={facepileAvatarStyle(
                      index,
                      shown.length,
                      "var(--sidebar-face-ring)",
                    )}
                    title={`${viewer} is here`}
                  />
                ))}
              </span>
            );
          })()}
        {/* The yellow timer is live status in every layout. It no longer
            competes with a moving activity sort because Active is creation-stable. */}
        {showRunDuration && runStartMs !== null && (
          <RunTicker startMs={runStartMs} />
        )}
        {snoozeIso &&
          !editing && (
            // A ticker ahead of it has already pushed the cluster right; a
            // second auto margin would split the free space between them.
            <SnoozeBadge
              until={snoozeIso}
              className={showRunDuration ? "ml-1.5" : undefined}
            />
          )}
        {/* The optional last-used preference remains useful context, but it is
            no longer the Active list's sort key. A running row gives this slot
            to its yellow duration instead. */}
        {(inbox || groupsByRepo || !row.workspace) &&
          !snoozeIso &&
          timePreference !== "off" &&
          row.lastActivity && (
            <span
              className={cn(
                SIDEBAR_WS_TIME,
                timePreference === "hover" && SIDEBAR_WS_TIME_HOVER,
                // The "hover" mode (the default) shows the badge only under
                // the pointer. On touch there is no hover, so it shows inline
                // like "always". A running row keeps its duration instead.
                showRunDuration && "hidden",
                timePreference === "hover" &&
                  !showRunDuration &&
                  "[@media(hover:none)]:inline-flex",
              )}
              data-ws-time=""
              aria-label={new Date(row.lastActivity).toLocaleString()}
            >
              {shortTime(row.lastActivity)}
            </span>
          )}
        {/* Slack-style pencil: a session here holds an unsent draft — come back
            and finish it. Yields to the hover actions like the count/time. */}
        <WorkspaceDraftIndicator
          sessionIdsKey={row.sessions.map((session) => session.id).join("\0")}
          pushed={showRunDuration || Boolean(snoozeIso)}
        />
        {/* Hover actions stay in one predictable order: Pin, Snooze, Archive, Keep. */}
        <span
          className={cn(
            SIDEBAR_WS_ACTIONS,
            // A revealed swipe action owns the row's right edge, so the
            // hover cluster stays out of it entirely rather than being
            // hidden again by a more specific rule further down the sheet.
            swipeSide ? "hidden" : SIDEBAR_WS_ACTIONS_HOVER,
          )}
          data-ws-actions=""
        >
          {/* Pin is not one of the row's standing actions: an unpinned row
              offers snooze and archive, the two moves you make constantly,
              and pinning stays in the context menu, the ⌘P chord and the
              swipe. Once a row IS pinned the chip comes back, because
              unpinning has to be reachable from the thing it marks. */}
          {pinned && (
            <Tooltip
              label="Unpin workspace"
              // Only on the row the chord would actually hit: ⌘P pins the
              // workspace holding the OPEN session, so advertising it on
              // every row would promise a key that lands elsewhere.
              shortcut={active ? (pinShortcutKeys ?? undefined) : undefined}
            >
              <span
                role="button"
                tabIndex={0}
                // One colour, picked here rather than stacking two `text-*`
                // utilities, whose winner would be Tailwind's ordering: a
                // pinned action keeps its accent under the pointer.
                className={cn(SIDEBAR_WS_ACTION, "text-accent")}
                aria-label="Unpin workspace"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onTogglePin();
                  }
                }}
              >
                <IconPin size={19} fill="currentColor" />
              </span>
            </Tooltip>
          )}
          {row.sessions.length > 0 ? (
            <>
              <Tooltip
                label={
                  snoozed
                    ? "Unsnooze workspace"
                    : "Snooze workspace until Someday"
                }
              >
                <span
                  role="button"
                  tabIndex={0}
                  className={cn(SIDEBAR_WS_ACTION, "text-faint hover:text-fg")}
                  aria-label={
                    snoozed ? "Unsnooze workspace" : "Snooze workspace"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSnooze();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      onToggleSnooze();
                    }
                  }}
                >
                  <IconMoon size={19} />
                </span>
              </Tooltip>
              <Tooltip
                label="Archive workspace"
                shortcut={
                  active ? (archiveShortcutKeys ?? undefined) : undefined
                }
              >
                <span
                  role="button"
                  tabIndex={0}
                  className={cn(SIDEBAR_WS_ACTION, "text-faint hover:text-fg")}
                  aria-label="Archive workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive(
                      e.currentTarget.closest<HTMLButtonElement>(
                        "button[data-sidebar-row]",
                      ),
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      onArchive(
                        e.currentTarget.closest<HTMLButtonElement>(
                          "button[data-sidebar-row]",
                        ),
                      );
                    }
                  }}
                >
                  <IconArchive size={19} />
                </span>
              </Tooltip>
            </>
          ) : row.workspace?.draft ? (
            <Tooltip label="Delete draft">
              <span
                role="button"
                tabIndex={0}
                className={cn(SIDEBAR_WS_ACTION, "text-faint hover:text-red")}
                aria-label="Delete draft"
                onClick={(e) => {
                  e.stopPropagation();
                  onConfirmDeleteDraft(onDeleteDraft);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onConfirmDeleteDraft(onDeleteDraft);
                  }
                }}
              >
                <IconTrash size={19} />
              </span>
            </Tooltip>
          ) : null}
          {canKeepInSidebar && (
            <KeepInSidebarMark
              className={SIDEBAR_WS_ACTION}
              onKeep={() => onKeepInSidebar()}
            />
          )}
        </span>
      </button>
    </div>
  );
}
