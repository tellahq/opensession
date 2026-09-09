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

/**
 * Retry one overlapping mutation, but never wait for the whole instance to
 * become idle. Under continuous writes an unbounded rebuild loop floods the
 * catalog and leaves the HTTP request waiting forever. Carry the build's
 * starting revision so callers cannot cache an overlapped result as fresh.
 */
export async function buildAtCurrentSessionListRevision<T>(
  build: () => Promise<T>,
): Promise<{ value: T; revision: number }> {
  let revision = sessionListResponseRevision();
  let value = await build();
  if (revision !== sessionListResponseRevision()) {
    revision = sessionListResponseRevision();
    value = await build();
  }
  return { value, revision };
}
