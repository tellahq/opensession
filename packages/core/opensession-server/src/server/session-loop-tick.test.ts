import { expect, test } from "bun:test";
import { createSessionLoopTick } from "./session-loop-tick";
import type { UnifiedSession } from "./types";
function session(id: string): UnifiedSession {
  return {
    id,
    source: "opensession",
    claudeSessionId: "engine",
    branch: null,
    worktreeDir: null,
    startedBy: "Alice",
    createdBy: "Alice",
    title: id,
    lastActivity: "2026-01-01",
    isRunning: false,
    transcriptPath: null,
    loop: { prompt: "tick", intervalMinutes: 1 },
  } as UnifiedSession;
}
test("loop ticks coalesce while scope authority waits and release the guard after failure", async () => {
  let release!: () => void;
  const wait = new Promise<void>((done) => {
    release = done;
  });
  let reads = 0,
    failures = 0,
    stamps = 0,
    runs = 0;
  const tick = createSessionLoopTick({
    sessions: async () => {
      reads++;
      await wait;
      throw new Error("scope unavailable");
    },
    resolve: async (id) => session(id),
    busy: () => false,
    stamp: async () => {
      stamps++;
    },
    run: async () => {
      runs++;
    },
    failed: () => {
      failures++;
    },
  });
  const first = tick();
  await tick();
  expect(reads).toBe(1);
  release();
  await first;
  expect(stamps).toBe(0);
  expect(runs).toBe(0);
  expect(failures).toBe(1);
  await tick();
  expect(reads).toBe(2);
  expect(failures).toBe(2);
});
test("bounded loop admission is fair, reauthorizes ids, skips busy/revoked work and awaits durable stamp", async () => {
  const rows = [session("a"), session("b"), session("c"), session("d")];
  const admitted: string[] = [],
    stamped: string[] = [],
    resolved: string[] = [];
  const tick = createSessionLoopTick(
    {
      sessions: async () => rows,
      resolve: async (id) => {
        resolved.push(id);
        return id === "a" ? undefined : session(id);
      },
      busy: (s) => s.id === "b",
      stamp: async (id) => {
        stamped.push(id);
      },
      run: async (id) => {
        expect(stamped).toContain(id);
        admitted.push(id);
      },
      failed: (e) => {
        throw e;
      },
    },
    2,
  );
  await tick();
  expect(resolved).toEqual(["a", "b"]);
  expect(admitted).toEqual([]);
  await tick();
  expect(resolved).toEqual(["a", "b", "c", "d"]);
  expect(admitted).toEqual(["c", "d"]);
});
test("scope/stamp failure cannot schedule the selected loop", async () => {
  let runs = 0,
    failures = 0;
  const tick = createSessionLoopTick({
    sessions: async () => [session("a")],
    resolve: async (id) => session(id),
    busy: () => false,
    stamp: async () => {
      throw new Error("scope changed");
    },
    run: async () => {
      runs++;
    },
    failed: () => {
      failures++;
    },
  });
  await tick();
  expect(runs).toBe(0);
  expect(failures).toBe(1);
});
