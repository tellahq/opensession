import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlainThread, UnifiedSession } from "../lib/types";
import { fetchPlainThreadById, startPlainTriageApi } from "../lib/api";
import { useIsPhone } from "../hooks/useIsPhone";
import { InlineAlert, LoadingState } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
import { mineStatus } from "../lib/sidebar-lanes";
import { MINE_STATUS_META } from "../lib/sidebar-types";
import { SUPPORT_COLUMN_BAR, SUPPORT_TOP_RAIL } from "../lib/support-classes";
// The transcript's floating pills. This is the same job — chrome that hangs
// over live content the reader is scrolling — so it takes the same shape
// rather than a second one invented here, in its opaque form: a support
// message runs the full width of the column, so glass would show the words
// through the pill.
import {
  FLOATING_PILL,
  FLOATING_PILL_BUTTON,
  FLOATING_PILL_LOADING,
  TRANSCRIPT_PILL_SPINNER,
} from "../lib/session-viewer-classes";
import { PlainStatusBadge } from "./PlainStatusBadge";
import {
  PlainEntryRow,
  PlainReplyBox,
  PlainThreadActions,
  PlainWaitingBanner,
} from "./PlainThreadPanel";
import { cn } from "../ui/cn";
import { IconSparkle } from "./icons";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  flexCol: {
    flexDirection: "column",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  m0: {
    margin: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  shrink0: {
    flexShrink: "0",
  },
  relative: {
    position: "relative",
  },
  minH0: {
    minHeight: "0",
  },
  hFull: {
    height: "100%",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  mt5: {
    marginTop: "calc(4px * 5)",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  textCenter: {
    textAlign: "center",
  },
  size7px: {
    width: "7px",
    height: "7px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  mxAuto: {
    marginInline: "auto",
  },
  wFull: {
    width: "100%",
  },
  maxW760px: {
    maxWidth: "760px",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  pb5: {
    paddingBottom: "calc(4px * 5)",
  },
});

interface Props {
  /** The Plain thread id — the pane's key. */
  threadId: string;
  /** Navigate into a session (the triage button resolves to one over HTTP). */
  onOpenSession: (id: string) => void;
  /** Hide the "Triage this ticket" affordance (e.g. the pane is already
   *  rendered inside the session that would answer it). */
  hideTriage?: boolean;
  /** A session already working this ticket. Shown at the top of the thread in
   *  place of the triage offer: on the Support page the ticket is all you can
   *  see, so without this there is nothing to say the agent has been here, and
   *  no way through to what it did. */
  session?: UnifiedSession | null;
  className?: string;
  /** Put the ticket's identity — subject, status, customer — in a top bar of
   *  the pane's own instead of at the top of the thread. For the Support
   *  inbox, where the pane has that bar to itself. */
  headerInBar?: boolean;
}

/**
 * The pane width at which the ticket's actions fit in the bar beside the
 * subject. Measured on a ticket carrying the widest of them (an assignee, a
 * named priority, two labels): the action row 536px, the status badge 26, the
 * bar's own padding and gaps 48. At this threshold that leaves the subject and
 * the customer under it about 140px, which is short but still reads as a title
 * rather than as an ellipsis; wider panes give it everything they gain. A
 * 1440pt window clears it, the app sidebar and the queue column taking about
 * 600 of whatever is left.
 *
 * It came down 40px when "Open in Plain" stopped being a link floating at the
 * end of the bar and became a button in the action row, which is a smaller
 * control saying the same thing.
 *
 * Narrower than this the actions stay at the top of the thread, where they have
 * a whole row to wrap into.
 */
const ACTIONS_IN_BAR_MIN = 750;

/**
 * The support-ticket Conversation surface: the full thread straight from Plain
 * (no LLM involved) with ticket admin (status/priority/assign/labels/spam), a
 * customer-reply / internal-note box, and the one-click triage affordance.
 * Rendered as a workspace view tab (the Conversation tab of ticket-backed
 * workspaces) and by the legacy session-less /support preview. Polls at 20s —
 * there's no live push for Plain.
 */
export function ConversationPane({
  threadId,
  onOpenSession,
  hideTriage,
  session,
  className,
  headerInBar,
}: Props) {
  const [thread, setThread] = useState<PlainThread | null>(null);
  const isPhone = useIsPhone();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);
  // The pane is much narrower than the window, because the app sidebar and the
  // queue column take most of it, so a viewport query cannot say whether the
  // actions fit in the bar beside the subject. Measure the pane instead. The
  // node is held in state rather than a ref so the effect re-runs once it is
  // attached.
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!paneEl) return;
    setPaneWidth(paneEl.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => {
      setPaneWidth(entry.contentRect.width);
    });
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, [paneEl]);

  // Load on mount / thread change, then poll — the customer can reply while
  // the ticket is being read and there's no live push for Plain.
  const load = useCallback(() => {
    return fetchPlainThreadById(threadId)
      .then((t) => {
        if (!aliveRef.current) return;
        setThread(t);
        setError(null);
      })
      .catch((e) => {
        if (aliveRef.current) setError(e?.message || "Failed to load");
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, [threadId]);
  useEffect(() => {
    setLoading(true);
    setThread(null);
    setError(null);
    load();
    const poll = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, 20000);
    return () => clearInterval(poll);
  }, [load]);
  // The triage automation reuses a live session for this thread when one
  // exists, else boots a fresh run — that takes tens of seconds, so keep the
  // button in a visible in-progress state the whole way.
  async function handleTriage() {
    if (triaging) return;
    setTriaging(true);
    setTriageError(null);
    await (async () => {
      const sessionId = await startPlainTriageApi(threadId);
      if (aliveRef.current) onOpenSession(sessionId);
    })()
      .catch(async (error) => {
        if (aliveRef.current)
          setTriageError(
            errorMessage(error, "Failed to start the triage run."),
          );
      })
      .finally(async () => {
        if (aliveRef.current) setTriaging(false);
      });
  }

  const status = thread?.status;
  const customerName = thread?.customer?.name || "";
  const customerEmail = thread?.customer?.email || "";
  const customerLabel = customerName || customerEmail || "Unknown customer";
  // Not on a phone: there the bar is where the app's own back control floats,
  // so the ticket keeps its header at the top of the thread.
  const headerInTopBar = !!headerInBar && !isPhone;
  const actionsInBar = headerInTopBar && paneWidth >= ACTIONS_IN_BAR_MIN;

  // A ticket with a session on it is being worked; offering to start that
  // work again would be the wrong thing to put in front of the reader, so the
  // two share one slot. Neither depends on the thread having loaded, and the
  // rail is what the thread's top padding clears, so this must not change
  // when the ticket lands.
  const rail = session ? "session" : hideTriage ? null : "triage";
  const sessionState = session
    ? MINE_STATUS_META.find((m) => m.key === mineStatus(session))
    : null;
  // What the pill says. Never the session's own title: a support session is
  // named after the ticket, so the title would repeat the subject sitting in
  // the bar directly above it and the pill would read as a second heading
  // rather than as the way through to the run.
  //
  // It names its destination, except in the two states that are a reason to
  // go there now — a run still working, or one stopped on a question. The
  // rest of the lane vocabulary is about pull requests ("Ready to merge",
  // "Done"), which says nothing on a ticket; that state stays in the dot,
  // where the sidebar keeps it too.
  const sessionLabel =
    sessionState?.key === "needsinput" || sessionState?.key === "inprogress"
      ? sessionState.label
      : "Open session";

  return (
    <div
      ref={setPaneEl}
      className={cn(
        utilityClassName("flex min-h-0 flex-1 flex-col"),
        className,
      )}
    >
      {headerInTopBar && (
        <div className={SUPPORT_COLUMN_BAR}>
          {/* Empty until the thread lands. The bar keeps its height, so
					    nothing below it moves when the words arrive. */}
          {thread && (
            <>
              {/* The state leads the row instead of trailing the subject.
							    Trailing, it landed at a different x on every ticket and
							    read as part of the name; leading, it reads as the
							    ticket's state and the subject gets a fixed left edge to
							    truncate against. */}
              {status && <PlainStatusBadge status={status} />}
              <div
                {...stylex.props(
                  sx.flex,
                  sx.minW0,
                  sx.flex1,
                  sx.flexCol,
                  sx.justifyCenter,
                )}
              >
                {/* The actions beside it can leave this 200px on a
								    laptop, so the full subject stays on hover. */}
                <h2
                  {...stylex.props(
                    sx.m0,
                    sx.truncate,
                    sx.fontSemibold,
                    sx.textFg,
                    typography.itemTitle,
                  )}
                  title={thread.title || undefined}
                >
                  {thread.title || "No subject"}
                </h2>
                {/* The customer sits at the bottom step, under a 14px
								    subject. Who the ticket is from is read once on the way
								    in and then lives in the queue row beside it, so it
								    recedes here rather than competing with the subject. */}
                <div
                  {...stylex.props(
                    sx.flex,
                    sx.minW0,
                    sx.itemsCenter,
                    sx.gap15,
                    typography.meta,
                  )}
                >
                  <span {...stylex.props(sx.truncate, sx.textDim)}>
                    {customerLabel}
                  </span>
                  {customerName && customerEmail && (
                    <>
                      <span {...stylex.props(sx.textFaint)}>·</span>
                      <span {...stylex.props(sx.truncate, sx.textFaint)}>
                        {customerEmail}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {actionsInBar && (
                <PlainThreadActions
                  threadId={threadId}
                  thread={thread}
                  onChanged={load}
                  layout="bar"
                  className={mergeStylexOverrideClassName("", sx.shrink0)}
                />
              )}
            </>
          )}
        </div>
      )}
      <div {...stylex.props(sx.relative, sx.minH0, sx.flex1)}>
        <div {...stylex.props(sx.hFull, sx.overflowYAuto)}>
          <div
            className={cn(
              utilityClassName("mx-auto w-full max-w-[760px] px-5 pb-5"),
              // The rail floats, so the thread owes it the space it sits in:
              // 12px of offset plus a 32px pill, and 4px clear of it.
              rail
                ? utilityClassName("pt-12")
                : // With the identity in the bar, the first block's own top
                  // margin is the whole gap under it.
                  headerInTopBar
                  ? utilityClassName("pt-1")
                  : utilityClassName("pt-6"),
            )}
          >
            {loading && !thread ? (
              <LoadingState>Loading ticket…</LoadingState>
            ) : error && !thread ? (
              <InlineAlert>
                Couldn't load this Plain thread: {error}
              </InlineAlert>
            ) : (
              <>
                {!headerInTopBar && (
                  <>
                    <div
                      {...stylex.props(
                        sx.flex,
                        sx.itemsCenter,
                        sx.gap25,
                        sx.minW0,
                      )}
                    >
                      <span
                        {...stylex.props(
                          sx.truncate,
                          sx.fontSemibold,
                          sx.textFg,
                          typography.itemTitle,
                        )}
                        title={customerEmail}
                      >
                        {customerLabel}
                      </span>
                      {customerName && customerEmail && (
                        <span
                          {...stylex.props(
                            sx.textFaint,
                            sx.truncate,
                            typography.label,
                          )}
                        >
                          {customerEmail}
                        </span>
                      )}
                      {status && <PlainStatusBadge status={status} />}
                    </div>
                    {thread?.title && (
                      <div
                        {...stylex.props(
                          sx.mt2,
                          sx.fontSemibold,
                          sx.textFg,
                          typography.sectionTitle,
                        )}
                      >
                        {thread.title}
                      </div>
                    )}
                  </>
                )}

                {/* Is anyone still owed an answer? Plain leads with this;
							    so should we. */}
                {thread && (
                  <PlainWaitingBanner
                    thread={thread}
                    className={mergeStylexOverrideClassName("", sx.mt3)}
                  />
                )}

                {/* One-click ticket admin, straight from here: status,
							    priority, spam — no need to jump into Plain. Only when the
							    bar could not take it. */}
                {thread && !actionsInBar && (
                  <PlainThreadActions
                    threadId={threadId}
                    thread={thread}
                    onChanged={load}
                    className={mergeStylexOverrideClassName("", sx.mt3)}
                  />
                )}

                <div {...stylex.props(sx.mt5, sx.flex, sx.flexCol, sx.gap3)}>
                  {thread && thread.entries.length === 0 ? (
                    <div
                      {...stylex.props(
                        sx.mt5,
                        sx.textCenter,
                        sx.textFaint,
                        typography.label,
                      )}
                    >
                      No messages in this thread yet.
                    </div>
                  ) : (
                    thread?.entries.map((e) => (
                      <PlainEntryRow
                        key={e.id}
                        entry={e}
                        threadId={threadId}
                        threadTitle={thread?.title}
                      />
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        {rail && (
          <div className={SUPPORT_TOP_RAIL}>
            {rail === "session" && session ? (
              <Tooltip
                label={`Open the session on this ticket${
                  session.title ? ` · ${session.title}` : ""
                }`}
              >
                <button
                  type="button"
                  className={cn(
                    FLOATING_PILL_BUTTON,
                    utilityClassName("pointer-events-auto"),
                  )}
                  onClick={() => onOpenSession(session.id)}
                >
                  <span
                    {...stylex.props(sx.size7px, sx.shrink0, sx.roundedFull)}
                    style={{
                      backgroundColor:
                        sessionState?.dotColor || "var(--text-faint)",
                    }}
                    aria-hidden
                  />
                  <span {...stylex.props(sx.minW0, sx.truncate)}>
                    {sessionLabel}
                  </span>
                </button>
              </Tooltip>
            ) : triaging ? (
              <div className={FLOATING_PILL_LOADING}>
                <span className={TRANSCRIPT_PILL_SPINNER} aria-hidden />
                <span>Starting triage…</span>
              </div>
            ) : (
              <Tooltip label="Investigates, posts an internal note, and can open a PR for review.">
                <button
                  type="button"
                  className={cn(
                    FLOATING_PILL_BUTTON,
                    utilityClassName("pointer-events-auto"),
                  )}
                  onClick={handleTriage}
                >
                  <IconSparkle
                    size={14}
                    className={mergeStylexOverrideClassName("", sx.textDim)}
                    aria-hidden
                  />
                  Triage this ticket
                </button>
              </Tooltip>
            )}
            {triageError && (
              <div
                className={cn(
                  FLOATING_PILL,
                  utilityClassName(
                    "pointer-events-auto min-w-0 font-normal text-red",
                  ),
                )}
                role="alert"
              >
                <span
                  {...stylex.props(sx.minW0, sx.truncate)}
                  title={triageError}
                >
                  {triageError}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Keep the customer reply available while the ticket scrolls. */}
      {thread && (
        <div
          {...stylex.props(
            sx.mxAuto,
            sx.wFull,
            sx.maxW760px,
            sx.shrink0,
            sx.px5,
            sx.pb5,
          )}
        >
          <PlainReplyBox
            key={threadId}
            threadId={threadId}
            customerName={
              thread.customer?.name || thread.customer?.email || null
            }
            onSent={load}
          />
        </div>
      )}
    </div>
  );
}
