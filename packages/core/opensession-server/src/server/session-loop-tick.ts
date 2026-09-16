import type { UnifiedSession } from "./types";

type Loop = NonNullable<UnifiedSession["loop"]>;
export interface LoopTickDependencies {
  sessions(): Promise<UnifiedSession[]>;
  resolve(id: string): Promise<UnifiedSession | undefined>;
  busy(session: UnifiedSession): boolean;
  stamp(id: string, loop: Loop): Promise<void>;
  run(id: string, loop: Loop): Promise<void>;
  failed(error: unknown): void;
  now?: () => number;
}

/** One coalesced, bounded pass. The snapshot selects work; an exact scoped read
 * re-authorizes each selected id before any timestamp or prompt mutation. A
 * rotating cursor prevents a busy/large prefix from starving later loops. */
export function createSessionLoopTick(
  deps: LoopTickDependencies,
  limit = 32,
): () => Promise<void> {
  let busy = false;
  let after = "";
  return async () => {
    if (busy) return;
    busy = true;
    try {
      const candidates = (await deps.sessions())
        .filter((s) => s.loop && !s.archived && s.source === "opensession")
        .sort((a, b) => a.id.localeCompare(b.id));
      const start = candidates.findIndex((s) => s.id > after);
      const rotated =
        start < 0
          ? candidates
          : [...candidates.slice(start), ...candidates.slice(0, start)];
      for (const candidate of rotated.slice(0, limit)) {
        after = candidate.id;
        const session = await deps.resolve(candidate.id);
        const loop = session?.loop;
        if (
          !session ||
          !loop ||
          session.archived ||
          (!session.claudeSessionId && !session.codexThreadId) ||
          deps.busy(session)
        )
          continue;
        const now = deps.now?.() ?? Date.now();
        const last = loop.lastRunAt ? Date.parse(loop.lastRunAt) : 0;
        if (now - last < loop.intervalMinutes * 60_000) continue;
        const next = { ...loop, lastRunAt: new Date(now).toISOString() };
        await deps.stamp(session.id, next);
        // A run can last minutes; the tick owns admission, not its lifetime.
        void deps.run(session.id, next).catch(deps.failed);
      }
    } catch (error) {
      deps.failed(error);
    } finally {
      busy = false;
    }
  };
}
