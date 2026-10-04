import { DrainableWork } from "./drainable-work";
import { publishSessionChange } from "./session-cache";
import { onSessionStateChange } from "./session-state-events";

const g = globalThis as {
  __osSessionListRuntimeSync?: {
    stop?: () => void;
    work?: DrainableWork;
    pending: Set<string>;
    queued: boolean;
  };
};

const state = (g.__osSessionListRuntimeSync ??= {
  pending: new Set<string>(),
  queued: false,
});

/**
 * Refresh a session's list row when its run starts or settles. The live
 * status frame itself is room-scoped, so a client that leaves the conversation
 * between the final transcript append and `stream_done` otherwise misses the
 * transition and keeps the row in In progress until the fallback poll.
 *
 * This used to invalidate the whole list for every client on every run
 * boundary, which at fleet scale was the dominant source of refetch storms.
 * It now publishes exactly the changed row (session-row-events), once per
 * session per synchronous boundary: stream_start/session_status and
 * stream_done/session_status arrive in pairs.
 */
export function startSessionListRuntimeSync(
  publish: (sessionId: string) => void = publishSessionChange,
): void {
  if (state.stop) return;
  const work = (state.work ??= new DrainableWork());
  state.stop = onSessionStateChange((event) => {
    state.pending.add(event.sessionId);
    if (state.queued) return;
    state.queued = true;
    work.schedule(() => {
      state.queued = false;
      const ids = [...state.pending];
      state.pending.clear();
      for (const id of ids) void work.run(() => publish(id));
    });
  });
}

export function stopSessionListRuntimeSync(): void {
  state.stop?.();
  state.stop = undefined;
  state.queued = false;
  state.pending.clear();
}

/** Includes async list-index writes started by the coalesced callback. */
export function drainSessionListRuntimeSync(): Promise<void> {
  return state.work?.drain() ?? Promise.resolve();
}
