import { useIsPhone } from "../../hooks/useIsPhone";
import { useNavigation } from "../../hooks/useNavigation";
import { openThreadTab } from "../../lib/thread-tabs";
import type { UnifiedSession } from "../../lib/types";
import {
  useGoalSessionRecord,
  useSessionRecord,
} from "../../lib/session-records";
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
import { IconRobot, IconTarget } from "../icons";
import { THREAD_DOT } from "./thread-classes";
import { useThreadActivity } from "./useThreadActivity";

/** A thread the turn started, and the prompt it was started on. */
export interface SpawnedThread {
  /** The tool call's entry id, stable across re-renders. */
  id: string;
  /** Null for a goal, whose session is found by `goalId`. */
  threadId: string | null;
  /** A goal the turn started: its session only exists from its first
   *  wake. */
  goalId?: string;
  /** What it was asked to do, or a goal's name. */
  prompt: string;
}

/** The session a card stands for: the thread itself, or the one a goal
 *  drives once it has woken. */
function useCardSession(spawned: SpawnedThread) {
  const goalSession = useGoalSessionRecord(spawned.goalId ?? null);
  const thread = useSessionRecord(spawned.threadId);
  return spawned.goalId ? goalSession : thread;
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
  const thread = useCardSession(spawned);
  const fallbackTitle =
    spawned.prompt.split("\n")[0]?.trim().slice(0, 80) ||
    (spawned.goalId ? "Goal" : "Thread");
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
  const thread = useCardSession(spawned);
  const phone = useIsPhone();
  const working = thread ? threadState(thread) === "working" : false;
  const activity = useThreadActivity(thread?.id ?? "", working);
  const goal = !!spawned.goalId;
  return (
    <ListRow
      className="items-center gap-3 rounded-lg py-1.5 pl-2 font-sans"
      aria-label={`Open ${goal ? "goal" : "thread"}: ${thread?.title || fallbackTitle}${thread ? `, ${cardStatus(thread)}` : ""}`}
      // A goal's session only exists from its first wake.
      disabled={!thread && goal}
      onClick={() => {
        const id = thread?.id ?? spawned.threadId;
        if (!id) return;
        // A tab of its own beside the conversation on desktop; a phone
        // opens the thread as its own page.
        if (!phone) openThreadTab(id);
        navigation.openSession(id);
      }}
    >
      {thread ? (
        <ThreadCardSummary thread={thread} activity={activity} />
      ) : (
        <>
          <AgentMark state={null} goal={goal} />
          <ThreadCardText
            title={fallbackTitle}
            status={goal ? "Goal, starting" : "Thread"}
          />
        </>
      )}
    </ListRow>
  );
}

/** A robot (a target for a goal) on a round tile, with the thread's state
 *  dot on its corner. */
function AgentMark({
  state,
  goal = false,
}: {
  state: ThreadState | null;
  goal?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-bg text-dim"
    >
      {goal ? <IconTarget size={20} /> : <IconRobot size={20} />}
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
      <AgentMark state={state} goal={!!thread.goalId} />
      <ThreadCardText
        title={thread.title}
        status={cardStatus(thread)}
        activity={state === "working" ? activity : null}
        blocked={state === "blocked"}
      />
    </>
  );
}

/** A goal between rounds is waiting for its next wake, not idle. */
function cardStatus(thread: UnifiedSession): string {
  if (thread.goalId && threadState(thread) === "idle")
    return "Goal, between rounds";
  return threadStatusLine(thread);
}
