import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as journal from "./run-journal";
import * as privateJournal from "./personal-run-journal";
import * as authority from "./personal-run-consumers";
import * as kernel from "./session-kernel/kernel";
import * as atomicWrite from "./shared/atomic-write";
import { SessionKernelStore } from "./session-kernel/store";
import { personalRepositoryId } from "./personal-repository-coordinator";
import type { PersonalRunConsumer } from "./personal-run-consumers";
import type { ActiveRunRecord } from "./run-journal";

const ACTIVE = "personal_active_runs_v1";
let dir: string;
let path: string;
let previous: string;
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let retired: Set<string>;
let confirmed: Set<string>;
let retiredSpy: ReturnType<
  typeof spyOn<typeof authority, "personalRunRetired">
>;
let confirmedSpy: ReturnType<
  typeof spyOn<typeof authority, "personalRunRetirementConfirmed">
>;
const transition = async () => {};

function consumer(): PersonalRunConsumer {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: 41,
    repositoryOwnerGithubAccountId: 41,
    appRecordId: "app-original",
    githubAppId: 101,
    installationId: 201,
    repositoryId: 301,
    accessRevision: 1,
    fullName: "fixture/private",
  };
  return {
    runKey: `dispatch-${crypto.randomUUID()}`,
    hostId: "rh-original",
    sessionId: "session-original",
    binding: { registryId: personalRepositoryId(descriptor), descriptor },
  };
}
function record(c: PersonalRunConsumer): ActiveRunRecord {
  return {
    runKey: c.runKey,
    osSessionId: c.sessionId,
    hostId: c.hostId,
    personalRepo: c.binding,
    cwd: "/fixture/worktree",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}
async function storedRow(runKey: string) {
  return kernel.sessionCatalogDocument({
    op: "get",
    namespace: ACTIVE,
    key: runKey,
  });
}
async function seedRow(r: ActiveRunRecord) {
  const result = await kernel.sessionCatalogDocument({
    op: "put",
    namespace: ACTIVE,
    key: r.runKey,
    expectedRev: null,
    value: JSON.stringify(r),
    requestId: crypto.randomUUID(),
  });
  if (result.status !== "committed") throw new Error("seed failed");
  return result.rev;
}
const sharedFileExists = () => fs.existsSync(path);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "personal-journal-"));
  path = join(dir, "active-runs.json");
  previous = journal.__setActiveRunsPathForTest(path);
  store = new SessionKernelStore(join(dir, "kernel.sqlite"));
  previousStore = kernel.__setSessionKernelStoreForTest(store);
  privateJournal.__resetPersonalRunJournalForTest();
  retired = new Set();
  confirmed = new Set();
  retiredSpy = spyOn(authority, "personalRunRetired").mockImplementation(
    async (c) => retired.has(authority.personalRunConsumerKey(c)),
  );
  confirmedSpy = spyOn(
    authority,
    "personalRunRetirementConfirmed",
  ).mockImplementation(async (c) =>
    confirmed.has(authority.personalRunConsumerKey(c)),
  );
});
afterEach(async () => {
  retiredSpy.mockRestore();
  confirmedSpy.mockRestore();
  journal.__setActiveRunsPathForTest(previous);
  privateJournal.__resetPersonalRunJournalForTest();
  kernel.__setSessionKernelStoreForTest(previousStore);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("journal builder copies the original private binding, not a mutable caller alias", () => {
  const c = consumer();
  const built = journal.buildRunJournalRecord(
    { personalRepo: c.binding },
    {
      runKey: c.runKey,
      hostId: c.hostId,
      osSessionId: c.sessionId,
      cwd: "/fixture",
    },
  );
  expect(built.personalRepo).toEqual(c.binding);
  expect(built.personalRepo).not.toBe(c.binding);
  expect(built.personalRepo?.descriptor).not.toBe(c.binding.descriptor);
});

test("private gateway records live in the catalog and never touch the shared file", async () => {
  const c = consumer();
  const r = record(c);
  const readSpy = spyOn(fs, "readFileSync");
  const existsSpy = spyOn(fs, "existsSync");
  const writeSpy = spyOn(atomicWrite, "writeJsonAtomic");
  try {
    // Cold registration, warm re-registration, recovery, attachment, clear:
    // none of them may touch the shared file or any synchronous fs API.
    await journal.journalSet(r, transition);
    await journal.journalSet({ ...r, claudeSessionId: "engine-1" }, transition);
    const recovered = await journal.journalStartRecoveryIfCurrent(r);
    expect(recovered?.resumeAttempts).toBe(1);
    expect(recovered?.claimedAt).toBeUndefined();
    expect(await journal.journalMarkRecoveryAttachedAsync(r)).toMatchObject({
      resumeAttempts: 0,
    });
    expect(journal.hasActiveRunFor(c.runKey, c.sessionId)).toBe(true);
    expect(await journal.journalClearIfLineageAsync(r)).toBe(true);
    expect((await storedRow(c.runKey))?.value).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(sharedFileExists()).toBe(false);
    // Positive control: the shared half of a snapshot still reads its file,
    // which proves the spies observe this module's fs calls.
    existsSpy.mockClear();
    await writeFile(
      path,
      JSON.stringify({
        shared: { runKey: "shared", cwd: "/fixture", startedAt: "now" },
      }),
    );
    expect(journal.activeRunRecords().map((x) => x.runKey)).toEqual(["shared"]);
    expect(existsSpy).toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalled();
  } finally {
    existsSpy.mockRestore();
    readSpy.mockRestore();
    writeSpy.mockRestore();
  }
});

test("private rows in the shared file are ignored evidence, not owners", async () => {
  const c = consumer();
  await writeFile(path, JSON.stringify({ [c.runKey]: record(c) }));
  expect(journal.activeRunRecords()).toEqual([]);
  expect(journal.hasActiveRunFor(c.runKey)).toBe(false);
  await journal.journalSet(
    { runKey: "shared", cwd: "/fixture", startedAt: "now" },
    transition,
  );
  expect(Object.keys(JSON.parse(await readFile(path, "utf8")))).toEqual([
    "shared",
  ]);
});

test("a detached host journal keeps private records in its own file without the catalog", async () => {
  const c = consumer();
  const r = record(c);
  const hostPath = join(dir, "host-journal.json");
  process.env.OPENSESSION_RUN_JOURNAL = hostPath;
  const hostPrevious = journal.__setActiveRunsPathForTest(hostPath);
  kernel.__setSessionKernelStoreForTest(undefined);
  const catalogSpy = spyOn(kernel, "sessionCatalogDocument");
  try {
    await journal.journalSet(r, transition);
    expect(
      JSON.parse(await readFile(hostPath, "utf8"))[c.runKey],
    ).toBeDefined();
    expect(journal.activeRunRecords()[0]?.personalRepo).toEqual(c.binding);
    expect(journal.hasActiveRunFor(c.runKey)).toBe(true);
    expect(journal.journalClearIfLineage(r)).toBe(true);
    journal.journalClear(c.runKey);
    expect(catalogSpy).not.toHaveBeenCalled();
    await expect(journal.suppressRetiredPersonalRun(c)).rejects.toThrow(
      "detached host",
    );
  } finally {
    catalogSpy.mockRestore();
    delete process.env.OPENSESSION_RUN_JOURNAL;
    journal.__setActiveRunsPathForTest(hostPrevious);
    kernel.__setSessionKernelStoreForTest(store);
  }
});

test("production reads fail closed until one complete successful hydration", async () => {
  const c = consumer();
  const r = record(c);
  await seedRow(r);
  privateJournal.__resetPersonalRunJournalForTest();
  const env = process.env.NODE_ENV;
  Reflect.set(process.env, "NODE_ENV", "production");
  const catalogSpy = spyOn(kernel, "sessionCatalogDocument");
  try {
    expect(() => journal.activeRunRecords()).toThrow("not hydrated");
    expect(() => journal.hasActiveRunFor(c.runKey)).toThrow("not hydrated");
    // Outside tests the kernel actor answers; here the page op is routed to
    // the isolated store so a production-mode hydration can be observed.
    let page = 0;
    catalogSpy.mockImplementation(async (request) => {
      if (request.op !== "page_live")
        throw new Error(`unexpected ${request.op}`);
      // The first attempt fails after a partial page: readiness must not
      // publish a partial projection.
      if (++page === 1) throw new Error("kernel unavailable");
      // SAFETY: the page_live op result type is CatalogDocumentRecord[], which
      // is what the store returns; the generic result cannot be inferred here.
      return store.catalogDocumentPageLive(
        request.namespace,
        request.afterKey,
        request.limit,
      ) as never;
    });
    await expect(journal.ensurePersonalRunJournalReady()).rejects.toThrow(
      "kernel unavailable",
    );
    expect(journal.personalRunJournalReady()).toBe(false);
    expect(() => journal.activeRunRecords()).toThrow("not hydrated");
    await journal.ensurePersonalRunJournalReady();
    expect(journal.personalRunJournalReady()).toBe(true);
    expect(journal.activeRunRecords()[0]?.hostId).toBe(c.hostId);
    expect(journal.hasActiveRunFor(c.sessionId)).toBe(true);
  } finally {
    catalogSpy.mockRestore();
    Reflect.set(process.env, "NODE_ENV", env);
  }
});

test("hydration reads every page of active private work without a cap", async () => {
  const keys: string[] = [];
  for (let i = 0; i < 2_150; i++) {
    const c = {
      ...consumer(),
      runKey: `dispatch-${String(i).padStart(5, "0")}`,
    };
    keys.push(c.runKey);
    await seedRow(record(c));
  }
  privateJournal.__resetPersonalRunJournalForTest();
  await journal.ensurePersonalRunJournalReady();
  expect(journal.activeRunRecords()).toHaveLength(keys.length);
  expect(journal.hasActiveRunFor(keys.at(-1))).toBe(true);
});

test("hydration pages only live rows: many tombstones, few active", async () => {
  const live: string[] = [];
  for (let i = 0; i < 2_400; i++) {
    const c = {
      ...consumer(),
      runKey: `dispatch-${String(i).padStart(5, "0")}`,
    };
    const rev = await seedRow(record(c));
    if (i % 800 === 5) {
      live.push(c.runKey);
      continue;
    }
    await kernel.sessionCatalogDocument({
      op: "put",
      namespace: ACTIVE,
      key: c.runKey,
      expectedRev: rev,
      value: null,
      requestId: crypto.randomUUID(),
    });
  }
  privateJournal.__resetPersonalRunJournalForTest();
  const ops: string[] = [];
  const catalogSpy = spyOn(kernel, "sessionCatalogDocument");
  const real = catalogSpy.getMockImplementation();
  catalogSpy.mockImplementation(async (request) => {
    ops.push(request.op);
    // SAFETY: the spy forwards to the real implementation captured above.
    return real!(request) as never;
  });
  try {
    await journal.ensurePersonalRunJournalReady();
  } finally {
    catalogSpy.mockRestore();
  }
  // Three live rows fit one page; the second page is the empty terminator.
  expect(ops).toEqual(["page_live", "page_live"]);
  expect(
    journal
      .activeRunRecords()
      .map((r) => r.runKey)
      .sort(),
  ).toEqual(live);
});

test("an unreadable stored row fails hydration closed until it is repaired", async () => {
  const c = consumer();
  const readable = consumer();
  await seedRow(record(readable));
  const put = await kernel.sessionCatalogDocument({
    op: "put",
    namespace: ACTIVE,
    key: c.runKey,
    expectedRev: null,
    value: JSON.stringify({ runKey: c.runKey, personalRepo: c.binding }),
    requestId: crypto.randomUUID(),
  });
  expect(put.status).toBe("committed");
  privateJournal.__resetPersonalRunJournalForTest();
  // The row's session mapping is lost with it, so a projection without it
  // would report that session idle: readiness is refused, naming the row.
  await expect(journal.ensurePersonalRunJournalReady()).rejects.toThrow(
    c.runKey,
  );
  expect(journal.personalRunJournalReady()).toBe(false);
  await expect(
    journal.takeInterruptedRuns([], () => true, transition),
  ).rejects.toThrow(c.runKey);
  // Production sync reads stay closed while the projection is unready.
  const env = process.env.NODE_ENV;
  Reflect.set(process.env, "NODE_ENV", "production");
  try {
    expect(() => journal.hasActiveRunFor(readable.runKey)).toThrow(
      "not hydrated",
    );
    expect(() => journal.activeRunRecords()).toThrow("not hydrated");
  } finally {
    Reflect.set(process.env, "NODE_ENV", env);
  }
  // The evidence is never erased by the failed hydration.
  const stored = await storedRow(c.runKey);
  expect(stored?.value).not.toBeNull();
  // A retry without repair fails the same way.
  await expect(journal.ensurePersonalRunJournalReady()).rejects.toThrow(
    c.runKey,
  );
  // Operator repair (here: a tombstone of the malformed row) plus retry
  // publishes a complete projection with every readable row.
  const repaired = await kernel.sessionCatalogDocument({
    op: "put",
    namespace: ACTIVE,
    key: c.runKey,
    expectedRev: stored?.rev ?? null,
    value: null,
    requestId: crypto.randomUUID(),
  });
  expect(repaired.status).toBe("committed");
  await journal.ensurePersonalRunJournalReady();
  expect(journal.personalRunJournalReady()).toBe(true);
  expect(journal.activeRunRecords().map((r) => r.runKey)).toEqual([
    readable.runKey,
  ]);
  expect(journal.hasActiveRunFor(c.runKey)).toBe(false);
  expect(sharedFileExists()).toBe(false);
});

test("a confirmed suppression is forgotten once durable and retained while its tombstone fails", async () => {
  const first = consumer();
  await journal.journalSet(record(first), transition);
  const firstKey = authority.personalRunConsumerKey(first);
  confirmed.add(firstKey);
  await journal.suppressRetiredPersonalRun(first);
  expect(privateJournal.__personalRunJournalConfirmedForTest()).toEqual([]);
  expect(journal.hasActiveRunFor(first.runKey)).toBe(false);
  // Durably tombstoned: a cold rehydration cannot bring it back.
  privateJournal.__resetPersonalRunJournalForTest();
  await journal.ensurePersonalRunJournalReady();
  expect(journal.hasActiveRunFor(first.runKey)).toBe(false);

  const second = consumer();
  await journal.journalSet(record(second), transition);
  const secondKey = authority.personalRunConsumerKey(second);
  confirmed.add(secondKey);
  const catalogSpy = spyOn(kernel, "sessionCatalogDocument");
  const real = catalogSpy.getMockImplementation();
  catalogSpy.mockImplementation(async (request) => {
    if (request.op === "put") throw new Error("kernel unavailable");
    // SAFETY: the spy forwards every read to the real implementation.
    return real!(request) as never;
  });
  try {
    await expect(journal.suppressRetiredPersonalRun(second)).rejects.toThrow(
      "kernel unavailable",
    );
  } finally {
    catalogSpy.mockRestore();
  }
  // Suppressed in memory, obligation retained until the tombstone lands.
  expect(privateJournal.__personalRunJournalConfirmedForTest()).toEqual([
    secondKey,
  ]);
  expect(journal.hasActiveRunFor(second.runKey)).toBe(false);
  expect((await storedRow(second.runKey))?.value).not.toBeNull();
  await journal.suppressRetiredPersonalRun(second);
  expect(privateJournal.__personalRunJournalConfirmedForTest()).toEqual([]);
  expect((await storedRow(second.runKey))?.value).toBeNull();
  // A successor under the same alias never inherits the old obligation.
  const successor = record({ ...second, hostId: "rh-successor" });
  await journal.journalSet(successor, transition);
  expect(journal.hasActiveRunFor(second.runKey)).toBe(true);
  expect(privateJournal.__personalRunJournalConfirmedForTest()).toEqual([]);
});

test("synchronous legacy helpers refuse a private owner instead of touching it", async () => {
  const c = consumer();
  const r = record(c);
  await journal.journalSet(r, transition);
  expect(() => journal.journalClear(c.runKey)).toThrow("asynchronous");
  expect(() => journal.journalClearIfLineage(r)).toThrow("asynchronous");
  expect(() => journal.journalMarkRecoveryAttached(r)).toThrow("asynchronous");
  expect(() => journal.journalStartRecovery(r)).toThrow("asynchronous");
  expect(() =>
    journal.journalQuarantine([
      { run: r, reason: "recovery_expired", notify: false },
    ]),
  ).toThrow("asynchronous");
  expect(() =>
    journal.journalRetireCancelledAbnormalAfterSettlement(
      c.sessionId,
      c.runKey,
    ),
  ).toThrow("asynchronous");
  expect(journal.activeRunRecords()[0]?.hostId).toBe(c.hostId);
  expect(sharedFileExists()).toBe(false);
});

test("pending no-relaunch intent blocks recovery but retains busy and catalog evidence", async () => {
  const c = consumer();
  const r = record(c);
  await journal.journalSet(r, transition);
  retired.add(authority.personalRunConsumerKey(c));
  expect(await journal.journalPersonalRunRetired(r)).toBe(true);
  expect(journal.hasActiveRunFor(c.runKey)).toBe(true);
  expect(journal.activeRunRecords()).toHaveLength(1);
  await expect(journal.suppressRetiredPersonalRun(c)).rejects.toThrow(
    "unconfirmed",
  );
  expect(await journal.journalStartRecoveryIfCurrent(r)).toBeUndefined();
  await expect(journal.journalSet(r, transition)).rejects.toThrow("retired");
  expect((await storedRow(c.runKey))?.value).not.toBeNull();
});

test("confirmed exact retirement suppresses busy evidence and tombstones only its own row", async () => {
  const c = consumer();
  await journal.journalSet(record(c), transition);
  const key = authority.personalRunConsumerKey(c);
  retired.add(key);
  confirmed.add(key);
  await journal.suppressRetiredPersonalRun(c);
  expect(journal.hasActiveRunFor(c.runKey, c.sessionId)).toBe(false);
  expect(journal.activeRunRecords()).toEqual([]);
  expect((await storedRow(c.runKey))?.value).toBeNull();
  expect(sharedFileExists()).toBe(false);
});

test("old retirement and lineage cleanup cannot clear a successor using the same run alias", async () => {
  const old = consumer();
  const oldRecord = record(old);
  const successor = { ...old, hostId: "rh-successor" };
  await journal.journalSet(record(successor), transition);
  const key = authority.personalRunConsumerKey(old);
  retired.add(key);
  confirmed.add(key);
  await journal.suppressRetiredPersonalRun(old);
  expect(journal.hasActiveRunFor(old.runKey)).toBe(true);
  expect(await journal.journalClearIfLineageAsync(oldRecord)).toBe(false);
  expect(
    await journal.journalMarkRecoveryAttachedAsync(oldRecord),
  ).toBeUndefined();
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
  expect((await storedRow(old.runKey))?.value).toContain("rh-successor");
});

test("cold boot consults durable retirement even without any process-local suppression", async () => {
  const c = consumer();
  const r = record(c);
  await seedRow(r);
  privateJournal.__resetPersonalRunJournalForTest();
  const key = authority.personalRunConsumerKey(c);
  retired.add(key);
  confirmed.add(key);
  expect(await journal.takeInterruptedRuns([], () => true, transition)).toEqual(
    [],
  );
  expect(journal.hasActiveRunFor(c.runKey)).toBe(false);
  expect(retiredSpy).toHaveBeenCalled();
  expect((await storedRow(c.runKey))?.value).toBeNull();
});

test("boot claims a private record by compare-and-set and hands it out once", async () => {
  const c = consumer();
  const r = record(c);
  await seedRow(r);
  privateJournal.__resetPersonalRunJournalForTest();
  const taken = await journal.takeInterruptedRuns([], () => true, transition);
  expect(taken.map((x) => x.runKey)).toEqual([c.runKey]);
  expect(taken[0]?.claimedAt).toBeUndefined();
  expect(
    JSON.parse((await storedRow(c.runKey))!.value!).claimedAt,
  ).toBeString();
  expect(await journal.takeInterruptedRuns([], () => true, transition)).toEqual(
    [],
  );
  expect(sharedFileExists()).toBe(false);
});

test("a shutdown-snapshot seed folds into the private boot claim without journalSet", async () => {
  const c = consumer();
  const r = record(c);
  const taken = await journal.takeInterruptedRuns([r], () => true, transition);
  expect(taken.map((x) => x.runKey)).toEqual([c.runKey]);
  const stored = JSON.parse((await storedRow(c.runKey))!.value!);
  expect(stored.firstJournaledAt).toBe(r.startedAt);
  expect(stored.claimedAt).toBeString();
  const successor = record({ ...c, hostId: "rh-successor" });
  await journal.journalSet(successor, transition, { replaces: c });
  // A later seed of the old host never overwrites the live successor.
  await journal.takeInterruptedRuns([r], () => true, transition);
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
});

test("unknown authority rejects recovery and leaves original evidence intact", async () => {
  const c = consumer();
  const r = record(c);
  await journal.journalSet(r, transition);
  retiredSpy.mockImplementation(async () => {
    throw new Error("catalog unavailable");
  });
  await expect(journal.journalStartRecoveryIfCurrent(r)).rejects.toThrow(
    "catalog unavailable",
  );
  await expect(
    journal.takeInterruptedRuns([], () => true, transition),
  ).rejects.toThrow("catalog unavailable");
  expect(journal.activeRunRecords()[0]?.hostId).toBe(c.hostId);
});

test("an old queued recovery cannot overwrite a successor after its authority await", async () => {
  const c = consumer();
  const old = record(c);
  await journal.journalSet(old, transition);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<boolean>();
  retiredSpy.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const pending = journal.journalStartRecoveryIfCurrent(old);
  await entered.promise;
  await journal.journalSet(
    record({ ...c, hostId: "rh-successor" }),
    transition,
    { replaces: c },
  );
  gate.resolve(false);
  await expect(pending).rejects.toThrow("ownership changed");
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
});

test("boot claim merges concurrent sole-writer updates rather than rewriting an old snapshot", async () => {
  const c = consumer();
  await journal.journalSet(record(c), transition);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<boolean>();
  const pending = journal.takeInterruptedRuns(
    [],
    async () => {
      entered.resolve();
      return gate.promise;
    },
    transition,
  );
  await entered.promise;
  await journal.journalSet(
    record({ ...c, hostId: "rh-successor" }),
    transition,
    { replaces: c },
  );
  await journal.journalSet(
    { runKey: "unrelated", cwd: "/unrelated", startedAt: "now" },
    transition,
  );
  gate.resolve(true);
  expect(await pending).toEqual([]);
  expect(journal.activeRunRecords().map((r) => r.runKey)).toContain(
    "unrelated",
  );
  expect(
    journal.activeRunRecords().find((r) => r.runKey === c.runKey)?.hostId,
  ).toBe("rh-successor");
  expect(
    JSON.parse((await storedRow(c.runKey))!.value!).claimedAt,
  ).toBeUndefined();
});

test("a row committed by another writer is adopted before any guard decides", async () => {
  const c = consumer();
  const old = record(c);
  await journal.journalSet(old, transition);
  const current = await storedRow(c.runKey);
  const successor = record({ ...c, hostId: "rh-successor" });
  // Simulate the previous gateway generation committing during handoff: this
  // process's projection still holds the old row and revision.
  await kernel.sessionCatalogDocument({
    op: "put",
    namespace: ACTIVE,
    key: c.runKey,
    expectedRev: current!.rev,
    value: JSON.stringify(successor),
    requestId: crypto.randomUUID(),
  });
  expect(await journal.journalClearIfLineageAsync(old)).toBe(false);
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
  expect(await journal.journalClearIfLineageAsync(successor)).toBe(true);
  expect(journal.activeRunRecords()).toEqual([]);
});

test("an unreadable row adopted from a conflicting writer withdraws readiness", async () => {
  const c = consumer();
  const other = consumer();
  const old = record(c);
  await journal.journalSet(old, transition);
  await journal.journalSet(record(other), transition);
  const current = await storedRow(c.runKey);
  // A previous gateway generation commits text this process cannot read.
  await kernel.sessionCatalogDocument({
    op: "put",
    namespace: ACTIVE,
    key: c.runKey,
    expectedRev: current!.rev,
    value: JSON.stringify({ runKey: c.runKey, personalRepo: c.binding }),
    requestId: crypto.randomUUID(),
  });
  await expect(journal.journalClearIfLineageAsync(old)).rejects.toThrow(
    c.runKey,
  );
  // Not a key-only exception: the whole projection is withdrawn, so the
  // readable row cannot be reported alone and production reads fail closed.
  expect(journal.personalRunJournalReady()).toBe(false);
  const env = process.env.NODE_ENV;
  Reflect.set(process.env, "NODE_ENV", "production");
  try {
    expect(() => journal.hasActiveRunFor(other.runKey)).toThrow("not hydrated");
    expect(() => journal.activeRunRecords()).toThrow("not hydrated");
  } finally {
    Reflect.set(process.env, "NODE_ENV", env);
  }
  // Rehydration rejects on the same row, which is never erased.
  await expect(journal.ensurePersonalRunJournalReady()).rejects.toThrow(
    c.runKey,
  );
  const stored = await storedRow(c.runKey);
  expect(stored?.value).toContain(c.runKey);
  // Repair (a valid rewrite by the operator) plus rehydration restores a
  // complete projection with both rows.
  const repaired = await kernel.sessionCatalogDocument({
    op: "put",
    namespace: ACTIVE,
    key: c.runKey,
    expectedRev: stored!.rev,
    value: JSON.stringify(old),
    requestId: crypto.randomUUID(),
  });
  expect(repaired.status).toBe("committed");
  await journal.ensurePersonalRunJournalReady();
  expect(journal.personalRunJournalReady()).toBe(true);
  expect(
    journal
      .activeRunRecords()
      .map((r) => r.runKey)
      .sort(),
  ).toEqual([c.runKey, other.runKey].sort());
  expect(await journal.journalClearIfLineageAsync(old)).toBe(true);
});

test("malformed original private identity cannot silently become shared recovery", async () => {
  const r = record(consumer());
  delete r.hostId;
  await expect(journal.journalPersonalRunRetired(r)).rejects.toThrow(
    "original host identity",
  );
});

test("cold suppression does not mistake an unhydrated journal cache for no other runs", async () => {
  const c = consumer();
  await seedRow(record(c));
  await writeFile(
    path,
    JSON.stringify({
      unrelated: { runKey: "unrelated", cwd: "/fixture", startedAt: "now" },
    }),
  );
  privateJournal.__resetPersonalRunJournalForTest();
  confirmed.add(authority.personalRunConsumerKey(c));
  await journal.suppressRetiredPersonalRun(c);
  expect(journal.hasActiveRunFor("unrelated")).toBe(true);
  expect(journal.hasActiveRunFor(c.runKey)).toBe(false);
});

test("logical stop intent blocks another incarnation without claiming it physically absent", async () => {
  const old = consumer();
  const incarnation = { ...old, hostId: "rh-next-incarnation" };
  await journal.journalSet(record(incarnation), transition);
  retiredSpy.mockImplementation(async (c) => c.runKey === old.runKey);
  confirmed.add(authority.personalRunConsumerKey(old));
  await journal.suppressRetiredPersonalRun(old);
  expect(await journal.journalPersonalRunRetired(record(incarnation))).toBe(
    true,
  );
  expect(journal.hasActiveRunFor(old.runKey)).toBe(true);
  expect(journal.activeRunRecords()[0]?.hostId).toBe(incarnation.hostId);
  expect(
    await journal.journalStartRecoveryIfCurrent(record(incarnation)),
  ).toBeUndefined();
  expect((await storedRow(old.runKey))?.value).toContain("rh-next-incarnation");
});

test("a changed binding revision sharing aliases is not suppressed by the old proof", async () => {
  const old = consumer();
  const next = {
    ...old,
    binding: {
      ...old.binding,
      descriptor: { ...old.binding.descriptor, accessRevision: 2 },
    },
  };
  await journal.journalSet(record(next), transition);
  confirmed.add(authority.personalRunConsumerKey(old));
  await journal.suppressRetiredPersonalRun(old);
  expect(journal.hasActiveRunFor(old.runKey)).toBe(true);
  expect(await journal.journalClearIfLineageAsync(record(old))).toBe(false);
  expect(
    journal.activeRunRecords()[0]?.personalRepo?.descriptor.accessRevision,
  ).toBe(2);
});

test("journal builder refuses conflicting original bindings rather than upgrading identity", () => {
  const c = consumer();
  expect(() =>
    journal.buildRunJournalRecord(
      { personalRepo: c.binding },
      {
        ...record(c),
        personalRepo: {
          ...c.binding,
          descriptor: { ...c.binding.descriptor, accessRevision: 2 },
        },
      },
    ),
  ).toThrow("binding changed");
});

test("journal binding is a nonsecret allowlist rather than an arbitrary object spread", () => {
  const c = consumer();
  const binding = {
    ...c.binding,
    token: "fixture-only-do-not-copy",
    descriptor: {
      ...c.binding.descriptor,
      credential: "fixture-only-do-not-copy",
    },
  };
  const built = journal.buildRunJournalRecord(
    { personalRepo: binding },
    {
      runKey: c.runKey,
      cwd: "/fixture",
    },
  );
  expect(built.personalRepo).toEqual(c.binding);
  expect(JSON.stringify(built)).not.toContain("fixture-only-do-not-copy");
});

test("late private journal admission cannot overwrite a newer physical owner", async () => {
  const c = consumer();
  await journal.journalSet(record(c), transition);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<boolean>();
  retiredSpy.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const pending = journal.journalSet(
    { ...record(c), claudeSessionId: "late-engine-id" },
    transition,
  );
  await entered.promise;
  await journal.journalSet(
    record({ ...c, hostId: "rh-successor" }),
    transition,
    { replaces: c },
  );
  gate.resolve(false);
  await expect(pending).rejects.toThrow("ownership changed during admission");
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
});

test("a predecessor registration that reaches the journal after its successor committed cannot roll it back", async () => {
  const c = consumer();
  const successor = { ...c, hostId: "rh-successor" };
  await journal.journalSet(record(c), transition);
  await journal.journalSet(record(successor), transition, { replaces: c });
  // The old host's event handler was captured before the checkpoint and only
  // now calls the journal: the committed row names another physical consumer.
  await expect(
    journal.journalSet(
      { ...record(c), claudeSessionId: "late-engine-id" },
      transition,
    ),
  ).rejects.toThrow("ownership changed");
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
  expect(journal.activeRunRecords()[0]?.claudeSessionId).toBeUndefined();
  // The successor's own updates still land without naming anyone.
  await journal.journalSet(
    { ...record(successor), claudeSessionId: "engine-b" },
    transition,
  );
  expect(journal.activeRunRecords()[0]?.claudeSessionId).toBe("engine-b");
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
});

test("a successor registration must name the exact predecessor it replaces", async () => {
  const c = consumer();
  const successor = { ...c, hostId: "rh-successor" };
  const other = { ...c, hostId: "rh-other" };
  await journal.journalSet(record(c), transition);
  await expect(
    journal.journalSet(record(successor), transition),
  ).rejects.toThrow("ownership changed");
  await expect(
    journal.journalSet(record(successor), transition, { replaces: other }),
  ).rejects.toThrow("ownership changed");
  await expect(
    journal.journalSet(record(successor), transition, {
      replaces: successor,
    }),
  ).rejects.toThrow("names the registering consumer");
  expect(journal.activeRunRecords()[0]?.hostId).toBe(c.hostId);
  await journal.journalSet(record(successor), transition, { replaces: c });
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
  // Once replaced, naming the old predecessor again is stale too.
  await expect(
    journal.journalSet(record(other), transition, { replaces: c }),
  ).rejects.toThrow("ownership changed");
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-successor");
  // Naming a predecessor whose row is already gone is harmless: the
  // registration simply creates the row.
  await journal.journalClearIfLineageAsync(record(successor));
  await journal.journalSet(record(other), transition, { replaces: successor });
  expect(journal.activeRunRecords()[0]?.hostId).toBe("rh-other");
});

test("private journal admission preserves unrelated writes made during its authority check", async () => {
  const c = consumer();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<boolean>();
  retiredSpy.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const pending = journal.journalSet(record(c), transition);
  await entered.promise;
  await journal.journalSet(
    { runKey: "unrelated", cwd: "/fixture", startedAt: "now" },
    transition,
  );
  gate.resolve(false);
  await pending;
  expect(
    journal
      .activeRunRecords()
      .map((r) => r.runKey)
      .sort(),
  ).toEqual([c.runKey, "unrelated"].sort());
});

test("stale shared journal callbacks cannot downgrade or adopt a private successor", async () => {
  const c = consumer();
  const r = record(c);
  const shared = { ...r, personalRepo: undefined };
  await journal.journalSet(r, transition);
  await expect(journal.journalSet(shared, transition)).rejects.toThrow(
    "binding changed",
  );
  expect(() => journal.journalStartRecovery(shared)).toThrow(
    "ownership changed",
  );
  expect(journal.journalClearIfLineage(shared)).toBe(false);
  expect(await journal.journalClearIfLineageAsync(shared)).toBe(false);
  expect(journal.journalMarkRecoveryAttached(shared)).toBeUndefined();
  expect(journal.activeRunRecords()[0]?.personalRepo).toEqual(c.binding);
  expect(sharedFileExists()).toBe(false);
});

test("private quarantine moves the row beside the live namespace while lineage matches", async () => {
  const c = consumer();
  const r = record(c);
  await journal.journalSet(r, transition);
  const successorKey = consumer();
  await journal.journalSet(record(successorKey), transition);
  await journal.journalSet(
    record({ ...successorKey, hostId: "rh-successor" }),
    transition,
    { replaces: successorKey },
  );
  await journal.journalQuarantineAsync([
    { run: r, reason: "recovery_expired", notify: false },
    { run: record(successorKey), reason: "recovery_expired", notify: false },
  ]);
  expect(journal.hasActiveRunFor(c.runKey)).toBe(false);
  expect(journal.activeRunRecords().map((x) => x.hostId)).toEqual([
    "rh-successor",
  ]);
  const quarantined = await privateJournal.personalRunQuarantine();
  expect(quarantined.map((q) => q.record.runKey).sort()).toEqual(
    [c.runKey, successorKey.runKey].sort(),
  );
  expect(quarantined[0]?.record).toMatchObject({
    quarantineReason: "recovery_expired",
  });
  expect(sharedFileExists()).toBe(false);
});

test("abnormal completion evidence retires only through the exact async owner", async () => {
  const c = consumer();
  const r = record(c);
  const failed = await journal.journalRecordAbnormalCompletion(r, "host gone");
  expect(journal.activeRunRecords()[0]?.terminalFailure?.content).toBe(
    "host gone",
  );
  expect(
    await journal.journalRetireCancelledAbnormalAfterSettlementAsync(
      "other-session",
      c.runKey,
      failed,
    ),
  ).toBe(false);
  // Session and alias alone never identify a private physical owner.
  expect(
    await journal.journalRetireCancelledAbnormalAfterSettlementAsync(
      c.sessionId,
      c.runKey,
    ),
  ).toBe(false);
  expect(journal.activeRunRecords()[0]?.terminalFailure?.content).toBe(
    "host gone",
  );
  expect(
    await journal.journalRetireCancelledAbnormalAfterSettlementAsync(
      c.sessionId,
      c.runKey,
      failed,
    ),
  ).toBe(true);
  expect(journal.activeRunRecords()).toEqual([]);
  expect(failed.personalRepo).toEqual(c.binding);
});

test("settlement of an old dispatch without its owner retains the successor's private terminal row", async () => {
  const c = consumer();
  const successor = { ...c, hostId: "rh-successor" };
  await journal.journalSet(record(c), transition);
  await journal.journalSet(record(successor), transition, { replaces: c });
  const failedB = await journal.journalRecordAbnormalCompletion(
    record(successor),
    "successor gone",
  );
  // The settlement executor only carries the session and the dispatch id of
  // the cancelled turn; it must not infer that the alias holder is that run.
  expect(
    await journal.journalRetireCancelledAbnormalAfterSettlementAsync(
      c.sessionId,
      c.runKey,
    ),
  ).toBe(false);
  expect(journal.activeRunRecords()[0]).toMatchObject({
    hostId: "rh-successor",
    terminalFailure: { content: "successor gone" },
  });
  expect(
    await journal.journalRetireCancelledAbnormalAfterSettlementAsync(
      c.sessionId,
      c.runKey,
      failedB,
    ),
  ).toBe(true);
  expect(journal.activeRunRecords()).toEqual([]);
});

test("a predecessor's abnormal completion never tombstones the successor's terminal row", async () => {
  const c = consumer();
  const successor = { ...c, hostId: "rh-successor" };
  await journal.journalSet(record(c), transition);
  await journal.journalSet(record(successor), transition, { replaces: c });
  const failedB = await journal.journalRecordAbnormalCompletion(
    record(successor),
    "successor gone",
  );
  expect(journal.activeRunRecords()[0]?.terminalFailure?.content).toBe(
    "successor gone",
  );
  // A's captured completion context arrives late: its registration is
  // refused before any retirement can run.
  await expect(
    journal.journalRecordAbnormalCompletion(record(c), "predecessor gone"),
  ).rejects.toThrow("ownership changed");
  // Even with a positively settled cancel, A's exact record cannot retire
  // B's evidence under the same session and run alias.
  const failedA: ActiveRunRecord = {
    ...record(c),
    terminalFailure: { type: "error", content: "predecessor gone", at: "t" },
  };
  expect(
    await journal.journalRetireCancelledAbnormalAfterSettlementAsync(
      c.sessionId,
      c.runKey,
      failedA,
    ),
  ).toBe(false);
  expect(journal.activeRunRecords()[0]).toMatchObject({
    hostId: "rh-successor",
    terminalFailure: { content: "successor gone" },
  });
  expect(
    await journal.journalRetireCancelledAbnormalAfterSettlementAsync(
      c.sessionId,
      c.runKey,
      failedB,
    ),
  ).toBe(true);
  expect(journal.activeRunRecords()).toEqual([]);
});
