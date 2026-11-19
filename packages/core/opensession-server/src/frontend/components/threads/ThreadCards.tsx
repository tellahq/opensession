import { useIsPhone } from "../../hooks/useIsPhone";
import { useNavigation } from "../../hooks/useNavigation";
import { openThreadTab } from "../../lib/thread-tabs";
import type { UnifiedSession } from "../../lib/types";
import { useSessionRecord } from "../../lib/session-records";
import {
  threadState,
  threadStatusLine,
  type ThreadState,
} from "../../lib/session-threads";
import { cn } from "../../ui/cn";
import {
  MessageActionButtons,
  MessageThreadSummary,
} from "../comments/MessageActions";
import { ListRow } from "../../ui/list-row";
import { IconRobot } from "../icons";
import { THREAD_DOT } from "./thread-classes";
import { useThreadActivity } from "./useThreadActivity";

/** A thread the turn started, and the prompt it was started on. */
export interface SpawnedThread {
  /** The tool call's entry id, stable across re-renders. */
  id: string;
  threadId: string;
  prompt: string;
}

/**
 * The threads a turn started, as cards under the turn: an agent mark, what
 * it was asked to do, and one line on where it stands (its current step
 * while it works). Not a second copy of its report: the turn's reply says
 * what it found.
 */
export function ThreadCards({ threads }: { threads: SpawnedThread[] }) {
  return (
    <div className="mt-1 flex flex-col rounded-xl bg-panel p-1">
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
      <div className="group/card flex items-center gap-0.5">
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
  const working = thread ? threadState(thread) === "working" : false;
  const activity = useThreadActivity(spawned.threadId, working);
  return (
    <ListRow
      className="items-center gap-3 rounded-lg py-1.5 pl-2 font-sans"
      aria-label={`Open thread: ${thread?.title || fallbackTitle}${thread ? `, ${threadStatusLine(thread)}` : ""}`}
      onClick={() => {
        // A tab of its own beside the conversation on desktop; a phone
        // opens the thread as its own page.
        if (!phone) openThreadTab(spawned.threadId);
        navigation.openSession(spawned.threadId);
      }}
    >
      {thread ? (
        <ThreadCardSummary thread={thread} activity={activity} />
      ) : (
        <>
          <AgentMark state={null} />
          <ThreadCardText title={fallbackTitle} status="Thread" />
        </>
      )}
    </ListRow>
  );
}

/** A robot on a round tile, with the thread's state dot on its corner. */
function AgentMark({ state }: { state: ThreadState | null }) {
  return (
    <span
      aria-hidden="true"
      className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-bg text-dim"
    >
      <IconRobot size={16} />
      <span
        className={cn(
          "absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-panel",
          state ? THREAD_DOT[state] : "bg-line-strong",
          state === "working" && "motion-safe:animate-pulse",
        )}
      />
    </span>
  );
}

function ThreadCardText({
  title,
  status,
  activity,
  blocked = false,
}: {
  title: string;
  status: string;
  activity?: string | null;
  blocked?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-label font-medium leading-5 text-fg">
        {title}
      </span>
      <span className="truncate text-meta leading-4 text-faint">
        <span className={cn(blocked && "text-blue")}>{status}</span>
        {activity && (
          <span aria-live="polite" title={activity}>
            {" "}
            · {activity}
          </span>
        )}
      </span>
    </span>
  );
}

export function ThreadCardSummary({
  thread,
  activity,
}: {
  thread: UnifiedSession;
  /** The step a working thread is on now ("Editing checkout.ts"). */
  activity?: string | null;
}) {
  const state = threadState(thread);
  return (
    <>
      <AgentMark state={state} />
      <ThreadCardText
        title={thread.title}
        status={threadStatusLine(thread)}
        activity={state === "working" ? activity : null}
        blocked={state === "blocked"}
      />
    </>
  );
}
