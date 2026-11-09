import { useIsPhone } from "../../hooks/useIsPhone";
import { useNavigation } from "../../hooks/useNavigation";
import { useMessageCommentsSession } from "../../lib/message-comments";
import { openThreadPane, useThreadPaneLevel } from "../../lib/thread-view";
import { useSessionRecord } from "../../lib/session-records";
import {
  THREAD_STATE_LABEL,
  threadState,
  threadStatusLine,
} from "../../lib/session-threads";
import { cn } from "../../ui/cn";
import {
  MessageActionButtons,
  MessageThreadSummary,
} from "../comments/MessageActions";
import { ListRow } from "../../ui/list-row";
import { THREAD_DOT } from "./thread-classes";
import { useThreadGist } from "./ThreadRow";
import { useThreadActivity } from "./useThreadActivity";

/** A thread the turn started, and the prompt it was started on. */
export interface SpawnedThread {
  /** The tool call's entry id, stable across re-renders. */
  id: string;
  threadId: string;
  prompt: string;
}

/**
 * The threads a turn started, as live cards under the turn: where each one
 * stands now, updated in place as it works, ships, or stops on a question.
 * Like a suggested task, the card is addressed to the reader, so it stays
 * when the turn's steps fold away.
 */
export function ThreadCards({ threads }: { threads: SpawnedThread[] }) {
  return (
    <div className="mt-1 flex flex-col gap-1.5 pl-[7px] pr-1">
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
      <div className="group/card flex items-start gap-1">
        <ThreadCardBody spawned={spawned} fallbackTitle={fallbackTitle} />
        <div className="flex shrink-0 flex-col gap-0.5 pt-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity [@media(hover:hover)]:group-hover/card:opacity-100 [@media(hover:hover)]:group-focus-within/card:opacity-100">
          <MessageActionButtons message={message} />
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
  // The conversation the card is in: its Threads tab opens the thread.
  const hostId = useMessageCommentsSession();
  // Inside a thread already open beside the conversation: one level deeper.
  const level = useThreadPaneLevel();
  const phone = useIsPhone();
  return (
    <ListRow
      variant="card"
      onClick={() => {
        // Beside the conversation on desktop; a phone has no room for two,
        // and a conversation with no panel on screen opens the thread itself.
        const opened = level
          ? openThreadPane(level.rootId, spawned.threadId, level.threadId)
          : !!hostId && !phone && openThreadPane(hostId, spawned.threadId);
        if (!opened) navigation.openSession(spawned.threadId);
      }}
    >
      {thread ? (
        <LiveThread thread={thread} />
      ) : (
        <>
          <span
            aria-hidden="true"
            className="mt-[7px] size-2 shrink-0 rounded-full bg-line-strong"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-label font-medium text-fg">
              {fallbackTitle}
            </span>
            <span className="text-meta text-dim">Thread</span>
          </span>
        </>
      )}
    </ListRow>
  );
}

function LiveThread({
  thread,
}: {
  thread: NonNullable<ReturnType<typeof useSessionRecord>>;
}) {
  const state = threadState(thread);
  const gist = useThreadGist(thread, state);
  const line = threadStatusLine(thread);
  const activity = useThreadActivity(thread.id, state === "working");
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "mt-[7px] size-2 shrink-0 rounded-full",
          THREAD_DOT[state],
          state === "working" && "motion-safe:animate-pulse",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label font-medium text-fg">
          {thread.title}
        </span>
        <span className="line-clamp-2 text-meta text-dim">
          <span className="font-medium">{THREAD_STATE_LABEL[state]}</span>
          {line !== THREAD_STATE_LABEL[state] && ` · ${line}`}
          {gist && <span className="text-faint"> · {gist}</span>}
        </span>
        {activity && (
          <span
            className="truncate text-meta text-faint"
            aria-live="polite"
            title={activity}
          >
            {activity}
          </span>
        )}
      </span>
    </>
  );
}
