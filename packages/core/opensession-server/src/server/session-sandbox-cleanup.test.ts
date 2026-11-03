import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sandbox-retirement-"));
const previous = process.env.OPENSESSION_SESSIONS_DIR;
process.env.OPENSESSION_SESSIONS_DIR = root;
const events: string[] = [];
let destroyError: Error | undefined;
let onDestroy: (() => void) | undefined;
mock.module("./sandbox", () => ({
  getSandboxProvider: (provider: string) => ({
    destroy: async (id: string) => {
      events.push(`destroy:${provider}:${id}`);
      onDestroy?.();
      if (destroyError) throw destroyError;
    },
  }),
}));
mock.module("./preview", () => ({
  dropSandboxPreviewRoutes: async (id: string) => {
    events.push(`routes:${id}`);
  },
  recipeStartOptions: () => ({}),
  sandboxPortalRecipes: () => [],
  sandboxPreviewIdentityContext: () => ({}),
}));
mock.module("./workload-identity", () => ({
  revokeWorkloadIdentityForSandbox: (id: string) => {
    events.push(`revoke:${id}`);
  },
  createWorkloadIdentityEnv: () => ({}),
  workloadIdentityIssuer: () => null,
}));
const { teardownRecordedSandbox, destroySessionSandbox } =
  await import("./session-sandbox");
const {
  writeRemoteState,
  withRemoteEnsureLock,
  findRemoteStateBySessionAsync,
} = await import("./sandbox/adapters/bootstrap");

async function record(
  sessionId: string,
  sandboxId: string,
  provider = "daytona",
) {
  await writeRemoteState({
    provider: provider as "daytona" | "box",
    sessionId,
    sandboxId,
    cwd: "/test",
    trustProfile: "interactive",
    egressAllowlist: [],
    createdAt: "2026-09-16T00:00:00Z",
    lastActivityAt: "2026-09-16T00:00:00Z",
  });
}

beforeEach(() => {
  events.length = 0;
  destroyError = undefined;
  onDestroy = undefined;
  rmSync(join(root, "sandboxes"), { recursive: true, force: true });
});
afterAll(() => {
  mock.restore();
  if (previous === undefined) delete process.env.OPENSESSION_SESSIONS_DIR;
  else process.env.OPENSESSION_SESSIONS_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("retiring a failed provisioning finds the exact provider/session and revokes before destroying", async () => {
  await record("another-session", "other");
  await record("failed", "box-other", "box");
  await record("failed", "failed-vm");
  expect(await teardownRecordedSandbox("failed", { provider: "daytona" })).toBe(
    "failed-vm",
  );
  expect(events).toEqual([
    "revoke:failed-vm",
    "routes:failed-vm",
    "destroy:daytona:failed-vm",
  ]);
});

test("waits for a queued create to persist its mapping, even when ensure fails", async () => {
  const release = Promise.withResolvers<void>();
  const ensure = withRemoteEnsureLock("daytona", "pending", async () => {
    await release.promise;
    await record("pending", "late-vm");
    throw new Error("bootstrap failed");
  });
  const failed = ensure.catch((error) => error);
  const retiring = teardownRecordedSandbox("pending", { provider: "daytona" });
  expect(events).toEqual([]);
  release.resolve();
  expect((await failed).message).toBe("bootstrap failed");
  expect(await retiring).toBe("late-vm");
  expect(events.at(-1)).toBe("destroy:daytona:late-vm");
});

test("uses a recorded machine id without choosing an unrelated provider mapping", async () => {
  await record("ready", "other-vm");
  expect(
    await teardownRecordedSandbox("ready", {
      provider: "daytona",
      sandboxId: "recorded-vm",
    }),
  ).toBe("recorded-vm");
  expect(events.at(-1)).toBe("destroy:daytona:recorded-vm");
});

test("propagates retirement failure so moves cannot forget the source", async () => {
  await record("failed", "kept-vm");
  destroyError = new Error("provider unavailable");
  await expect(
    teardownRecordedSandbox("failed", { provider: "daytona" }),
  ).rejects.toThrow("provider unavailable");
  expect(
    (await findRemoteStateBySessionAsync("daytona", "failed"))?.sandboxId,
  ).toBe("kept-vm");
});

test("no machine and local sessions are no-ops", async () => {
  expect(
    await teardownRecordedSandbox("absent", { provider: "daytona" }),
  ).toBeNull();
  expect(
    await teardownRecordedSandbox("local", {
      provider: "local",
      sandboxId: "host",
    }),
  ).toBeNull();
  expect(events).toEqual([]);
});

test("session deletion retires a failed workspace provision without sandboxId", async () => {
  await record("deleted", "failed-vm");
  const destroyed = Promise.withResolvers<void>();
  onDestroy = destroyed.resolve;
  destroySessionSandbox(
    {
      id: "deleted",
      source: "opensession",
      sandbox: { provider: "daytona", lifecycle: "needs_attention" },
    } as any,
    "delete",
  );
  await destroyed.promise;
  expect(events.at(-1)).toBe("destroy:daytona:failed-vm");
});

test("Portal deletion uses its provider session suffix, not the workspace mapping", async () => {
  await record("deleted", "workspace");
  await record("deleted--portals", "portal");
  const destroyed = Promise.withResolvers<void>();
  onDestroy = destroyed.resolve;
  destroySessionSandbox(
    {
      id: "deleted",
      source: "opensession",
      portalSandbox: { provider: "daytona", lifecycle: "needs_attention" },
    } as any,
    "delete",
  );
  await destroyed.promise;
  expect(events).toEqual([
    "revoke:portal",
    "routes:portal",
    "destroy:daytona:portal",
  ]);
});

test("recovery skips malformed provider mapping files", async () => {
  mkdirSync(join(root, "sandboxes"), { recursive: true });
  writeFileSync(join(root, "sandboxes/daytona-bad.json"), "{");
  await record("failed", "good-vm");
  expect(
    (await findRemoteStateBySessionAsync("daytona", "failed"))?.sandboxId,
  ).toBe("good-vm");
});
