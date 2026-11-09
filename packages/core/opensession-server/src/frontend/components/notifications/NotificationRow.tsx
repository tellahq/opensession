import { useRef, useState, type CSSProperties, type TouchEvent } from "react";
import { relativeTime } from "../../lib/api/request";
import type { NotificationKind } from "../../lib/api/notifications";
import {
  INBOX_KIND_ICON,
  INBOX_ROW,
  INBOX_ROW_ACTIONS,
  INBOX_ROW_CONTEXT,
  INBOX_ROW_ITEM,
  INBOX_ROW_OPEN,
  INBOX_ROW_REASON,
  INBOX_ROW_TIME,
  INBOX_ROW_TITLE,
  INBOX_SWIPE_DONE,
  INBOX_SWIPE_READ,
  INBOX_SWIPE_ROW,
  INBOX_UNREAD_DOT,
} from "../../lib/inbox-classes";
import {
  markNotifications,
  openNotification,
  type NotificationThread,
} from "../../lib/notifications";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import {
  IconAtSign,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconEye,
  IconMail,
  IconMessage,
  IconHeadphones,
  IconPeople,
  IconUndo,
} from "../icons";

const KIND_ICON: Record<
  NotificationKind,
  { icon: React.ReactNode; ink: string }
> = {
  review_requested: { icon: <IconEye />, ink: "text-blue" },
  team_review_requested: { icon: <IconPeople />, ink: "text-dim" },
  review_done: { icon: <IconCheckCircle />, ink: "text-blue" },
  mention: { icon: <IconAtSign />, ink: "text-accent" },
  comment: { icon: <IconMessage />, ink: "text-accent" },
  collaborator: { icon: <IconPeople />, ink: "text-accent" },
  reminder: { icon: <IconClock />, ink: "text-dim" },
  huddle: { icon: <IconHeadphones />, ink: "text-green" },
};

const SWIPE_PX = 88;
const SWIPE_THRESHOLD = 40;
const SWIPE_AXIS_LOCK = 8;

interface SwipeStyle extends CSSProperties {
  "--swipe-read-w"?: string;
  "--swipe-done-w"?: string;
  "--swipe-x"?: string;
}

/** Follow the finger, with light resistance past the revealed action. */
function swipeOffset(dx: number): number {
  const sign = Math.sign(dx);
  const abs = Math.abs(dx);
  if (abs <= SWIPE_PX) return dx;
  return sign * Math.min(SWIPE_PX + 24, SWIPE_PX + (abs - SWIPE_PX) * 0.18);
}

export function NotificationRow({
  thread,
  onOpen,
}: {
  thread: NotificationThread;
  /** Runs before the row routes, e.g. to close the popover it sits in. */
  onOpen?: () => void;
}) {
  const { icon, ink } = KIND_ICON[thread.kind];
  const readLabel = thread.unread ? "Mark as read" : "Mark as unread";
  const toggleRead = () =>
    markNotifications([thread.id], { unread: !thread.unread });
  const toggleDone = () =>
    markNotifications([thread.id], { done: !thread.done });
  const reason = [thread.reason, thread.body].filter(Boolean).join(": ");
  const context = thread.subject.context;

  // Phone swipe: right reveals read/unread, left reveals done. A full swipe
  // does it; a partial one leaves the action standing, to tap.
  const [open, setOpen] = useState(0);
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const swiping = useRef(false);
  const offsetRef = useRef(0);
  const rowRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  function paint(offset: number) {
    rowRef.current?.style.setProperty("--swipe-x", `${offset}px`);
    frameRef.current?.style.setProperty(
      "--swipe-read-w",
      `${Math.max(0, offset)}px`,
    );
    frameRef.current?.style.setProperty(
      "--swipe-done-w",
      `${Math.max(0, -offset)}px`,
    );
  }
  function settle(offset: number) {
    offsetRef.current = offset;
    setOpen(offset);
    paint(offset);
  }
  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    swiping.current = false;
    origin.current = { x: touch.clientX - open, y: touch.clientY };
  }
  function onTouchMove(e: TouchEvent) {
    const start = origin.current;
    if (!start || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!swiping.current) {
      if (Math.abs(dx) <= SWIPE_AXIS_LOCK || Math.abs(dx) <= Math.abs(dy))
        return;
      swiping.current = true;
      setDragging(true);
    }
    const offset = swipeOffset(dx);
    offsetRef.current = offset;
    paint(offset);
  }
  function onTouchEnd(e: TouchEvent) {
    const wasSwiping = swiping.current;
    origin.current = null;
    swiping.current = false;
    setDragging(false);
    if (!wasSwiping) return;
    e.preventDefault();
    const offset = offsetRef.current;
    const width = rowRef.current?.clientWidth ?? 390;
    if (Math.abs(offset) > Math.min(width * 0.45, SWIPE_PX + 16)) {
      settle(0);
      if (offset > 0) toggleRead();
      else toggleDone();
      return;
    }
    settle(
      Math.abs(offset) > SWIPE_THRESHOLD ? Math.sign(offset) * SWIPE_PX : 0,
    );
  }

  const rowStyle: SwipeStyle = { "--swipe-x": `${open}px` };
  const frameStyle: SwipeStyle = {
    "--swipe-read-w": `${Math.max(0, open)}px`,
    "--swipe-done-w": `${Math.max(0, -open)}px`,
  };

  return (
    <li className={INBOX_ROW_ITEM}>
      <div ref={frameRef} className={INBOX_SWIPE_ROW} style={frameStyle}>
        <button
          type="button"
          className={INBOX_SWIPE_READ}
          data-open={dragging || open > 0 ? "" : undefined}
          tabIndex={-1}
          onClick={() => {
            settle(0);
            toggleRead();
          }}
        >
          <IconMail size={20} />
          <span>{thread.unread ? "Read" : "Unread"}</span>
        </button>
        <button
          type="button"
          className={INBOX_SWIPE_DONE}
          data-open={dragging || open < 0 ? "" : undefined}
          tabIndex={-1}
          onClick={() => {
            settle(0);
            toggleDone();
          }}
        >
          {thread.done ? <IconUndo size={20} /> : <IconCheck size={20} />}
          <span>{thread.done ? "Inbox" : "Done"}</span>
        </button>
        <div
          ref={rowRef}
          className={cn(
            INBOX_ROW,
            // A hook for INBOX_ROW_ITEM's separator rules.
            "inbox-row",
            dragging && "phone:transition-none phone:will-change-transform",
          )}
          data-unread={thread.unread || undefined}
          style={rowStyle}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => {
            origin.current = null;
            swiping.current = false;
            setDragging(false);
            settle(0);
          }}
        >
          <span className={cn(INBOX_KIND_ICON, ink)} aria-hidden="true">
            {icon}
          </span>
          <button
            type="button"
            className={INBOX_ROW_OPEN}
            onClick={() => {
              if (open) {
                settle(0);
                return;
              }
              onOpen?.();
              openNotification(thread);
            }}
            aria-label={`${thread.unread ? "Unread. " : ""}${thread.subject.title}. ${reason}`}
          >
            <span className={INBOX_ROW_CONTEXT}>
              {context && <span className="min-w-0 truncate">{context}</span>}
              <span className={INBOX_ROW_TIME}>
                {relativeTime(new Date(thread.updatedAt).toISOString())}
                {thread.unread && (
                  <span className={INBOX_UNREAD_DOT} aria-hidden="true" />
                )}
              </span>
            </span>
            <span className={INBOX_ROW_TITLE}>
              {thread.subject.title || "Untitled"}
            </span>
            {reason && <span className={INBOX_ROW_REASON}>{reason}</span>}
          </button>
          <div className={INBOX_ROW_ACTIONS}>
            <Tooltip label={readLabel} side="top">
              <Button
                size="sm"
                variant="ghost"
                aria-label={readLabel}
                onClick={toggleRead}
              >
                <IconMail size={18} />
              </Button>
            </Tooltip>
            <Tooltip label={thread.done ? "Move to inbox" : "Done"} side="top">
              <Button
                size="sm"
                variant="ghost"
                aria-label={thread.done ? "Move to inbox" : "Done"}
                onClick={toggleDone}
              >
                {thread.done ? <IconUndo size={18} /> : <IconCheck size={18} />}
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </li>
  );
}
