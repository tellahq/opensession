import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import { mineStatus } from "../lib/sidebar-lanes";
import { MINE_STATUS_META } from "../lib/sidebar-types";
import { shortTime } from "../lib/time";
import type { SupportThread, UnifiedSession } from "../lib/types";
import { cn } from "../ui/cn";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { ConversationPane } from "./ConversationPane";
import { IconMail } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  size7px: {
    width: "7px",
    height: "7px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  flex: {
    display: "flex",
  },
  minH0: {
    minHeight: "0",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py6: {
    paddingBlock: "calc(4px * 6)",
  },
  textCenter: {
    textAlign: "center",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  flexCol: {
    flexDirection: "column",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  p8: {
    padding: "calc(4px * 8)",
  },
});

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
  utilityClassName("flex min-h-0 flex-col ") +
  utilityClassName("phone:w-full phone:flex-1 ") +
  utilityClassName(
    "desktop:w-[320px] desktop:shrink-0 desktop:border-r desktop:border-divider",
  );

const COLUMN_TITLE = utilityClassName(
  "m-0 text-item-title font-semibold text-fg phone:text-section-title",
);

const COLUMN_COUNT = utilityClassName(
  "ml-auto shrink-0 text-meta font-medium tabular-nums text-faint",
);

const LIST =
  utilityClassName("min-h-0 flex-1 overflow-y-auto px-1.5 pt-2 pb-3 ") +
  utilityClassName("[scrollbar-width:none] [&::-webkit-scrollbar]:hidden");

/** A ticket. Two lines, so it sets its own vertical rhythm rather than taking
 *  the sidebar's one-line row padding; everything else — corner, rail gap,
 *  hover layer, `bg-selected` for the open one — is the shared row grammar. */
const ROW =
  utilityClassName(
    "group mt-0.5 flex w-full cursor-pointer items-start rounded-row border-0 ",
  ) +
  utilityClassName(
    "bg-transparent py-2.5 pr-3 pl-2.5 text-left data-active:bg-selected ",
  ) +
  `${SIDEBAR_RAIL_GAP} ${SIDEBAR_HOVER_LAYER}`;

const ROW_HEAD = utilityClassName("flex min-w-0 items-baseline gap-2");

const ROW_NAME =
  utilityClassName("min-w-0 flex-1 truncate text-label font-medium text-dim ") +
  utilityClassName(
    "group-hover:text-fg group-data-active:text-fg phone:text-[15px]",
  );

const ROW_TIME = utilityClassName(
  "shrink-0 text-right text-meta tabular-nums text-faint",
);

const ROW_SUBJECT =
  utilityClassName("mt-1 block truncate text-label text-faint ") +
  utilityClassName("group-data-active:text-dim phone:text-[14px]");

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
            {...stylex.props(sx.size7px, sx.roundedFull)}
            style={{ backgroundColor: dot }}
          />
        </span>
        <span {...stylex.props(sx.minW0, sx.flex1)}>
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
    <div {...stylex.props(sx.flex, sx.minH0, sx.flex1)}>
      {showList && (
        <aside className={COLUMN}>
          <div className={SUPPORT_COLUMN_BAR}>
            <h1 className={COLUMN_TITLE}>Support</h1>
            {threads && <span className={COLUMN_COUNT}>{threads.length}</span>}
          </div>
          <div className={LIST}>
            {threads === null ? (
              <LoadingState>Loading tickets…</LoadingState>
            ) : error && threads.length === 0 ? (
              <InlineAlert className={mergeStylexOverrideClassName("", sx.mt2)}>
                {error}
              </InlineAlert>
            ) : threads.length === 0 ? (
              <div
                {...stylex.props(
                  sx.px3,
                  sx.py6,
                  sx.textCenter,
                  sx.textFaint,
                  typography.label,
                )}
              >
                Nothing waiting in Plain.
              </div>
            ) : (
              SUPPORT_PRIORITY_GROUPS.map((group) => {
                const items = threads.filter(
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
                        utilityClassName("cursor-default hover:text-dim"),
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
        <section {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.flexCol)}>
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
            <div
              {...stylex.props(
                sx.flex,
                sx.minH0,
                sx.flex1,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.p8,
              )}
            >
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
