import { afterEach, describe, expect, test } from "bun:test";
import {
  enrichSessionRuntime,
  invalidateSessionsCache,
  runStateRequiresLiveOwner,
} from "./session-cache";
import { __sessionKernelStoreForTest } from "./session-kernel";
import type { UnifiedSession } from "./types";
import { allClients } from "./ws-hub";

const sockets = new Set<any>();

afterEach(() => {
  for (const socket of sockets) allClients.delete(socket);
  sockets.clear();
});

test("session cache invalidation notifies connected list clients", () => {
  const sent: string[] = [];
  const socket = {
    data: { watchingSessionId: null, user: "Ada" },
    send(payload: string) {
      sent.push(payload);
    },
  };
  sockets.add(socket);
  allClients.add(socket);

  invalidateSessionsCache();

  expect(sent.map((payload) => JSON.parse(payload))).toEqual([
    { type: "sessions_invalidated" },
  ]);
});

describe("session runtime enrichment", () => {
  test("requires an owner for every non-human unsettled state", () => {
    expect(runStateRequiresLiveOwner("preparing")).toBe(true);
    expect(runStateRequiresLiveOwner("running")).toBe(true);
    expect(runStateRequiresLiveOwner("reattaching")).toBe(true);
    expect(runStateRequiresLiveOwner("ask_blocked")).toBe(false);
    expect(runStateRequiresLiveOwner("idle")).toBe(false);
  });

  test("clears stale indexed running state after the runtime settles", () => {
    const session = {
      id: "stale-indexed-runtime-test",
      isRunning: true,
      runStartedAt: "2026-08-22T12:00:00.000Z",
    } as UnifiedSession;

    enrichSessionRuntime([session]);

    expect(session.isRunning).toBe(false);
    expect(session.runStartedAt).toBeUndefined();
  });

  test("uses one run-state projection for a full session list", () => {
    const store = __sessionKernelStoreForTest();
    const originalRunState = store.runState;
    const originalRunStates = store.runStates;
    let projectionReads = 0;
    let targetedReads = 0;
    store.runState = ((...args: Parameters<typeof store.runState>) => {
      targetedReads += 1;
      return originalRunState.apply(store, args);
    }) as typeof store.runState;
    store.runStates = (() => {
      projectionReads += 1;
      return [
        {
          sessionId: "bulk-running",
          state: "running",
          since: "2026-08-26T00:00:00.000Z",
          generation: 1,
          changeSeq: 1,
        },
      ];
    }) as typeof store.runStates;
    try {
      const sessions = Array.from(
        { length: 40 },
        (_, index) =>
          ({
            id: index === 0 ? "bulk-running" : `bulk-idle-${index}`,
          }) as UnifiedSession,
      );

      enrichSessionRuntime(sessions);

      expect(projectionReads).toBe(1);
      expect(targetedReads).toBe(0);
      expect(sessions[0]?.isRunning).toBe(true);
      expect(sessions[0]?.runState).toBe("running");
    } finally {
      store.runState = originalRunState;
      store.runStates = originalRunStates;
    }
  });
});
