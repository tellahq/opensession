import React, { useEffect, useState } from "react";
import { useIsPhone } from "../hooks/useIsPhone";
import { fetchSupportThreads } from "../lib/api";
import {
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_LANE_COUNT,
  SIDEBAR_LANE_HEADER,
  SIDEBAR_LANE_NAME,
  SIDEBAR_RAIL,
  SIDEBAR_RAIL_GAP,
} from "../lib/sidebar-classes";
import {
  SUPPORT_PRIORITY_DOT,
  SUPPORT_PRIORITY_GROUPS,
} from "../lib/sidebar-filter";
import { SUPPORT_COLUMN_BAR } from "../lib/support-classes";
import {
  filterSupportThreadsByLabel,
  readSupportLabel,
  supportLabelOptions,
  writeSupportLabel,
} from "../lib/support-labels";
import { mineStatus } from "../lib/sidebar-lanes";
import { MINE_STATUS_META } from "../lib/sidebar-types";
import { shortTime } from "../lib/time";
import type { SupportThread, UnifiedSession } from "../lib/types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Menu, MENU_ICON } from "../ui/menu";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { ConversationPane } from "./ConversationPane";
import { IconMail, IconTag } from "./icons";

/**
 * The Plain queue as a place of its own: the tickets in a column beside the
 * sidebar, the one you picked open next to them, and no chat anywhere.
 *
 * It is the second way into the same queue, running beside the Plain band at
 * the bottom of the sidebar rather than replacing it — the two are being tried
 * against each other. The band opens a ticket's workspace, so the answer
 * arrives with a session, a tab strip and a transcript around it; this opens
 * the ticket itself, and a session is something you go to from it — the pane's
 * own "Triage this ticket", or, once a run exists, the pill that replaces it.
 *
 * The list is the sidebar's grammar at a column's width: the same priority
 * lanes, the same 22px rail, the same hover and selected washes, with a second
 * line for the subject because 300px has room for it. The ticket beside it is
 * ConversationPane, the same surface the workspace Conversation tab renders.
 */

/** The column. Paper like the pane it sits in, separated by the chrome seam —
 *  the Reports page's list column, whose doc argues that shape at length. On a
 *  phone the two panes are separate pages, so it is the whole width there. */
const COLUMN =
  "flex min-h-0 flex-col " +
  "phone:w-full phone:flex-1 " +
  "desktop:w-[320px] desktop:shrink-0 desktop:border-r desktop:border-divider";

const COLUMN_TITLE =
  "m-0 text-item-title font-semibold text-fg phone:text-section-title";

const COLUMN_COUNT = "shrink-0 text-meta font-medium tabular-nums text-faint";

const LIST =
  "min-h-0 flex-1 overflow-y-auto px-1.5 pt-2 pb-3 " +
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** A ticket. Two lines, so it sets its own vertical rhythm rather than taking
 *  the sidebar's one-line row padding; everything else — corner, rail gap,
 *  hover layer, `bg-selected` for the open one — is the shared row grammar. */
const ROW =
  "group mt-0.5 flex w-full cursor-pointer items-start rounded-row border-0 " +
  "bg-transparent py-2.5 pr-3 pl-2.5 text-left data-active:bg-selected " +
  `${SIDEBAR_RAIL_GAP} ${SIDEBAR_HOVER_LAYER}`;

const ROW_HEAD = "flex min-w-0 items-baseline gap-2";

const ROW_NAME =
  "min-w-0 flex-1 truncate text-label font-medium text-dim " +
  "group-hover:text-fg group-data-active:text-fg phone:text-[15px]";

const ROW_TIME = "shrink-0 text-right text-meta tabular-nums text-faint";

const ROW_SUBJECT =
  "mt-1 block truncate text-label text-faint " +
  "group-data-active:text-dim phone:text-[14px]";

interface Props {
  /** The open ticket, or null for the list on its own. */
  threadId: string | null;
  /** Live sessions, for the rail dot: a ticket already being worked on wears
   *  its session's status instead of its priority. */
  sessions: UnifiedSession[];
  /** Open a ticket (drives the route, so the pane is deep-linkable). */
  onSelectThread: (threadId: string) => void;
  /** Navigate into a session — what the pane's triage button resolves to. */
  onOpenSession: (id: string) => void;
}

export function SupportInbox({
  threadId,
  sessions,
  onSelectThread,
  onOpenSession,
}: Props) {
  const isPhone = useIsPhone();
  const [threads, setThreads] = useState<SupportThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One Plain label narrowing the queue, like Plain's own Labels list.
  const [label, setLabelState] = useState(readSupportLabel);
  const setLabel = (next: string) => {
    setLabelState(next);
    writeSupportLabel(next);
  };

  // The same gentle cadence the sidebar polls Plain on (the server caches
  // ~60s). A poll that fails while tickets are already on screen keeps them:
  // the list is the queue as of the last good answer, not an error page.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchSupportThreads()
        .then((t) => {
          if (!alive) return;
          setThreads(t);
          setError(null);
        })
        .catch((e) => {
          if (alive) setError(e?.message || "Failed to load the queue");
        });
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Newest live session per thread — the same rule the sidebar's Support rows
  // use to decide what their dot says.
  const sessionByThread = (() => {
    const m = new Map<string, UnifiedSession>();
    for (const s of sessions) {
      if (s.archived || !s.plainThreadId) continue;
      const prev = m.get(s.plainThreadId);
      if (!prev || s.lastActivity > prev.lastActivity)
        m.set(s.plainThreadId, s);
    }
    return m;
  })();

  const labelOptions = threads ? supportLabelOptions(threads) : [];
  // A picked label nobody carries right now stays listed, so it can be
  // seen and cleared rather than silently emptying the queue.
  if (label && !labelOptions.some((o) => o.name === label))
    labelOptions.push({ name: label, count: 0 });
  const shown = threads ? filterSupportThreadsByLabel(threads, label) : null;

  // Phone: list and ticket are separate pages, with a back button between.
  const showList = !isPhone || !threadId;
  const showTicket = !isPhone || !!threadId;

  function renderRow(t: SupportThread) {
    const session = sessionByThread.get(t.id) || null;
    const customer = t.customer.name || t.customer.email || "Unknown";
    const dot =
      (session
        ? MINE_STATUS_META.find((m) => m.key === mineStatus(session))?.dotColor
        : SUPPORT_PRIORITY_DOT[t.priority ?? 2]) || "var(--text-faint)";
    const stamp = t.statusChangedAt || t.createdAt;
    return (
      <button
        key={t.id}
        type="button"
        className={ROW}
        data-active={(threadId === t.id && !isPhone) || undefined}
        onClick={() => onSelectThread(t.id)}
      >
        <span className={SIDEBAR_RAIL}>
          <span
            className="size-[7px] rounded-full"
            style={{ backgroundColor: dot }}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className={ROW_HEAD}>
            <span className={ROW_NAME}>{customer}</span>
            {stamp && (
              <span
                className={ROW_TIME}
                title={new Date(stamp).toLocaleString()}
              >
                {shortTime(stamp)}
              </span>
            )}
          </span>
          <span className={ROW_SUBJECT}>
            {t.title || t.previewText || "No subject"}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {showList && (
        <aside className={COLUMN}>
          <div className={SUPPORT_COLUMN_BAR}>
            <h1 className={COLUMN_TITLE}>Support</h1>
            {shown && <span className={COLUMN_COUNT}>{shown.length}</span>}
            {labelOptions.length > 0 && (
              <Menu.Root>
                <Menu.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn("ml-auto min-w-0", label && "text-accent")}
                      icon={<IconTag size={16} />}
                      iconTone={label ? "full" : "muted"}
                      caret
                    >
                      <span className="max-w-[140px] truncate">
                        {label || "All labels"}
                      </span>
                    </Button>
                  }
                />
                <Menu.Popup
                  align="end"
                  className="max-h-[min(480px,70vh)] min-w-[220px] max-w-[300px]"
                >
                  <Menu.RadioGroup
                    value={label}
                    onValueChange={(value) => setLabel(String(value))}
                  >
                    <Menu.RadioItem value="" closeOnClick>
                      <span className="size-[18px] shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        All labels
                      </span>
                      <Menu.Shortcut>{threads?.length}</Menu.Shortcut>
                      <Menu.Check on={!label} />
                    </Menu.RadioItem>
                    {labelOptions.map((o) => (
                      <Menu.RadioItem key={o.name} value={o.name} closeOnClick>
                        <IconTag size={18} className={MENU_ICON} />
                        <span className="min-w-0 flex-1 truncate">
                          {o.name}
                        </span>
                        <Menu.Shortcut>{o.count}</Menu.Shortcut>
                        <Menu.Check on={label === o.name} />
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Popup>
              </Menu.Root>
            )}
          </div>
          <div className={LIST}>
            {threads === null || shown === null ? (
              <LoadingState>Loading tickets…</LoadingState>
            ) : error && threads.length === 0 ? (
              <InlineAlert className="mt-2">{error}</InlineAlert>
            ) : threads.length === 0 ? (
              <div className="px-3 py-6 text-center text-label text-faint">
                Nothing waiting in Plain.
              </div>
            ) : shown.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-3 py-6 text-center text-label text-faint">
                No tickets labelled {label}.
                <Button variant="ghost" size="sm" onClick={() => setLabel("")}>
                  Show all labels
                </Button>
              </div>
            ) : (
              SUPPORT_PRIORITY_GROUPS.map((group) => {
                const items = shown.filter(
                  (t) => (t.priority ?? 2) === group.p,
                );
                if (items.length === 0) return null;
                return (
                  <div key={group.p}>
                    {/* The sidebar's lane caption, not a heading of its
										    own: same tokens, same colour per priority. */}
                    <div
                      className={cn(
                        SIDEBAR_GROUP_HEADER,
                        SIDEBAR_GROUP_HEADER_INSET,
                        SIDEBAR_LANE_HEADER,
                        "cursor-default hover:text-dim",
                      )}
                    >
                      <span
                        className={cn(
                          SIDEBAR_GROUP_NAME,
                          SIDEBAR_LANE_NAME,
                          group.p <= 1 && group.cls,
                        )}
                      >
                        {group.label}
                      </span>
                      <span className={cn(SIDEBAR_LANE_COUNT, group.cls)}>
                        {items.length}
                      </span>
                    </div>
                    {items.map(renderRow)}
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}

      {showTicket && (
        <section className="flex min-w-0 flex-1 flex-col">
          {/* An open ticket brings its own bar, with its subject and
					    customer in it. This is the one for when nothing is open, and
					    for phones, where the app's floating back control sits here
					    and the ticket keeps its header inline — a second back button
					    would be the same gesture twice. Either way the two columns
					    start on one line. */}
          {(!threadId || isPhone) && <div className={SUPPORT_COLUMN_BAR} />}
          {threadId ? (
            <ConversationPane
              key={threadId}
              threadId={threadId}
              onOpenSession={onOpenSession}
              session={sessionByThread.get(threadId) || null}
              headerInBar
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-8">
              <EmptyState
                icon={<IconMail size={22} />}
                title="No ticket selected"
              >
                Pick a ticket to read the conversation, reply, and set its
                status without leaving this page.
              </EmptyState>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
