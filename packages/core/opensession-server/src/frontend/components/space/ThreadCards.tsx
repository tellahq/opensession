import { useNavigation } from "../../hooks/useNavigation";
import { useSessionRecord } from "../../lib/session-records";
import {
  THREAD_STATE_LABEL,
  threadState,
  threadStatusLine,
} from "../../lib/space-threads";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { THREAD_DOT } from "./space-classes";
import { useThreadGist } from "./ThreadRow";

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
  const navigation = useNavigation();
  const thread = useSessionRecord(spawned.threadId);
  const fallbackTitle =
    spawned.prompt.split("\n")[0]?.trim().slice(0, 80) || "Thread";
  return (
    <ListRow
      variant="card"
      onClick={() => navigation.openSession(spawned.threadId)}
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
      </span>
    </>
  );
}
