import { useIsPhone } from "../../hooks/useIsPhone";
import { useNavigation } from "../../hooks/useNavigation";
import { openThreadTab } from "../../lib/thread-tabs";
import type { UnifiedSession } from "../../lib/types";
import { useSessionRecord } from "../../lib/session-records";
import { threadState, threadStatusLine } from "../../lib/session-threads";
import { cn } from "../../ui/cn";
import {
  MessageActionButtons,
  MessageThreadSummary,
} from "../comments/MessageActions";
import { ListRow } from "../../ui/list-row";
import { THREAD_DOT } from "./thread-classes";

/** A thread the turn started, and the prompt it was started on. */
export interface SpawnedThread {
  /** The tool call's entry id, stable across re-renders. */
  id: string;
  threadId: string;
  prompt: string;
}

/**
 * Delegated work stays reachable below the fold as quiet nested rows.
 * Show one current status, not a second copy of the worker's report.
 */
export function ThreadCards({ threads }: { threads: SpawnedThread[] }) {
  return (
    <div className="mt-0.5 flex flex-col pl-5 pr-1">
      {threads.map((thread) => (
        <ThreadCard key={thread.id} spawned={thread} />
      ))}
    </div>
  );
}

function ThreadCard({ spawned }: { spawned: SpawnedThread }) {
  const thread = useSessionRecord(spawned.threadId);
  const fallbackTitle =
    spawned.prompt.split("\n")[0]?.trim().slice(0, 80) || "Thread";
  const message = {
    entryId: spawned.id,
    author: "Agent",
    text: `Thread: ${thread?.title || fallbackTitle}`,
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="group/card flex items-center gap-1">
        <ThreadCardBody spawned={spawned} fallbackTitle={fallbackTitle} />
        <div className="flex shrink-0 items-center gap-0.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity [@media(hover:hover)]:group-hover/card:opacity-100 [@media(hover:hover)]:group-focus-within/card:opacity-100">
          <MessageActionButtons message={message} className="phone:size-11" />
        </div>
      </div>
      <MessageThreadSummary message={message} />
    </div>
  );
}

function ThreadCardBody({
  spawned,
  fallbackTitle,
}: {
  spawned: SpawnedThread;
  fallbackTitle: string;
}) {
  const navigation = useNavigation();
  const thread = useSessionRecord(spawned.threadId);
  const phone = useIsPhone();
  return (
    <ListRow
      className="items-center py-1 font-sans"
      aria-label={`Open thread: ${thread?.title || fallbackTitle}${thread ? `, ${threadStatusLine(thread)}` : ""}`}
      onClick={() => {
        // A tab of its own beside the conversation on desktop; a phone
        // opens the thread as its own page.
        if (!phone) openThreadTab(spawned.threadId);
        navigation.openSession(spawned.threadId);
      }}
    >
      {thread ? (
        <ThreadCardSummary thread={thread} />
      ) : (
        <>
          <span
            aria-hidden="true"
            className="flex size-5 shrink-0 items-center justify-center phone:self-start"
          >
            <span className="size-1.5 rounded-full bg-line-strong" />
          </span>
          <span className="min-w-0 truncate text-label text-dim">
            {fallbackTitle}
          </span>
        </>
      )}
    </ListRow>
  );
}

export function ThreadCardSummary({ thread }: { thread: UnifiedSession }) {
  const state = threadState(thread);
  const status = threadStatusLine(thread);
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center phone:self-start"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            THREAD_DOT[state],
            state === "working" && "motion-safe:animate-pulse",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2 phone:flex-col phone:items-start phone:gap-0.5">
        <span className="min-w-0 truncate text-label text-dim phone:max-w-full">
          {thread.title}
        </span>
        <span
          className={cn(
            "shrink-0 text-meta",
            state === "blocked" ? "text-blue" : "text-faint",
          )}
        >
          {status}
        </span>
      </span>
    </>
  );
}
