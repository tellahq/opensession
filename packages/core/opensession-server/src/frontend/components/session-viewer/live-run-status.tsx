import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import type { RunActivity } from "@tellahq/opensession-protocol/events";
import { activityInterruptsStream } from "../../lib/busy-activity";
import type { LiveTurnStore } from "../../lib/live-turn-store";

/** What a transcript thought needs to hand its label to the turn-level row. */
export interface LiveRunStatus {
  store: LiveTurnStore;
  /** A stop is pending: the row below says "Stopping…", not "Thinking". */
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
 * `namedBelow` means the row at the end of the transcript says "Thinking"
 * with the elapsed time, so the thought drops its own shimmering label and
 * the status is said once. A stop, a compaction or a retry keeps the row's
 * own wording and leaves the thought its label.
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
  const namedBelow =
    thinking &&
    run != null &&
    !run.stopping &&
    !activityInterruptsStream(activity);
  const store = run?.store;
  useEffect(() => {
    if (!namedBelow || !store) return;
    return store.claimTrailingThought();
  }, [namedBelow, store]);
  return { thinking, namedBelow };
}
