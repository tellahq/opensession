import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ReplyComposerCatalog,
  SessionReplyComposer,
} from "../SessionReplyComposer";
import { fetchTranscript } from "../../lib/api/sessions";
import { errorMessage } from "../../lib/error-message";
import { PANEL_BODY } from "../../lib/session-panel-classes";
import { useSessionRecord } from "../../lib/session-records";
import {
  THREAD_STATE_LABEL,
  threadState,
  threadStatusLine,
} from "../../lib/session-threads";
import type { TranscriptEntry } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { MessageCommentsSession } from "../../lib/message-comments";
import { ThreadPaneLevelProvider } from "../../lib/thread-view";
import { Tooltip } from "../../ui/tooltip";
import { IconChevronLeft, IconExpand, IconX } from "../icons";
import { TranscriptBlocks } from "../TranscriptBlocks";
import { THREAD_DOT } from "./thread-classes";

/** How many of the thread's latest entries the pane reads. */
const TAIL = 400;
/** How often a working thread's pane re-reads its transcript. */
const POLL_MS = 2_000;

/**
 * A thread opened beside the conversation that started it: where it stands, its
 * conversation, and a box to keep iterating with its agent, without leaving
 * it. A thread it starts in turn opens on top of it, one level deeper; the
 * header leads back through each level, and Close ends the split. Full screen opens the thread by
 * itself when it needs more room (its review, its browser, its terminal).
 */
export function ThreadPane({
  rootId,
  threadId,
  trail,
  onBack,
  onOpenSession,
  catalog,
}: {
  /** The conversation the split sits beside. */
  rootId: string;
  threadId: string;
  /** The open threads above this one, outermost first. */
  trail: readonly string[];
  /** Keep the first `depth` levels open; 0 closes the thread. */
  onBack: (depth: number) => void;
  onOpenSession?: (id: string) => void;
  catalog: ReplyComposerCatalog;
}) {
  const thread = useSessionRecord(threadId);
  const state = thread ? threadState(thread) : null;
  const working = state === "working";
  const { entries, error, loading } = useThreadTranscript(threadId, working);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [body, setBodyElement] = useState<HTMLDivElement | null>(null);
  const setBody = useCallback((node: HTMLDivElement | null) => {
    bodyRef.current = node;
    setBodyElement(node);
  }, []);
  const follow = useRef(true);
  const shouldMaintainEnd = useCallback(() => follow.current, []);
  // Keep a reader who is at the bottom pinned to the live edge.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-divider px-3 pt-2.5 pb-2.5">
        <div className="flex min-w-0 items-center gap-0.5">
          {trail.length > 0 ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon={<IconChevronLeft size={20} />}
                aria-label="Back"
                className="-ml-1.5 shrink-0"
                onClick={() => onBack(trail.length)}
              />
              <nav
                aria-label="Open threads"
                className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-meta text-faint"
              >
                {trail.map((id, depth) => (
                  <ThreadCrumb
                    key={id}
                    threadId={id}
                    onClick={() => onBack(depth + 1)}
                  />
                ))}
              </nav>
            </>
          ) : (
            <span className="px-0.5 text-meta text-faint">Thread</span>
          )}
          <span className="flex-1" />
          {onOpenSession && (
            <Tooltip label="Open full screen">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Open full screen"
                icon={<IconExpand size={18} />}
                className="shrink-0"
                onClick={() => onOpenSession(threadId)}
              />
            </Tooltip>
          )}
          <Tooltip label="Close thread">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Close thread"
              icon={<IconX size={18} />}
              className="-mr-1.5 shrink-0"
              onClick={() => onBack(0)}
            />
          </Tooltip>
        </div>
        <div className="flex min-w-0 items-start gap-2 px-0.5">
          {state && (
            <span
              aria-hidden="true"
              className={cn(
                "mt-[7px] size-2 shrink-0 rounded-full",
                THREAD_DOT[state],
                working && "motion-safe:animate-pulse",
              )}
            />
          )}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="line-clamp-2 text-label font-semibold text-fg">
              {thread?.title || "Thread"}
            </span>
            {thread && state && (
              <span className="truncate text-meta text-dim">
                {THREAD_STATE_LABEL[state]}
                {threadStatusLine(thread) !== THREAD_STATE_LABEL[state] &&
                  ` · ${threadStatusLine(thread)}`}
              </span>
            )}
          </span>
        </div>
      </div>
      <div
        ref={setBody}
        className={`${PANEL_BODY} px-3 py-3`}
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {loading ? (
          <LoadingState>Loading thread…</LoadingState>
        ) : error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : entries.length > 0 ? (
          <div className="min-w-0">
            {/* Comments land on this thread, and its own thread cards open
                one level deeper in this panel. */}
            <MessageCommentsSession value={threadId}>
              <ThreadPaneLevelProvider value={{ rootId, threadId }}>
                <TranscriptBlocks
                  entries={entries}
                  sessionId={threadId}
                  scrollElement={body}
                  shouldMaintainEnd={shouldMaintainEnd}
                  live={working}
                />
              </ThreadPaneLevelProvider>
            </MessageCommentsSession>
          </div>
        ) : (
          <EmptyState>Nothing in this thread yet.</EmptyState>
        )}
      </div>
      {thread && (
        <div className="shrink-0 px-3 pt-1 pb-3">
          <SessionReplyComposer
            target={thread}
            catalog={catalog}
            placeholder="Message this thread"
          />
        </div>
      )}
    </div>
  );
}

function Crumb({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title={label}
        className="min-w-0 max-w-[12rem] shrink px-1 font-normal text-dim"
        onClick={onClick}
      >
        <span className="truncate">{label}</span>
      </Button>
      <span aria-hidden="true" className="shrink-0">
        ›
      </span>
    </>
  );
}

function ThreadCrumb({
  threadId,
  onClick,
}: {
  threadId: string;
  onClick: () => void;
}) {
  const thread = useSessionRecord(threadId);
  return <Crumb label={thread?.title || "Thread"} onClick={onClick} />;
}

/** The thread's latest entries, re-read while it works. */
function useThreadTranscript(threadId: string, working: boolean) {
  const [state, setState] = useState<{
    id: string;
    entries: TranscriptEntry[];
    error: string | null;
  }>();
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const read = () => {
      void fetchTranscript(threadId, TAIL)
        .then((entries) => {
          if (live) setState({ id: threadId, entries, error: null });
        })
        .catch((error) => {
          if (live)
            setState((prev) => ({
              id: threadId,
              entries: prev?.id === threadId ? prev.entries : [],
              error: errorMessage(error, "Couldn't load the thread"),
            }));
        })
        .finally(() => {
          if (live && working) timer = window.setTimeout(read, POLL_MS);
        });
    };
    read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [threadId, working]);
  const current = state?.id === threadId ? state : null;
  return {
    entries: current?.entries ?? [],
    error: current?.error ?? null,
    loading: !current,
  };
}
