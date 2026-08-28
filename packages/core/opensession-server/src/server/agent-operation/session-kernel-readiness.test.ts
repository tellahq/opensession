import { describe, expect, test } from "bun:test";
import {
  createSessionKernelReadinessFacade,
  type SessionKernelReadinessOwners,
} from "./session-kernel-readiness";
import type { ProductionSessionKernelReadinessFacade } from "./production-probes";

const metric = () => ({
  turnsCompleted: 0,
  queueWaitMsTotal: 0,
  busyMsTotal: 0,
  timeouts: 0,
  restarts: 0,
  rejectedFull: 0,
  kernelStoreCacheMisses: 0,
  kernelStoreCacheEvictions: 0,
  transcriptStoreCacheMisses: 0,
  transcriptStoreCacheEvictions: 0,
  sqliteBusy: 0,
});

function lane(index: number, ready = true) {
  return {
    index,
    ready,
    restarting: false,
    queued: 0,
    executing: 0,
    ...metric(),
  };
}

type MutableOwners = {
  -readonly [K in keyof SessionKernelReadinessOwners]: SessionKernelReadinessOwners[K];
};

function fixture(sessionLaneCount = 2): MutableOwners {
  return {
    actorReady: () => ({
      ready: true,
      actorVersion: 32,
      transportVersion: 1,
      workers: { ready: sessionLaneCount, capacity: sessionLaneCount },
      lanes: [lane(0), ...Array.from({ length: sessionLaneCount }, (_, i) => lane(i + 1))],
    }),
    gatewayStats: () => ({ schemaVersion: 32 }),
    cancellation: () => ({ schemaVersion: 32, durableCancellation: true }),
    actorTranscripts: () => ({
      placement: "actor",
      migrationComplete: true,
      pendingMigrations: 0,
    }),
    deadlineMs: 50,
  };
}

async function readiness(owners: SessionKernelReadinessOwners) {
  const facade = createSessionKernelReadinessFacade(owners);
  const productionFacade: ProductionSessionKernelReadinessFacade = facade;
  void productionFacade;
  return facade.readiness(new AbortController().signal);
}

describe("production SessionKernel readiness facade", () => {
  test("scales with the reported lane population and keeps load/restart signals diagnostic", async () => {
    const owners = fixture(257);
    owners.actorReady = () => {
      const lanes = [lane(0), ...Array.from({ length: 257 }, (_, i) => lane(i + 1))];
      lanes[19] = { ...lanes[19]!, queued: 9, rejectedFull: 4 };
      lanes[211] = { ...lanes[211]!, restarting: true, restarts: 3, ready: false };
      return {
        ready: true,
        actorVersion: 32,
        transportVersion: 1,
        workers: { ready: 256, capacity: 257 },
        lanes,
      };
    };

    expect(await readiness(owners)).toEqual({
      schemaVersion: 32,
      cancellationAvailable: true,
      diagnostics: ["lane_saturation_observed", "lane_restart_observed"],
    });
  });

  test("fails closed on exact actor, transport, storage, and cancellation mismatches", async () => {
    for (const mutate of [
      (owners: MutableOwners) => {
        owners.actorReady = () => ({
          ready: true,
          actorVersion: 33,
          transportVersion: 1,
          workers: { ready: 1, capacity: 1 },
          lanes: [lane(0), lane(1)],
        });
      },
      (owners: MutableOwners) => {
        owners.actorReady = () => ({
          ready: true,
          actorVersion: 32,
          transportVersion: 2,
          workers: { ready: 1, capacity: 1 },
          lanes: [lane(0), lane(1)],
        });
      },
      (owners: MutableOwners) => {
        owners.gatewayStats = () => ({ schemaVersion: 33 });
      },
      (owners: MutableOwners) => {
        owners.cancellation = () => ({ schemaVersion: 32, durableCancellation: false });
      },
    ]) {
      const owners = fixture(1);
      mutate(owners);
      expect((await readiness(owners)).schemaVersion).toBe(0);
    }
  });

  test("requires at least one ready session worker and matching ready lane", async () => {
    const owners = fixture(1);
    owners.actorReady = () => ({
      ready: false,
      actorVersion: 32,
      transportVersion: 1,
      workers: { ready: 0, capacity: 3 },
      lanes: [lane(0), lane(1, false), lane(2, false), lane(3, false)],
    });
    expect(await readiness(owners)).toMatchObject({
      schemaVersion: 0,
      diagnostics: ["no_ready_lane"],
    });
  });

  test("requires complete actor transcript placement migration without enumerating paths", async () => {
    const owners = fixture();
    owners.actorTranscripts = () => ({
      placement: "actor",
      migrationComplete: false,
      pendingMigrations: 2_000_000,
    });
    expect(await readiness(owners)).toMatchObject({
      schemaVersion: 0,
      diagnostics: ["actor_transcript_migration_incomplete"],
    });
  });

  test("shares a bounded deadline, aborts owners, and fails closed", async () => {
    let aborted = false;
    const owners = fixture();
    owners.deadlineMs = 1;
    owners.gatewayStats = (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ schemaVersion: 32 });
      }, { once: true });
    });
    const result = await readiness(owners);
    expect(aborted).toBe(true);
    expect(result).toMatchObject({
      schemaVersion: 0,
      diagnostics: ["gateway_stats_unavailable"],
    });
  });

  test("uses exact non-invoking decoders and returns only redacted vocabulary", async () => {
    let getterCalls = 0;
    const owners = fixture();
    owners.actorReady = () => {
      const value = {
        ready: true,
        actorVersion: 32,
        transportVersion: 1,
        workers: { ready: 1, capacity: 1 },
        lanes: [lane(0), lane(1)],
        secretPath: "/private/session-kernel.sqlite",
      };
      Object.defineProperty(value, "actorVersion", {
        enumerable: true,
        get() { getterCalls++; return 32; },
      });
      return value;
    };
    owners.gatewayStats = () => {
      throw new Error("token=secret /private/kernel.sqlite");
    };
    const encoded = JSON.stringify(await readiness(owners));
    expect(getterCalls).toBe(0);
    expect(encoded).toContain("actor_readiness_unavailable");
    expect(encoded).toContain("gateway_stats_unavailable");
    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("private");
    expect(encoded).not.toContain("sqlite");
  });

  test("is inert until readiness is invoked", async () => {
    let calls = 0;
    const owners = fixture();
    owners.actorReady = () => { calls++; return {
      ready: true,
      actorVersion: 32,
      transportVersion: 1,
      workers: { ready: 1, capacity: 1 },
      lanes: [lane(0), lane(1)],
    }; };
    const facade = createSessionKernelReadinessFacade(owners);
    expect(calls).toBe(0);
    await facade.readiness(new AbortController().signal);
    expect(calls).toBe(1);
  });
});
