import { describe, expect, test } from "bun:test";
import {
  AGENT_DELETION_PHASES,
  AGENT_DELETION_RECEIPT_RETENTION_MS,
  AGENT_DELETION_SCHEMA_VERSION,
  AgentDeletionCoordinator,
  AgentDeletionReceiptError,
  type AgentDeletionDigest,
  type AgentDeletionDurableStore,
  type AgentDeletionHostReceipt,
  type AgentDeletionHostTarget,
  type AgentDeletionIdentity,
  type AgentDeletionOwners,
  type AgentDeletionRecord,
} from "./deletion-coordinator";

type ActivePhase = Exclude<(typeof AGENT_DELETION_PHASES)[number], "completed">;
const activePhases = AGENT_DELETION_PHASES.slice(0, -1) as ActivePhase[];
const identity = { sessionId: "os-session", deleteRequestId: "delete-exact-1" };
const digest = (letter = "a") => `sha256:${letter.repeat(64)}` as AgentDeletionDigest;
const clone = <T>(value: T): T => structuredClone(value);

class MemoryStore implements AgentDeletionDurableStore {
  record?: AgentDeletionRecord;
  casCalls = 0;
  failCas?: number;
  cleanupBefore?: number;

  async claim(input: AgentDeletionIdentity & { schemaVersion: 1; createdAtMs: number }) {
    this.record ??= {
      ...input,
      revision: 0,
      updatedAtMs: input.createdAtMs,
      phase: "stop_and_detach",
      receipts: [],
    };
    return clone(this.record);
  }

  async load() {
    if (!this.record) throw new Error("missing");
    return clone(this.record);
  }

  async compareAndSwap(expectedRevision: number, next: AgentDeletionRecord) {
    this.casCalls++;
    if (this.casCalls === this.failCas) throw new Error("crash");
    if (!this.record || this.record.revision !== expectedRevision) {
      return { status: "conflict", record: clone(this.record!) };
    }
    this.record = clone(next);
    return { status: "committed", record: clone(this.record) };
  }

  async cleanupCompleted(before: number) {
    this.cleanupBefore = before;
    return 1;
  }
}

function ownerReceipt<P extends ActivePhase>(
  phase: P,
  id: AgentDeletionIdentity = identity,
) {
  return { schemaVersion: 1 as const, ...id, phase, digest: digest("b") };
}

function hostReceipt(target: AgentDeletionHostTarget, id: AgentDeletionIdentity = identity): AgentDeletionHostReceipt {
  return {
    schemaVersion: 1,
    ...id,
    ...target,
    disposition: "tombstoned",
    tombstoneDigest: digest("c"),
  };
}

function fixture(options: {
  hosts?: readonly AgentDeletionHostTarget[];
  fail?: string;
  onCall?: (name: string) => Promise<void> | void;
} = {}) {
  const calls: string[] = [];
  const hosts = [...(options.hosts ?? [])];
  const invoke = async <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    await options.onCall?.(name);
    if (options.fail === name) throw new Error(`${name} unavailable`);
    return value;
  };
  const owners: AgentDeletionOwners = {
    stopLiveTurnAndDetachRoute: (id) => invoke("stop", ownerReceipt("stop_and_detach", id)),
    enumeratePinsAndHosts: (id) => invoke("enumerate", {
      schemaVersion: 1,
      ...id,
      digest: digest("d"),
      pins: hosts.map(({ generationId, runGeneration }) => ({ generationId, runGeneration })),
      hosts,
    }),
    deleteFromHost: ({ target, ...id }) => invoke(`host:${target.hostId}`, hostReceipt(target, id)),
    settleGatewayPrivateRegistries: (id) => invoke("registries", ownerReceipt("settle_gateway", id)),
    settleOperationLedger: (id) => invoke("ledger", ownerReceipt("settle_gateway", id)),
    verifyHostDeletionAndReleasePins: ({ pins, hostReceipts, ...id }) => invoke("release", {
      schemaVersion: 1,
      ...id,
      phase: "verify_and_release_pins" as const,
      digest: digest("e"),
      pins,
      hostReceipts,
    }),
    deleteTranscriptAndResetWake: (id) => invoke("transcript", ownerReceipt("delete_transcript", id)),
    tombstoneKernelAndFinishArtifacts: (id) => invoke("kernel", ownerReceipt("finish_kernel", id)),
  };
  return { calls, owners };
}

for (const state of ["idle", "active", "reconnecting", "recovering"] as const) {
  test(`deletes an ${state} session in owner order and replays exact success`, async () => {
    const store = new MemoryStore();
    const { calls, owners } = fixture();
    const coordinator = new AgentDeletionCoordinator(store, owners, () => 100);
    const first = await coordinator.deleteSession(identity);
    expect(await coordinator.deleteSession(identity)).toEqual(first);
    expect(calls).toEqual([
      "stop", "enumerate", "registries", "ledger", "release", "transcript", "kernel",
    ]);
    expect(store.record?.revision).toBe(7);
    expect(store.record?.receipts.map(({ phase }) => phase)).toEqual(activePhases);
    expect(store.record?.receipts.every((receipt) =>
      !Object.hasOwn(receipt, "evidence") && receipt.evidenceDigests.every((value) => value.startsWith("sha256:")),
    )).toBe(true);
  });
}

test("two process coordinators converge through stale CAS without phase regression", async () => {
  const store = new MemoryStore();
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { owners } = fixture({
    onCall: async (name) => {
      if (name !== "stop") return;
      waiting++;
      if (waiting === 2) release();
      await gate;
    },
  });
  const first = new AgentDeletionCoordinator(store, owners, () => 10);
  const second = new AgentDeletionCoordinator(store, owners, () => 11);
  const [a, b] = await Promise.all([first.deleteSession(identity), second.deleteSession(identity)]);
  expect(a).toEqual(b);
  expect(store.record?.phase).toBe("completed");
  expect(store.record?.receipts.map(({ phase }) => phase)).toEqual(activePhases);
});

test("failure checkpoint from stale coordinator cannot overwrite completed state", async () => {
  const store = new MemoryStore();
  const good = fixture();
  const stale = fixture();
  let rejectStop!: (error: Error) => void;
  stale.owners.stopLiveTurnAndDetachRoute = () => new Promise((_, reject) => { rejectStop = reject; });
  const staleRun = new AgentDeletionCoordinator(store, stale.owners, () => 1).deleteSession(identity);
  await Promise.resolve();
  await new AgentDeletionCoordinator(store, good.owners, () => 2).deleteSession(identity);
  rejectStop(new Error("late owner failure"));
  await expect(staleRun).rejects.toThrow("late owner failure");
  expect(store.record?.phase).toBe("completed");
  expect(store.record?.lastFailure).toBeUndefined();
});

test("crash after owner before CAS replays only the same destination idempotency identity", async () => {
  const store = new MemoryStore();
  store.failCas = 1;
  const physical = new Set<string>();
  const replayed: string[] = [];
  const base = fixture();
  const original = base.owners.stopLiveTurnAndDetachRoute;
  base.owners.stopLiveTurnAndDetachRoute = async (id) => {
    const key = `stop:${id.sessionId}:${id.deleteRequestId}`;
    if (physical.has(key)) replayed.push(key);
    physical.add(key);
    return original(id);
  };
  await expect(new AgentDeletionCoordinator(store, base.owners, () => 1).deleteSession(identity)).rejects.toThrow("crash");
  store.failCas = undefined;
  await new AgentDeletionCoordinator(store, base.owners, () => 2).deleteSession(identity);
  expect(physical.size).toBe(1);
  expect(replayed).toEqual([`stop:${identity.sessionId}:${identity.deleteRequestId}`]);
});

test("all-settles Hosts, durably retains partial receipts, and retries only unresolved targets", async () => {
  const hosts: AgentDeletionHostTarget[] = [
    { hostId: "host-a", ledgerState: "active", generationId: "gen-1", runGeneration: 1 },
    { hostId: "host-b", ledgerState: "draining", generationId: "gen-2", runGeneration: 2 },
    { hostId: "host-c", ledgerState: "blocked", generationId: "gen-3", runGeneration: 3 },
  ];
  const store = new MemoryStore();
  const first = fixture({ hosts });
  first.owners.deleteFromHost = async ({ target, ...id }) => {
    first.calls.push(`host:${target.hostId}`);
    if (target.hostId === "host-b") throw new Error("host-b unavailable");
    return hostReceipt(target, id);
  };
  const coordinator = new AgentDeletionCoordinator(store, first.owners, () => 10);
  await expect(coordinator.deleteSession(identity)).rejects.toThrow("host-b unavailable");
  expect(first.calls).toEqual(["stop", "enumerate", "host:host-a", "host:host-b", "host:host-c"]);
  expect(store.record?.hostReceipts?.map(({ hostId }) => hostId)).toEqual(["host-a", "host-c"]);
  expect(coordinator.readiness(store.record)).toEqual({
    ready: false, retryable: true, failedPhase: "delete_hosts",
  });

  const recovery = fixture({ hosts });
  await new AgentDeletionCoordinator(store, recovery.owners, () => 20).deleteSession(identity);
  expect(recovery.calls.filter((call) => call.startsWith("host:"))).toEqual(["host:host-b"]);
});

test("rejects malformed, accessor, Proxy, and secret-bearing evidence snapshots", async () => {
  const variants: Array<() => unknown> = [
    () => ({ ...ownerReceipt("stop_and_detach"), secret: "prompt" }),
    () => {
      const value = ownerReceipt("stop_and_detach") as Record<string, unknown>;
      Object.defineProperty(value, "digest", { get: () => digest(), enumerable: true });
      return value;
    },
    () => new Proxy(ownerReceipt("stop_and_detach"), {}),
    () => ({ ...ownerReceipt("stop_and_detach"), digest: "raw-secret" }),
  ];
  for (const make of variants) {
    const store = new MemoryStore();
    const { owners } = fixture();
    owners.stopLiveTurnAndDetachRoute = async () => make() as never;
    await expect(new AgentDeletionCoordinator(store, owners, () => 1).deleteSession(identity))
      .rejects.toBeInstanceOf(AgentDeletionReceiptError);
    expect(JSON.stringify(store.record)).not.toContain("prompt");
    expect(JSON.stringify(store.record)).not.toContain("raw-secret");
  }
});

test("authoritative all-pin verification must bind full Host/generation/run-generation set", async () => {
  const hosts: AgentDeletionHostTarget[] = [
    { hostId: "host-a", ledgerState: "active", generationId: "gen", runGeneration: 1 },
    { hostId: "host-a", ledgerState: "draining", generationId: "gen", runGeneration: 2 },
  ];
  const store = new MemoryStore();
  const { owners } = fixture({ hosts });
  owners.verifyHostDeletionAndReleasePins = async ({ pins, hostReceipts, ...id }) => ({
    schemaVersion: 1,
    ...id,
    phase: "verify_and_release_pins",
    digest: digest("f"),
    pins: pins.slice(0, 1),
    hostReceipts,
  });
  await expect(new AgentDeletionCoordinator(store, owners, () => 1).deleteSession(identity))
    .rejects.toThrow("full owner set");
  expect(store.record?.phase).toBe("verify_and_release_pins");
});

test("all-settles gateway owners and recovers readiness without repeating prior phases", async () => {
  const store = new MemoryStore();
  const first = fixture({ fail: "registries" });
  const coordinator = new AgentDeletionCoordinator(store, first.owners, () => 1);
  await expect(coordinator.deleteSession(identity)).rejects.toThrow();
  expect(first.calls).toContain("ledger");
  expect(coordinator.readiness(store.record)).toEqual({
    ready: false, retryable: true, failedPhase: "settle_gateway",
  });
  const recovery = fixture();
  await new AgentDeletionCoordinator(store, recovery.owners, () => 2).deleteSession(identity);
  expect(recovery.calls).toEqual(["registries", "ledger", "release", "transcript", "kernel"]);
});

test("recovers a current-schema pre-kernel checkpoint and applies retention policy", async () => {
  const store = new MemoryStore();
  const phases = AGENT_DELETION_PHASES.slice(0, -2) as readonly ActivePhase[];
  store.record = {
    schemaVersion: AGENT_DELETION_SCHEMA_VERSION,
    revision: phases.length,
    ...identity,
    createdAtMs: 1,
    updatedAtMs: 2,
    phase: "finish_kernel",
    receipts: phases.map((phase) => ({
      phase,
      completedAtMs: 2,
      evidenceDigests: phase === "settle_gateway" ? [digest(), digest("b")]
        : phase === "delete_hosts" ? [] : [digest()],
    })),
    enumeration: { pins: [], hosts: [] },
    hostReceipts: [],
  };
  const { calls, owners } = fixture();
  const now = 20 * 24 * 60 * 60 * 1_000;
  const coordinator = new AgentDeletionCoordinator(store, owners, () => now);
  await coordinator.deleteSession(identity);
  expect(calls).toEqual(["kernel"]);
  await coordinator.cleanupExpiredSuccesses();
  expect(store.cleanupBefore).toBe(now - AGENT_DELETION_RECEIPT_RETENTION_MS);
});

test("rejects an exact-schema record for a different delete request", async () => {
  const store = new MemoryStore();
  const { owners } = fixture();
  await new AgentDeletionCoordinator(store, owners, () => 1).deleteSession(identity);
  await expect(new AgentDeletionCoordinator(store, owners, () => 2).deleteSession({
    ...identity, deleteRequestId: "different",
  })).rejects.toBeInstanceOf(AgentDeletionReceiptError);
});
