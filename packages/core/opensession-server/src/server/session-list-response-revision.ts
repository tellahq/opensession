type SessionListResponseRevisionState = typeof globalThis & {
  __osSessionListResponseRevision?: number;
};

const state = globalThis as SessionListResponseRevisionState;

export function sessionListResponseRevision(): number {
  return state.__osSessionListResponseRevision ?? 0;
}

export function advanceSessionListResponseRevision(): void {
  state.__osSessionListResponseRevision = sessionListResponseRevision() + 1;
}

const MAX_REVISION_BUILDS = 3;

/**
 * Rebuild when a session mutation lands while a response is being assembled.
 * Otherwise every request coalesced onto that older build receives its stale
 * result and has no later WebSocket frame to trigger another refresh.
 *
 * Bounded: when builds are slow and sessions change constantly, every build
 * overlaps a mutation, and an unbounded loop never answers anyone. After the
 * last attempt the newest result is returned; response snapshots expire on a
 * short TTL, so the next poll rebuilds past the mutation it missed.
 */
export async function buildAtCurrentSessionListRevision<T>(
  build: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const revision = sessionListResponseRevision();
    const result = await build();
    if (
      revision === sessionListResponseRevision() ||
      attempt >= MAX_REVISION_BUILDS
    )
      return result;
  }
}

/** One response key's build in flight, and at most one queued behind it. */
export interface SessionListBuildSlot<T> {
  running?: { revision: number; promise: Promise<T> };
  queued?: Promise<T>;
}

/**
 * Coalesce builds of one response key so each caller gets a build that began
 * after every session mutation made before the caller arrived.
 *
 * A caller shares the running build when it started at or after the revision
 * the caller saw, or the build queued behind it (which starts later, so it is
 * newer still). Otherwise it queues one build after the running one. A
 * mutation during a build never restarts it: the callers already waiting
 * asked before that mutation, and later callers get the queued build.
 *
 * buildAtCurrentSessionListRevision instead rebuilt until no mutation
 * overlapped. With agent runs writing several rows a second, every sidebar
 * build overlapped one, so each refresh paid for three builds (2026-11-05:
 * 2.2-2.7 s per refresh even for an empty lens). `build` receives the
 * revision it started at, so its result can say how fresh it is.
 */
export function buildForSessionListRevision<T>(
  slots: Map<string, SessionListBuildSlot<T>>,
  key: string,
  build: (revision: number) => Promise<T>,
): Promise<T> {
  const needed = sessionListResponseRevision();
  let slot = slots.get(key);
  if (!slot) slots.set(key, (slot = {}));
  if (slot.queued) return slot.queued;
  if (slot.running && slot.running.revision >= needed)
    return slot.running.promise;
  const owner = slot;
  const start = (): Promise<T> => {
    const revision = sessionListResponseRevision();
    const promise: Promise<T> = Promise.resolve()
      .then(() => build(revision))
      .finally(() => {
        if (owner.running?.promise === promise) owner.running = undefined;
        if (!owner.running && !owner.queued && slots.get(key) === owner)
          slots.delete(key);
      });
    owner.running = { revision, promise };
    return promise;
  };
  if (!slot.running) return start();
  const queued = slot.running.promise
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      owner.queued = undefined;
      return start();
    });
  slot.queued = queued;
  return queued;
}

/** Personal overlays change sidebar membership without changing a session row. */
export function invalidateSidebarSessionResponses(): void {
  advanceSessionListResponseRevision();
  const snapshots = (
    globalThis as typeof globalThis & {
      __osSessionsResponseSnapshots?: Map<string, { expiresAt: number }>;
    }
  ).__osSessionsResponseSnapshots;
  for (const [key, snapshot] of snapshots ?? [])
    if (key.startsWith("sidebar\u0000")) snapshot.expiresAt = 0;
}
