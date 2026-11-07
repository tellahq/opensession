import { useCallback, useEffect, useRef, useState } from "react";
import { deliverSessionPrompt, fetchTranscript } from "../../lib/api/sessions";
import { errorMessage } from "../../lib/error-message";
import { PANEL_BODY } from "../../lib/session-panel-classes";
import { useSessionRecord } from "../../lib/session-records";
import { isSendCombo } from "../../lib/send-key";
import {
  THREAD_STATE_LABEL,
  threadState,
  threadStatusLine,
} from "../../lib/space-threads";
import type { TranscriptEntry } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Textarea } from "../../ui/input";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconArrowUpRight, IconChevronLeft } from "../icons";
import { TranscriptBlocks } from "../TranscriptBlocks";
import { getCurrentUser } from "../UserPicker";
import { THREAD_DOT } from "./space-classes";

/** How many of the thread's latest entries the pane reads. */
const TAIL = 400;
/** How often a working thread's pane re-reads its transcript. */
const POLL_MS = 2_000;

/**
 * A thread opened beside its space's conversation: where it stands, its
 * conversation, and a box to keep iterating with its agent, without leaving
 * the space. "Open" takes the whole window when the thread needs more room
 * (its review, its browser, its terminal).
 */
export function ThreadPane({
  threadId,
  onBack,
  onOpenSession,
}: {
  threadId: string;
  onBack: () => void;
  onOpenSession?: (id: string) => void;
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
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon={<IconChevronLeft size={20} />}
            className="-ml-1.5 phone:min-h-11"
            onClick={onBack}
          >
            Space
          </Button>
          <span className="flex-1" />
          {onOpenSession && (
            <Button
              size="sm"
              variant="ghost"
              trailing={<IconArrowUpRight size={16} />}
              className="phone:min-h-11"
              onClick={() => onOpenSession(threadId)}
            >
              Open
            </Button>
          )}
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
            <TranscriptBlocks
              entries={entries}
              sessionId={threadId}
              scrollElement={body}
              shouldMaintainEnd={shouldMaintainEnd}
              live={working}
            />
          </div>
        ) : (
          <EmptyState>Nothing in this thread yet.</EmptyState>
        )}
      </div>
      <ThreadReply threadId={threadId} />
    </div>
  );
}

function ThreadReply({ threadId }: { threadId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  function send() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    void deliverSessionPrompt(threadId, {
      content,
      user: getCurrentUser(),
      clientId: crypto.randomUUID(),
    })
      .then(() => setText(""))
      .catch((error) =>
        toast(errorMessage(error, "Couldn't send to the thread"), {
          variant: "error",
        }),
      )
      .finally(() => setSending(false));
  }
  return (
    <div className="flex shrink-0 items-end gap-2 border-t border-divider p-2.5">
      <Textarea
        value={text}
        aria-label="Message this thread"
        placeholder="Message this thread"
        className="max-h-40 min-h-10 flex-1 phone:text-input-phone"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (isSendCombo(event, "enter")) {
            event.preventDefault();
            send();
          }
        }}
      />
      <Button
        variant="primary"
        disabled={!text.trim() || sending}
        onClick={send}
        className="phone:min-h-11"
      >
        Send
      </Button>
    </div>
  );
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
