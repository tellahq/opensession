import { expect, test } from "bun:test";
import {
  attachHostedRunLifetime,
  createHostedRunLifetime,
  finalizeHostedRun,
} from "./host-run-lifetime";
import {
  personalRunConsumerKey,
  type PersonalRunConsumer,
} from "./personal-run-consumers";
import { personalRepositoryId } from "./personal-repository-coordinator";
function fixture() {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: 41,
    repositoryOwnerGithubAccountId: 41,
    repositoryId: 3,
    installationId: 2,
    githubAppId: 1,
    appRecordId: "fixture",
    accessRevision: 1,
    fullName: "fixture/repo",
  };
  const a: PersonalRunConsumer = {
    runKey: "logical",
    hostId: "physical-A",
    sessionId: "private",
    binding: { registryId: personalRepositoryId(descriptor), descriptor },
  };
  const b = { ...a, hostId: "physical-B" };
  const confirmed = new Set<string>(),
    log: string[] = [];
  let unavailable = false;
  const deps = {
    confirmed: async (c: PersonalRunConsumer) =>
      confirmed.has(personalRunConsumerKey(c)),
    stop: async (c: PersonalRunConsumer) => {
      if (unavailable && c.hostId === a.hostId)
        throw new Error("unknown physical state");
      log.push(`stop:${c.hostId}`);
      confirmed.add(personalRunConsumerKey(c));
      return { state: "absent" as const, consumer: c };
    },
    retire: async (c: PersonalRunConsumer) => {
      log.push(`retire:${c.hostId}`);
    },
  };
  const lifetime = createHostedRunLifetime(a, deps);
  return {
    a,
    b,
    lifetime,
    log,
    deps,
    confirmed,
    unavailable(value: boolean) {
      unavailable = value;
    },
  };
}

test("zero-event enrolled work finalizes independently of any last event, idempotently", async () => {
  const f = fixture();
  f.lifetime.track(f.a);
  const stream = attachHostedRunLifetime(
    (async function* () {})(),
    f.lifetime.api,
  );
  try {
    for await (const _ of stream) {
    }
  } finally {
    await finalizeHostedRun(stream);
  }
  await finalizeHostedRun(stream);
  expect(f.log).toEqual(["stop:physical-A", "retire:physical-A"]);
  expect(() => f.lifetime.track(f.b)).toThrow("closed");
});

test("throwing postprocessing finishes only afterward and early break still retains cleanup", async () => {
  const f = fixture();
  f.lifetime.track(f.a);
  const stream = attachHostedRunLifetime(
    (async function* () {
      yield 1;
      yield 2;
    })(),
    f.lifetime.api,
  );
  await expect(
    (async () => {
      try {
        for await (const _ of stream) break;
        expect(f.log).toEqual([]);
        f.log.push("postprocessing throws");
        throw new Error("postprocessing");
      } finally {
        await finalizeHostedRun(stream);
      }
    })(),
  ).rejects.toThrow("postprocessing");
  expect(f.log).toEqual([
    "postprocessing throws",
    "stop:physical-A",
    "retire:physical-A",
  ]);
});

test("pending recovery rejection still has a lifetime before it can return a stream", async () => {
  const f = fixture();
  f.lifetime.track(f.a);
  const pending = attachHostedRunLifetime(
    Promise.reject(new Error("before first yield")),
    f.lifetime.api,
  );
  try {
    await expect(pending).rejects.toThrow("before first yield");
  } finally {
    await finalizeHostedRun(pending);
  }
  expect(f.log).toEqual(["stop:physical-A", "retire:physical-A"]);
});

test("multiple validated attempts are retained; a foreign logical successor cannot be added", async () => {
  const f = fixture();
  f.lifetime.track(f.a);
  f.lifetime.track(f.b);
  expect(() => f.lifetime.track({ ...f.b, runKey: "foreign" })).toThrow(
    "logical identity",
  );
  f.confirmed.add(personalRunConsumerKey(f.a));
  await f.lifetime.api.finalize();
  expect(f.log).toEqual([
    "retire:physical-A",
    "stop:physical-B",
    "retire:physical-B",
  ]);
});

test("unknown physical work stays owed while known cleanup progresses; retry never reopens dispatch", async () => {
  const f = fixture();
  f.lifetime.track(f.a);
  f.lifetime.track(f.b);
  f.unavailable(true);
  await expect(f.lifetime.api.finalize()).rejects.toThrow("unknown physical");
  expect(f.log).toEqual(["stop:physical-B", "retire:physical-B"]);
  expect(() => f.lifetime.assertOpen()).toThrow("closed");
  f.unavailable(false);
  await f.lifetime.api.finalize();
  expect(f.log.slice(-2)).toEqual(["stop:physical-A", "retire:physical-A"]);
});

test("revocation can confirm physical absence while postprocessing is still waiting", async () => {
  const f = fixture();
  f.lifetime.track(f.a);
  const release = Promise.withResolvers<void>();
  const postprocessing = (async () => {
    await release.promise;
    f.log.push("postprocessing settled");
  })();
  await f.deps.stop(f.a); // independent revoker, no wait for consumer lifetime
  expect(f.log).toEqual(["stop:physical-A"]);
  release.resolve();
  await postprocessing;
  await f.lifetime.api.finalize();
  expect(f.log).toEqual([
    "stop:physical-A",
    "postprocessing settled",
    "retire:physical-A",
  ]);
});

test("actual hosted zero-work rejection exposes cleanup before first next, without live work", async () => {
  const { runAgentHosted } = await import("./host-client");
  const f = fixture();
  const stream = runAgentHosted({
    personalRepo: f.a.binding,
    osSessionId: "private",
    cwd: "/synthetic",
    prompt: "fixture",
    mcpServers: "all",
    proxyMcpServers: [],
  });
  await expect(stream.next()).rejects.toThrow("empty MCP");
  await finalizeHostedRun(stream);
  await expect(finalizeHostedRun({})).rejects.toThrow("unavailable");
});
