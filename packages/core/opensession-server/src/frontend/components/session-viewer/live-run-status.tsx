import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { RunActivity } from "@tellahq/opensession-protocol/events";
import {
  activityInterruptsStream,
  busyActivityStatus,
} from "../../lib/busy-activity";
import type { LiveTurnStore } from "../../lib/live-turn-store";

/** What a transcript row needs to stand in for the turn-level status row. */
export interface LiveRunStatus {
  store: LiveTurnStore;
  /** When the run started, for the elapsed time; null while unknown. */
  since: number | null;
  /** A stop is pending: the turn-level row must say so itself. */
  stopping: boolean;
}

export const LiveRunStatusContext = createContext<LiveRunStatus | null>(null);

const noSubscribe = () => () => {};
const getNull = () => null;

/** Phases in which an open reasoning block is still what the model is doing.
 * Without a reported phase (an older server), the trailing thought is the
 * best evidence there is. */
function stillThinking(activity: RunActivity | null): boolean {
  return (
    activity == null ||
    activity.kind === "thinking" ||
    activity.kind === "waiting"
  );
}

/**
 * The live state of a trailing reasoning block. `thinking` is false once the
 * engine has moved on (writing, preparing or running a tool), so the thought
 * stops shimmering and the turn-level row names the new phase instead.
 * `ownsStatus` means this block is the run's only status line: it claims the
 * store, which collapses the row below, and carries the elapsed time. A stop,
 * a compaction or a retry keeps that row, since this header cannot explain
 * them.
 */
export function useLiveReasoningStatus(active: boolean) {
  const run = useContext(LiveRunStatusContext);
  const getActivity = run?.store.getActivity ?? getNull;
  const activity = useSyncExternalStore(
    run?.store.subscribe ?? noSubscribe,
    getActivity,
    getActivity,
  );
  const thinking = active && (!run || stillThinking(activity));
  const ownsStatus =
    thinking &&
    run != null &&
    !run.stopping &&
    !activityInterruptsStream(activity);
  const store = run?.store;
  useEffect(() => {
    if (!ownsStatus || !store) return;
    return store.claimInlineStatus();
  }, [ownsStatus, store]);
  return { thinking, ownsStatus, since: run?.since ?? null };
}

/** The run's elapsed time, " · 15m", once it is long enough to matter. The
 * 1Hz ticker stays inside this node, and the value is hidden from assistive
 * tech so it is not announced every second. */
export function RunElapsed({
  since,
  className,
}: {
  since: number | null;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (since == null) return null;
  const { elapsed } = busyActivityStatus(now - since);
  if (!elapsed) return null;
  return (
    <span aria-hidden="true" className={className}>
      · {elapsed}
    </span>
  );
}
