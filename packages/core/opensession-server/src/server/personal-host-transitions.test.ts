import { expect, test } from "bun:test";
import { createPersonalHostTransitions } from "./personal-host-transitions";
import {
  personalRunLineageKey,
  type PersonalRunConsumer,
} from "./personal-run-consumers";
import { personalRepositoryId } from "./personal-repository-coordinator";
import type { RunHostSpec } from "../runner-host/protocol";
function consumer(
  host = "rh-019d2a5f-4ac8-7000-8000-123456789abc",
): PersonalRunConsumer {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: 41,
    appRecordId: "fixture",
    githubAppId: 1,
    installationId: 2,
    repositoryId: 3,
    repositoryOwnerGithubAccountId: 41,
    accessRevision: 1,
    fullName: "fixture/repo",
  };
  return {
    runKey: "logical-run",
    hostId: host,
    sessionId: "private",
    binding: { registryId: personalRepositoryId(descriptor), descriptor },
  };
}
function fixture() {
  const intents = new Set<string>();
  const records = new Map<string, RunHostSpec>();
  const log: string[] = [];
  let enrolled = true;
  const intentWritten = Promise.withResolvers<void>();
  const api = createPersonalHostTransitions({
    retired: async (c) => intents.has(personalRunLineageKey(c)),
    enrolled: async () => {
      if (!enrolled) throw new Error("unknown");
    },
    requestRetirement: async (c) => {
      intents.add(personalRunLineageKey(c));
      intentWritten.resolve();
    },
    spec: async (c) => {
      const spec = records.get(c.hostId);
      if (!spec) throw new Error("missing spec");
      return { spec, hash: "hash" };
    },
    stopPhysical: async (c, _hash, dispatch) => {
      log.push(`stop:${c.hostId}:${dispatch}`);
    },
  });
  function remember(c: PersonalRunConsumer) {
    records.set(c.hostId, {
      hostId: c.hostId,
      logicalRunId: c.runKey,
      osSessionId: c.sessionId,
      personalRepo: c.binding,
      prompt: "fixture",
      cwd: "/fixture",
    });
    api.remember(c, () => log.push(`retire:${c.hostId}`));
  }
  return {
    api,
    records,
    intents,
    log,
    remember,
    intentWritten,
    unknown: () => {
      enrolled = false;
    },
  };
}

test("stop does not wait for broker preparation and durable intent prevents later dispatch", async () => {
  const f = fixture(),
    c = consumer();
  f.remember(c);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const launch = f.api.dispatch(
    c,
    async () => {
      entered.resolve();
      await release.promise;
    },
    async () => {
      throw new Error("must never dispatch");
    },
  );
  await entered.promise;
  expect(await f.api.stop(c)).toEqual({ state: "absent", consumer: c });
  expect(f.log).toEqual([`stop:${c.hostId}:never`, `retire:${c.hostId}`]);
  release.resolve();
  await expect(launch).rejects.toThrow("retired");
});

test("stop waits for an already dispatched physical transition, then retires only its exact host", async () => {
  const f = fixture(),
    c = consumer();
  f.remember(c);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const launch = f.api.dispatch(
    c,
    async () => {},
    async () => {
      entered.resolve();
      await release.promise;
      f.log.push("launch settled");
    },
  );
  await entered.promise;
  const stop = f.api.stop(c);
  await f.intentWritten.promise;
  expect(f.log).toEqual([]);
  release.resolve();
  await launch;
  await stop;
  expect(f.log).toEqual([
    "launch settled",
    `stop:${c.hostId}:executor`,
    `retire:${c.hostId}`,
  ]);
});

test("logical retirement fences a successor preparing under a different physical host id", async () => {
  const f = fixture(),
    old = consumer(),
    next = consumer("rh-019d2a5f-4ac8-7000-8000-123456789abd");
  f.remember(old);
  f.remember(next);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const launch = f.api.dispatch(
    next,
    async () => {
      entered.resolve();
      await release.promise;
    },
    async () => {
      throw new Error("must never dispatch");
    },
  );
  await entered.promise;
  await f.api.stop(old);
  expect(f.log).not.toContain(`retire:${next.hostId}`);
  release.resolve();
  await expect(launch).rejects.toThrow("retired");
});

test("physical-only predecessor cleanup leaves logical lineage open for an enrolled successor", async () => {
  const f = fixture(),
    old = consumer(),
    next = consumer("rh-019d2a5f-4ac8-7000-8000-123456789abd");
  f.remember(old);
  f.remember(next);
  await f.api.finishPhysical(old);
  expect(f.intents.size).toBe(0);
  await f.api.dispatch(
    next,
    async () => {},
    async () => {
      f.log.push("successor");
    },
  );
  expect(f.log.at(-1)).toBe("successor");
});

test("unknown, missing lineage and mismatched/reused physical identity never invoke stop", async () => {
  for (const change of ["unknown", "missing", "lineage", "binding"]) {
    const f = fixture(),
      c = consumer();
    f.remember(c);
    if (change === "unknown") f.unknown();
    if (change === "missing") delete f.records.get(c.hostId)!.logicalRunId;
    if (change === "lineage")
      f.records.get(c.hostId)!.logicalRunId = "successor";
    if (change === "binding")
      f.records.get(c.hostId)!.personalRepo = {
        ...c.binding,
        descriptor: { ...c.binding.descriptor, accessRevision: 2 },
      };
    await expect(f.api.stop(c)).rejects.toThrow();
    expect(f.log).toEqual([]);
  }
});

test("caller mutation after async stop begins cannot relabel the original receipt", async () => {
  const f = fixture(),
    c = consumer();
  f.remember(c);
  const stop = f.api.stop(c);
  c.runKey = "different";
  expect((await stop).consumer.runKey).toBe("logical-run");
});

test("caller lifetime closure is rechecked after preparation immediately before dispatch", async () => {
  const f = fixture(),
    c = consumer();
  f.remember(c);
  let closed = false,
    launches = 0;
  f.api.remember(
    c,
    () => {},
    false,
    undefined,
    () => {
      if (closed) throw new Error("lifetime closed");
    },
  );
  await expect(
    f.api.dispatch(
      c,
      async () => {
        closed = true;
      },
      async () => {
        launches++;
      },
    ),
  ).rejects.toThrow("lifetime closed");
  expect(launches).toBe(0);
});

test("refreshed callback factory retains old physical registry and in-flight lock; state contexts remain isolated", async () => {
  const { sharedPersonalHostTransitions } =
    await import("./personal-host-transitions");
  const id = crypto.randomUUID();
  const context = {
    stateRoot: `/synthetic/${id}/A`,
    home: "/synthetic/home",
    hostsDir: `/synthetic/${id}/A/hosts`,
  };
  const first = fixture(),
    c = consumer();
  first.remember(c);
  const old = sharedPersonalHostTransitions(context, () => first.api);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const launch = old.dispatch(
    c,
    async () => {},
    async () => {
      entered.resolve();
      await release.promise;
      first.log.push("old launch settled");
    },
  );
  await entered.promise;
  const reloaded = (await import(
    `./personal-host-transitions.ts?fixture=${id}`
  )) as typeof import("./personal-host-transitions");
  const refreshed = reloaded.sharedPersonalHostTransitions(
    { ...context },
    () => {
      throw new Error("must reuse old registry and locks");
    },
  );
  expect(refreshed).toBe(old);
  const stopped = refreshed.stop(c);
  await first.intentWritten.promise;
  expect(first.log).toEqual([]);
  const other = fixture();
  other.remember(c);
  const isolated = sharedPersonalHostTransitions(
    {
      ...context,
      stateRoot: `/synthetic/${id}/B`,
      hostsDir: `/synthetic/${id}/B/hosts`,
    },
    () => other.api,
  );
  expect(isolated).not.toBe(old);
  await isolated.stop(c);
  expect(first.log).toEqual([]);
  release.resolve();
  await launch;
  await stopped;
  expect(first.log).toEqual([
    "old launch settled",
    `stop:${c.hostId}:executor`,
    `retire:${c.hostId}`,
  ]);
});
