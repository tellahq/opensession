import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTranscript } from "../../lib/api/sessions";
import { errorMessage } from "../../lib/error-message";
import { MessageCommentsSession } from "../../lib/message-comments";
import { useSessionRecord } from "../../lib/session-records";
import { threadState } from "../../lib/session-threads";
import {
  fetchModels,
  fetchProviderAccounts,
  type ModelOption,
  type ProviderAccountOption,
} from "../../lib/api";
import type { TranscriptEntry, WSClientMessage } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { Tooltip } from "../../ui/tooltip";
import { IconChevronLeft, IconExpand } from "../icons";
import {
  type ReplyComposerCatalog,
  SessionReplyComposer,
} from "../SessionReplyComposer";
import { TranscriptBlocks } from "../TranscriptBlocks";
import { WorkspaceSummaryBody } from "../WorkspaceSummary";
import { THREAD_DOT } from "./thread-classes";

/** How many of the thread's latest entries the view reads. */
const TAIL = 400;
/** How often a working thread's view re-reads its transcript. */
const POLL_MS = 2_000;

/**
 * A thread opened inside the coordinator's Threads tab: its summary first
 * (the PR with its preview link and merge, the changes, the rest), then its
 * conversation, and a box to keep talking to it. Back returns to the list;
 * the expand button gives it a tab of its own when it needs the room.
 */
export function ThreadPanelView({
  threadId,
  send,
  onBack,
  onOpenTab,
  onOpenThread,
}: {
  threadId: string;
  /** The conversation's socket; messages name the thread they are for. */
  send?: (msg: WSClientMessage) => void;
  onBack: () => void;
  /** Open the thread in a tab of its own, with its full Review. */
  onOpenTab: () => void;
  /** Open another thread here (one this thread started). */
  onOpenThread: (id: string) => void;
}) {
  const thread = useSessionRecord(threadId);
  const catalog = useReplyCatalog(send);
  const state = thread ? threadState(thread) : null;
  const working = state === "working";
  const { entries, error, loading } = useThreadTranscript(threadId, working);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScrollerElement] = useState<HTMLDivElement | null>(null);
  const setScroller = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollerElement(node);
  }, []);
  // Opens on the summary. Once the reader scrolls to the end, new messages
  // keep them there.
  const follow = useRef(false);
  const shouldMaintainEnd = useCallback(() => follow.current, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={<IconChevronLeft size={20} />}
          className="shrink-0 text-dim"
          onClick={onBack}
        >
          Threads
        </Button>
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
          {state && (
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full",
                THREAD_DOT[state],
                working && "motion-safe:animate-pulse",
              )}
            />
          )}
          <span
            className="truncate text-label font-semibold text-fg"
            title={thread?.title}
          >
            {thread?.title || "Thread"}
          </span>
        </span>
        <Tooltip label="Open in a tab">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Open in a tab"
            icon={<IconExpand size={18} />}
            className="shrink-0 text-dim"
            onClick={onOpenTab}
          />
        </Tooltip>
      </div>
      <div
        ref={setScroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {thread && (
          <section aria-label="Thread summary" className="flex flex-col py-2">
            <WorkspaceSummaryBody
              session={thread}
              onOpenPanelTab={onOpenTab}
              onOpenPr={onOpenTab}
              onOpenChecks={onOpenTab}
              onOpenSession={onOpenThread}
              running={!!thread.isRunning}
              send={send}
              close={() => {}}
              hideCollaborators
            />
          </section>
        )}
        <div className="border-t border-divider px-3 py-3">
          {loading ? (
            <LoadingState>Loading thread…</LoadingState>
          ) : error ? (
            <InlineAlert>{error}</InlineAlert>
          ) : entries.length > 0 ? (
            <div className="min-w-0">
              {/* Comments land on this thread. */}
              <MessageCommentsSession value={threadId}>
                <TranscriptBlocks
                  entries={entries}
                  sessionId={threadId}
                  scrollElement={scroller}
                  shouldMaintainEnd={shouldMaintainEnd}
                  live={working}
                />
              </MessageCommentsSession>
            </div>
          ) : (
            <EmptyState>Nothing in this thread yet.</EmptyState>
          )}
        </div>
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

/** What the reply box offers: models and subscriptions, read once per view.
 *  Empty until they load; the composer manages without them. */
function useReplyCatalog(
  send: ((msg: WSClientMessage) => void) | undefined,
): ReplyComposerCatalog {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  useEffect(() => {
    let live = true;
    fetchModels()
      .then((m) => {
        if (!live) return;
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
    fetchProviderAccounts()
      .then((next) => {
        if (live) setAccounts(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return {
    connected: !!send,
    models,
    defaultModel,
    accounts,
    send: send ?? (() => {}),
  };
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
