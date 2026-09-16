import { sessionMetadata } from "./session-kernel";
import type { ScopeFence } from "./session-kernel/access-ledger";
import { scopeProjectionCall } from "./session-list-store";

export type ScopeReadFence = ScopeFence & { replica: string };
export function sameScopeReadFence(
  a: ScopeReadFence | undefined,
  b: ScopeReadFence,
): boolean {
  return sameScopeFence(a, b) && a?.replica === b.replica;
}

export class SessionScopeUnavailable extends Error {}
class ScopeChangedDuringRead extends SessionScopeUnavailable {}
export function sameScopeFence(
  a: ScopeFence | null | undefined,
  b: ScopeFence,
): boolean {
  return (
    !!a && a.incarnation === b.incarnation && a.generation === b.generation
  );
}

let synchronizing: Promise<void> | undefined;
async function synchronize(maxPages = 8): Promise<void> {
  if (synchronizing) return synchronizing;
  synchronizing = (async () => {
    const authority = await sessionMetadata({ op: "scope_fence" });
    let current = await scopeProjectionCall("scopeState");
    if (!current || current.incarnation !== authority.incarnation) {
      await scopeProjectionCall("resetScopeReplica", authority.incarnation);
      current = await scopeProjectionCall("scopeState");
      if (!current)
        throw new SessionScopeUnavailable(
          "Scope replica initialization failed",
        );
    }
    if (current.generation > authority.generation)
      throw new SessionScopeUnavailable("Scope authority moved backwards");
    // Bounded per call; bootstrap can resume from the durable last applied page.
    // A large backlog is unavailable, never a license to use an old projection.
    for (
      let pages = 0;
      current.generation < authority.generation && pages < maxPages;
      pages++
    ) {
      const delta = await sessionMetadata({
        op: "scope_changes",
        after: current.generation,
        limit: 1000,
      });
      if (
        delta.fence.incarnation !== authority.incarnation ||
        !delta.rows.length
      )
        throw new SessionScopeUnavailable(
          "Scope authority changed during replication",
        );
      await scopeProjectionCall("applyScopeDelta", current, delta);
      current = (await scopeProjectionCall("scopeState"))!;
    }
    if (current.generation < authority.generation)
      throw new SessionScopeUnavailable("Scope projection is catching up");
  })().finally(() => {
    synchronizing = undefined;
  });
  return synchronizing;
}

/** Bracket the COMPLETE result construction, not just its SQL query. A cached
 * payload is usable only at this exact durable authority incarnation/version.
 * No availability error, replica reset or concurrent ownership change may turn
 * into stale-while-refresh success. */
/** Boot-only complete replay. Normal request reads remain hard-bounded. */
export function primeSessionScopeCoverage(): Promise<void> {
  return synchronize(Number.MAX_SAFE_INTEGER);
}

export async function withSessionScopeFence<T>(
  read: (fence: ScopeReadFence) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      await synchronize();
      const before = await sessionMetadata({ op: "scope_fence" });
      const replica = await scopeProjectionCall("scopeState");
      if (!sameScopeFence(replica, before))
        throw new ScopeChangedDuringRead("Stale scope coverage");
      const result = await read({ ...before, replica: replica!.replica });
      const after = await sessionMetadata({ op: "scope_fence" });
      const applied = await scopeProjectionCall("scopeState");
      if (
        !sameScopeFence(before, after) ||
        !sameScopeFence(applied, after) ||
        applied?.replica !== replica?.replica
      )
        throw new ScopeChangedDuringRead("Scope changed while reading");
      return result;
    } catch (error) {
      if (error instanceof ScopeChangedDuringRead && attempt === 0) continue;
      if (error instanceof SessionScopeUnavailable) throw error;
      throw new SessionScopeUnavailable(
        "Session scope authority is unavailable",
        { cause: error },
      );
    }
  }
}
