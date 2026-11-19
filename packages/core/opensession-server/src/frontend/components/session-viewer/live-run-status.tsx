import { createContext, useContext, useSyncExternalStore } from "react";
import type { RunActivity } from "@tellahq/opensession-protocol/events";
import type { LiveTurnStore } from "../../lib/live-turn-store";

/** What a transcript thought needs to know about the run it belongs to. */
export interface LiveRunStatus {
  store: LiveTurnStore;
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
 * stops shimmering and the transcript row of the new phase takes over. The
 * row at the end of the transcript only carries the dot and the elapsed time,
 * so the thought names itself.
 */
export function useLiveReasoningStatus(active: boolean) {
  const run = useContext(LiveRunStatusContext);
  const getActivity = run?.store.getActivity ?? getNull;
  const activity = useSyncExternalStore(
    run?.store.subscribe ?? noSubscribe,
    getActivity,
    getActivity,
  );
  return { thinking: active && (!run || stillThinking(activity)) };
}
