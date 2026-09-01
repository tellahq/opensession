import { invalidateSessionsCache } from "./session-cache";
import { onSessionStateChange } from "./session-state-events";

const g = globalThis as {
  __osSessionListRuntimeSync?: {
    stop?: () => void;
    queued: boolean;
  };
};

const state = (g.__osSessionListRuntimeSync ??= { queued: false });

/**
 * Refresh the app-wide session list when a run starts or settles. The live
 * status frame itself is room-scoped, so a client that leaves the conversation
 * between the final transcript append and `stream_done` otherwise misses the
 * transition and keeps the row in In progress until the fallback poll.
 */
export function startSessionListRuntimeSync(
  invalidate: () => void = invalidateSessionsCache,
): void {
  if (state.stop) return;
  state.stop = onSessionStateChange(() => {
    // stream_start/session_status and stream_done/session_status are emitted in
    // pairs. One list invalidation per synchronous boundary is sufficient.
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      invalidate();
    });
  });
}

export function stopSessionListRuntimeSync(): void {
  state.stop?.();
  state.stop = undefined;
  state.queued = false;
}
