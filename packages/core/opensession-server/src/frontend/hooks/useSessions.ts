import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { UnifiedSession } from "../lib/types";
import type { SessionSocket } from "./useSessionSocket";
import { fetchSessionsSnapshot } from "../lib/api";
import {
  mergeSessionSlices,
  settledOverrides,
  type LocalArchiveOverride,
} from "../lib/session-slices";
import { errorMessage } from "../lib/error-message";
import * as SessionListRuntime from "../lib/session-list-runtime";
import {
  ARCHIVED_QUERY,
  LIVE_POLL_FALLBACK_MS,
  LIVE_QUERY,
  detachPendingRequest,
  liveSnapshotMatchesQuery,
  reconcilePendingSessionPatches,
  reconcileStickySessions,
  sessionPatchNeedsAcknowledgement,
  type PendingSessionPatch,
  type StickySession,
} from "../lib/session-list-state";

export type {
  PendingSessionPatch,
  SidebarSessionsQueryOptions,
  StickySession,
} from "../lib/session-list-state";
export {
  LIVE_POLL_FALLBACK_MS,
  liveSnapshotMatchesQuery,
  reconcilePendingSessionPatches,
  reconcileStickySessions,
  sessionPatchNeedsAcknowledgement,
  sidebarSessionsQuery,
} from "../lib/session-list-state";

export function useSessions({
  loadArchived = false,
  pollInterval = LIVE_POLL_FALLBACK_MS,
  liveQuery = LIVE_QUERY,
  socket,
}: {
  loadArchived?: boolean;
  pollInterval?: number;
  liveQuery?: string;
  socket?: Pick<SessionSocket, "addHandler"> & { connected: boolean };
} = {}) {
  const [runtime] = useState(() => SessionListRuntime.makeSessionListRuntime());
  const [live, setLive] = useState<UnifiedSession[]>([]);
  // When the live list last came back. Settles a local unarchive: a poll that
  // STARTED after the change and still doesn't list the session means the
  // change didn't take, and the override should stop hiding the archived row.
  // Every refresh writes it, including byte-identical fallback responses the
  // ETag and `lastTextRef` guards exist to make free. The ref is the value; the
  // state is only
  // the trigger, promoted while an override is actually waiting on it.
  const liveAtRef = useRef(0);
  const [liveAt, setLiveAt] = useState(0);
  const [archivedIndex, setArchivedIndex] = useState<UnifiedSession[] | null>(
    null,
  );
  // When the archived index last came back, with the same split as `liveAt`
  // above: the archived fallback runs while the Archived screen is open, and
  // its 304s carried no new rows but re-rendered
  // the app anyway. The ref is the value; the state is only the trigger.
  const archivedIndexAtRef = useRef(0);
  const [archivedIndexAt, setArchivedIndexAt] = useState(0);
  const [locallyArchived, setLocallyArchived] = useState<
    Map<string, LocalArchiveOverride>
  >(() => new Map());
  const [locallyUnarchived, setLocallyUnarchived] = useState<
    Map<string, number>
  >(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Read by `patch` to capture the row it is archiving, which the very next
  // live poll will drop. Assigned during render, like App.tsx's own *Ref
  // mirrors — a callback can't close over state without re-creating itself.
  const liveRef = useRef<UnifiedSession[]>(live);
  useLayoutEffect(() => {
    liveRef.current = live;
  });
  // The merged list, for the reverse move: unarchiving a session that is only
  // in the archived index has nothing in `live` to flip, so `patch` puts it
  // there. Assigned below, once the merge has run.
  const mergedRef = useRef<UnifiedSession[]>(live);
  // Read by the poll to decide whether anything is waiting on `liveAt`.
  const locallyArchivedRef = useRef(locallyArchived);
  const locallyUnarchivedRef = useRef(locallyUnarchived);
  useLayoutEffect(() => {
    locallyArchivedRef.current = locallyArchived;
    locallyUnarchivedRef.current = locallyUnarchived;
  });
  // Raw JSON text of the last applied refresh. When it returns byte-identical
  // data, skip setSessions entirely — a fresh array
  // identity would otherwise re-render the whole app (Sidebar memos, the open
  // SessionViewer's `session` prop, …) for nothing.
  const lastTextRef = useRef<string | null>(null);
  const etagRef = useRef<string | null>(null);
  const appliedLiveQueryRef = useRef(liveQuery);
  const pollPromiseRef = useRef<{
    query: string;
    promise: Promise<void>;
  } | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  // An invalidation can land while a list request is in flight. The revision
  // lets that request finish, then immediately reruns it instead of mistaking
  // the already-running request for a refresh of the newer server state.
  const invalidationRevisionRef = useRef(0);
  // Fence the previous route's scoped response before passive effects start its
  // replacement poll. Abort is best-effort; the query comparison after await is
  // the authority when a completed fetch wins the race with cancellation.
  useLayoutEffect(() => {
    if (appliedLiveQueryRef.current === liveQuery) return;
    appliedLiveQueryRef.current = liveQuery;
    etagRef.current = null;
    lastTextRef.current = null;
    pollAbortRef.current?.abort();
  }, [liveQuery]);
  // Optimistically-injected sessions the server hasn't caught up to yet (a
  // just-created workspace/session). A plain poll replaces the whole array and
  // would drop the injected copy — flashing a loading placeholder until the
  // create lands seconds later. A selected row stays available through
  // temporarily inconsistent server projections; background creates retire as
  // soon as the server returns them.
  const stickyRef = useRef<Map<string, StickySession>>(new Map());
  // Optimistic changes that must survive an older poll already in flight.
  // Archive fields wait for value acknowledgement; runtime fields yield to the
  // first snapshot started after their WebSocket frame.
  const pendingPatchRef = useRef<Map<string, PendingSessionPatch>>(new Map());
  // A poll captures this before it starts. Runtime frames increment it, which
  // lets reconciliation distinguish an older response from a later, current
  // server snapshot without relying on wall-clock timing.
  const runtimeRevisionRef = useRef(0);

  const applyServer = (
    parsed: UnifiedSession[],
    snapshotRuntimeRevision: number,
    requestQuery: string,
  ) => {
    const reconciled = reconcilePendingSessionPatches(
      parsed,
      pendingPatchRef.current,
      snapshotRuntimeRevision,
    );
    const selectedSessionId =
      new URLSearchParams(
        requestQuery.startsWith("?") ? requestQuery.slice(1) : requestQuery,
      ).get("session") ?? undefined;
    // Reconcile refs before scheduling state. React may replay state updaters
    // in development, so mutating stickyRef from inside one can acknowledge a
    // single server snapshot twice and retire the fallback too early.
    setLive(
      reconcileStickySessions(reconciled, stickyRef.current, selectedSessionId),
    );
  };

  // Stable per query: refs, setters and module fns otherwise. The polling
  // effect below can list it without re-arming on unrelated re-renders.
  // Named function expression so the invalidation re-poll can recurse
  // without the compiler seeing a read of `poll` mid-initialization.
  const poll = useCallback(
    async function pollSelf(): Promise<void> {
      const requestQuery = liveQuery;
      if (pollPromiseRef.current?.query === requestQuery)
        return pollPromiseRef.current.promise;
      if (pollPromiseRef.current) pollAbortRef.current?.abort();
      if (appliedLiveQueryRef.current !== requestQuery) {
        appliedLiveQueryRef.current = requestQuery;
        etagRef.current = null;
        lastTextRef.current = null;
      }
      const controller = new AbortController();
      pollAbortRef.current = controller;
      const startedAt = Date.now();
      const snapshotRuntimeRevision = runtimeRevisionRef.current;
      const invalidationRevision = invalidationRevisionRef.current;
      const promise = (async () => {
        await (async () => {
          const snapshot = await fetchSessionsSnapshot({
            etag: etagRef.current,
            signal: controller.signal,
            query: requestQuery,
          });
          if (
            !mountedRef.current ||
            !liveSnapshotMatchesQuery(requestQuery, appliedLiveQueryRef.current)
          )
            return;
          if (!snapshot.notModified && snapshot.text !== null) {
            etagRef.current = snapshot.etag;
            if (snapshot.text !== lastTextRef.current) {
              lastTextRef.current = snapshot.text;
              applyServer(
                JSON.parse(snapshot.text),
                snapshotRuntimeRevision,
                requestQuery,
              );
            }
          }
          liveAtRef.current = startedAt;
          if (
            locallyArchivedRef.current.size > 0 ||
            locallyUnarchivedRef.current.size > 0
          )
            setLiveAt(startedAt);
          setLoading(false);
          setError(null);
        })().catch(async (error) => {
          if (error instanceof Error && error.name === "AbortError") return;
          if (mountedRef.current) {
            setError(errorMessage(error, "Failed to load sessions"));
            setLoading(false);
          }
        });
      })().finally(() => {
        if (pollPromiseRef.current?.promise === promise)
          pollPromiseRef.current = null;
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
        if (
          mountedRef.current &&
          document.visibilityState !== "hidden" &&
          invalidationRevisionRef.current !== invalidationRevision
        )
          void pollSelf();
      });
      pollPromiseRef.current = { query: requestQuery, promise };
      return promise;
    },
    [liveQuery],
  );

  // ── The archived index ─────────────────────────────────────────────────
  const archivedTextRef = useRef<string | null>(null);
  const archivedEtagRef = useRef<string | null>(null);
  const archivedPromiseRef = useRef<Promise<void> | null>(null);
  const archivedAbortRef = useRef<AbortController | null>(null);

  const pollArchived = useCallback(
    async function pollArchivedSelf(): Promise<void> {
      if (archivedPromiseRef.current) return archivedPromiseRef.current;
      const controller = new AbortController();
      archivedAbortRef.current = controller;
      const startedAt = Date.now();
      const invalidationRevision = invalidationRevisionRef.current;
      const promise = (async () => {
        await (async () => {
          const snapshot = await fetchSessionsSnapshot({
            etag: archivedEtagRef.current,
            query: ARCHIVED_QUERY,
            signal: controller.signal,
          });
          if (!mountedRef.current) return;
          if (!snapshot.notModified && snapshot.text !== null) {
            archivedEtagRef.current = snapshot.etag;
            if (snapshot.text !== archivedTextRef.current) {
              archivedTextRef.current = snapshot.text;
              setArchivedIndex(JSON.parse(snapshot.text));
            }
          }
          archivedIndexAtRef.current = startedAt;
          if (
            locallyArchivedRef.current.size > 0 ||
            locallyUnarchivedRef.current.size > 0
          )
            setArchivedIndexAt(startedAt);
        })().catch(async () => {
          // Never surfaced as the app's error: the live list is what the app is
          // for, and a failed index just leaves Archived showing what it had.
        });
      })().finally(() => {
        if (archivedPromiseRef.current === promise)
          archivedPromiseRef.current = null;
        if (archivedAbortRef.current === controller)
          archivedAbortRef.current = null;
        if (
          mountedRef.current &&
          document.visibilityState !== "hidden" &&
          invalidationRevisionRef.current !== invalidationRevision
        )
          void pollArchivedSelf();
      });
      archivedPromiseRef.current = promise;
      return promise;
    },
    [],
  );

  useLayoutEffect(() => {
    runtime.configure({
      pollInterval,
      loadArchived,
      loading,
      pollLive: poll,
      pollArchived,
    });
  }, [loadArchived, loading, poll, pollArchived, pollInterval, runtime]);

  useEffect(() => {
    mountedRef.current = true;
    const stop = runtime.start();
    return () => {
      mountedRef.current = false;
      // Clear before aborting so a Strict Mode remount cannot deduplicate onto
      // the previous lifetime's rejected promise. Identity checks in each
      // request's finally block keep it from clearing a replacement.
      detachPendingRequest(pollPromiseRef, pollAbortRef);
      detachPendingRequest(archivedPromiseRef, archivedAbortRef);
      stop();
    };
  }, [runtime]);

  // One list out of the slices, so every consumer keeps reading `archived`
  // off a single array (see lib/session-slices for why that's the shape).
  const sessions = mergeSessionSlices({
    live,
    archivedIndex,
    locallyArchived,
    locallyUnarchived,
  });
  useLayoutEffect(() => {
    mergedRef.current = sessions;
  });

  // Forget the local overrides the server has caught up with.
  useEffect(() => {
    if (locallyArchived.size === 0 && locallyUnarchived.size === 0) return;
    const settled = settledOverrides({
      live,
      liveAt: liveAtRef.current,
      archivedIndex,
      archivedIndexAt: archivedIndexAtRef.current,
      locallyArchived,
      locallyUnarchived,
    });
    if (settled.archived.length)
      setLocallyArchived((prev) => {
        const next = new Map(prev);
        for (const id of settled.archived) next.delete(id);
        return next;
      });
    if (settled.unarchived.length)
      setLocallyUnarchived((prev) => {
        const next = new Map(prev);
        for (const id of settled.unarchived) next.delete(id);
        return next;
      });
    // `liveAt` and `archivedIndexAt` are here as the trigger for a poll that
    // landed with an override pending; the values the settle reads are the refs
    // above, which every poll updates.
  }, [
    live,
    liveAt,
    archivedIndex,
    archivedIndexAt,
    locallyArchived,
    locallyUnarchived,
  ]);

  // Expose manual refresh for after deletes. Keep refreshing an already-loaded
  // archived slice even after navigating away from the Archived surface.
  const refresh = () => {
    runtime.refresh();
    if (!loadArchived && archivedIndex !== null) void pollArchived();
  };

  // Coalesce write bursts into one scoped list read. If the timer meets an
  // older request already in flight, poll's revision fence runs once more when
  // that request settles.
  const refreshInvalidated = () => {
    invalidationRevisionRef.current++;
    if (document.visibilityState === "hidden") return;
    runtime.invalidate(() => {
      if (document.visibilityState === "hidden") return;
      void poll();
      if (loadArchived || archivedIndex !== null) void pollArchived();
    });
  };

  const onInvalidated = useEffectEvent(() => refreshInvalidated());
  const addHandler = socket?.addHandler;
  useEffect(() => {
    if (!addHandler) return;
    return addHandler((message) => {
      if (message.type === "sessions_invalidated") onInvalidated();
    });
  }, [addHandler]);

  // A disconnected socket may miss list invalidations. Refresh on every
  // connection, including the first: the initial list request may have read an
  // older snapshot before the socket handler was ready. The invalidation
  // revision fences an initial request that is still in flight.
  const onConnected = useEffectEvent(() => refreshInvalidated());
  const socketConnected = socket?.connected ?? false;
  useEffect(() => {
    if (socketConnected) onConnected();
    // Refresh only when connectivity changes. Changes to the current list or
    // archived state are not reconnects and must not re-arm this effect.
  }, [socketConnected]);

  // Drop a just-created session straight into the list so the UI can render it
  // immediately (e.g. the tab-strip + creating a new session) instead of showing a
  // loading state until the next poll. The next poll replaces it with the
  // server's copy. Pass `{ sticky: true }` for a create the server takes a while
  // to register (a new workspace): the injected copy then survives every poll
  // until the server's own copy lands, so the new tab renders instead of a
  // "Starting…" placeholder. Call `unstick` if the create fails.
  const inject = (session: UnifiedSession, opts?: { sticky?: boolean }) => {
    // The list no longer matches the last server response — force the next
    // poll to apply (it reconciles the injected copy, same as before).
    lastTextRef.current = null;
    etagRef.current = null;
    const pending = stickyRef.current.get(session.id);
    if (opts?.sticky)
      stickyRef.current.set(session.id, {
        session,
        serverSeen: pending?.serverSeen ?? false,
      });
    else if (pending) pending.session = session;
    setLive((prev) =>
      prev.some((s) => s.id === session.id)
        ? prev.map((s) => (s.id === session.id ? session : s))
        : [...prev, session],
    );
  };

  // Drop a session's sticky status (e.g. its create failed / was abandoned).
  // The session itself stays until the next poll reconciles it away.
  const unstick = (id: string) => {
    if (stickyRef.current.delete(id)) {
      lastTextRef.current = null;
      etagRef.current = null;
    }
  };

  const patch = (id: string, patch: Partial<UnifiedSession>) => {
    lastTextRef.current = null;
    etagRef.current = null;
    const sticky = stickyRef.current.get(id);
    if (sticky) sticky.session = { ...sticky.session, ...patch };
    if (sessionPatchNeedsAcknowledgement(patch)) {
      const previous = pendingPatchRef.current.get(id);
      const runtimeRevision =
        "isRunning" in patch
          ? ++runtimeRevisionRef.current
          : previous?.runtimeRevision;
      pendingPatchRef.current.set(id, {
        values: { ...previous?.values, ...patch },
        runtimeRevision,
      });
    }
    if ("archived" in patch) {
      const at = Date.now();
      const drop = <V>(prev: Map<string, V>) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      };
      if (patch.archived) {
        // The next live poll drops this row and the index doesn't have it
        // yet: hold the copy we already have so the session doesn't blink
        // out of the sidebar and out of ⌘Z's reach in between.
        const current = liveRef.current.find((s) => s.id === id);
        if (current)
          setLocallyArchived((prev) =>
            new Map(prev).set(id, { session: { ...current, ...patch }, at }),
          );
        setLocallyUnarchived(drop);
      } else {
        setLocallyUnarchived((prev) => new Map(prev).set(id, at));
        setLocallyArchived(drop);
        // Mirror image of the above: the row lives in the archived index,
        // so there is nothing in the live slice for the patch below to flip
        // and it would vanish until the next poll. Move it across now. It
        // may be an index summary; one poll replaces it with the full row.
        const known = mergedRef.current.find((s) => s.id === id);
        if (known)
          setLive((prev) =>
            prev.some((s) => s.id === id)
              ? prev
              : [...prev, { ...known, ...patch }],
          );
      }
      // Settle the override immediately when the index is already in use.
      // Otherwise the local copy is enough for undo until Archived opens.
      if (loadArchived || archivedIndex !== null) void pollArchived();
    }
    setLive((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const remove = (id: string) => {
    lastTextRef.current = null;
    etagRef.current = null;
    archivedTextRef.current = null;
    archivedEtagRef.current = null;
    stickyRef.current.delete(id);
    pendingPatchRef.current.delete(id);
    const drop = <V>(prev: Map<string, V>) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    };
    setLive((prev) => prev.filter((s) => s.id !== id));
    setArchivedIndex((prev) => prev && prev.filter((s) => s.id !== id));
    setLocallyArchived(drop);
    setLocallyUnarchived(drop);
  };

  return {
    sessions,
    loading,
    error,
    /** False until the archived index lands — the Archived page's own
     *  loading state, which it never needed while the list carried
     *  everything. */
    archivedLoaded: archivedIndex !== null,
    refreshArchived: pollArchived,
    refresh,
    inject,
    unstick,
    patch,
    remove,
  };
}
