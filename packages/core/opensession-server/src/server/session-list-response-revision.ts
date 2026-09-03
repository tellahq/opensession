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
 * Rebuild when a session mutation lands while a response is being assembled.
 * Otherwise every request coalesced onto that older build receives its stale
 * result and has no later WebSocket frame to trigger another refresh.
 */
export async function buildAtCurrentSessionListRevision<T>(
  build: () => Promise<T>,
): Promise<T> {
  while (true) {
    const revision = sessionListResponseRevision();
    const result = await build();
    if (revision === sessionListResponseRevision()) return result;
  }
}
