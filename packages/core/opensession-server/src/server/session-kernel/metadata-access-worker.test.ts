import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSessionKernelService } from "./actor-service";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import type { MetadataActorRequest } from "./metadata-protocol";
import { sessionKernelSessionDbPath } from "./store";

const root = mkdtempSync(join(tmpdir(), "metadata-access-worker-"));
const saved = {
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_SESSION_KERNEL_DB_PATH:
    process.env.OPENSESSION_SESSION_KERNEL_DB_PATH,
};
const token = "synthetic-access-worker-token";
let service: Awaited<ReturnType<typeof startSessionKernelService>>;
let epoch: string;
async function rpc(request: KernelActorTransportEnvelope["request"]) {
  const response = await fetch(`${service.url}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: SESSION_KERNEL_TRANSPORT_VERSION,
      actorVersion: SESSION_KERNEL_ACTOR_VERSION,
      ...(epoch ? { serviceEpoch: epoch } : {}),
      request,
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function metadata(request: MetadataActorRequest) {
  const result = await rpc({
    t: "call",
    rpcId: crypto.randomUUID(),
    outputBytes: 256 * 1024,
    request: {
      t: "reduce",
      command: { kind: "metadata", commandId: crypto.randomUUID(), request },
    },
  });
  expect(result.t).toBe("call_result");
  return JSON.parse(result.body);
}
beforeAll(async () => {
  process.env.OPENSESSION_STATE_DIR = root;
  service = await startSessionKernelService({
    port: 0,
    token,
    workerCount: 2,
    databasePath: join(root, "kernel.sqlite"),
  });
  epoch = (
    await rpc({
      t: "hello",
      rpcId: "hello",
      version: SESSION_KERNEL_ACTOR_VERSION,
    })
  ).serviceEpoch;
});
afterAll(() => {
  service.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("real worker RPC preserves owner predicates without opening a session actor for catalog reads", async () => {
  const principal = { githubAccountId: 101 };
  const doc = JSON.stringify({
    id: "private",
    accessScope: { kind: "personal", ownerGithubAccountId: 101 },
  });
  await metadata({
    op: "seed_catalog",
    rows: [
      { sessionId: "private", doc, rev: 1, archived: false, lastActivityMs: 1 },
    ],
  });
  expect(
    (await metadata({ op: "catalog_read", sessionId: "private" })).result,
  ).toEqual({ status: "denied" });
  expect(
    (
      await metadata({
        op: "catalog_get",
        sessionId: "private",
        principal: { githubAccountId: 202 },
      })
    ).result,
  ).toBeNull();
  expect((await metadata({ op: "catalog_count" })).result).toBe(0);
  expect(
    (
      await metadata({
        op: "catalog_page",
        afterSessionId: "",
        limit: 10,
        principal,
      })
    ).result,
  ).toHaveLength(1);
  expect(
    existsSync(
      sessionKernelSessionDbPath(
        "private",
        join(root, "session-kernel-sessions"),
      ),
    ),
  ).toBe(false);
  expect(
    (
      await metadata({
        op: "put",
        sessionId: "private",
        doc,
        principal,
        requestId: "private-seed",
        expectedRev: null,
        rev: 1,
        archived: false,
        lastActivityMs: 1,
      })
    ).result,
  ).toMatchObject({ status: "committed", rev: 1 });
  expect(
    (await metadata({ op: "get", sessionId: "private" })).result,
  ).toBeNull();
  expect(
    (
      await metadata({
        op: "get",
        sessionId: "private",
        principal: { githubAccountId: 202 },
      })
    ).result,
  ).toBeNull();
  expect(
    (await metadata({ op: "get", sessionId: "private", principal })).result,
  ).toMatchObject({ sessionId: "private", doc });
  expect(
    (
      await metadata({
        op: "repository_put",
        repositoryId: "private-repo",
        doc,
        expectedRev: null,
        principal,
      })
    ).result,
  ).toEqual({ status: "committed", rev: 1 });
  expect(
    (await metadata({ op: "repository_get", repositoryId: "private-repo" }))
      .result,
  ).toBeNull();
  expect((await metadata({ op: "repository_count", principal })).result).toBe(
    1,
  );
});
