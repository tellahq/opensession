import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sandbox-detach-"));
const previous = process.env.OPENSESSION_SESSIONS_DIR;
process.env.OPENSESSION_SESSIONS_DIR = root;
const events: string[] = [];
let session: any;
let destroyError: Error | undefined;
const cache = await import("../session-cache");
mock.module("../session-cache", () => ({
  ...cache,
  findSessionAsync: async () => session,
  touchNativeSessionStrict: async (_id: string, patch: any) => {
    events.push(`persist:${patch.sandbox?.provider}`);
    session = { ...session, ...patch };
  },
}));
const sandbox = await import("../sandbox");
mock.module("../sandbox", () => ({
  ...sandbox,
  getSandboxProvider: () => ({
    destroy: async (id: string) => {
      events.push(`destroy:${id}`);
      if (destroyError) throw destroyError;
    },
  }),
}));
const preview = await import("../preview");
mock.module("../preview", () => ({
  ...preview,
  dropSandboxPreviewRoutes: async () => {},
}));
const checkpoint = await import("../sandbox/checkpoint");
mock.module("../sandbox/checkpoint", () => ({
  ...checkpoint,
  restorableCheckpoint: (value: any) => value.sandboxCheckpoint,
  restoreCheckpointToHostWorktree: async () => {
    events.push("restore");
    return "/test-restored-host";
  },
}));
const worktree = await import("../worktree");
mock.module("../worktree", () => ({
  ...worktree,
  getRepo: () => ({ id: "test-repo", defaultBranch: "main" }),
}));
mock.module("../audit", () => ({ audit: () => {} }));
const { handleSandboxRoutes } = await import("./sandbox");
const { writeRemoteState, withRemoteEnsureLock } =
  await import("../sandbox/adapters/bootstrap");
async function mapping() {
  await writeRemoteState({
    provider: "daytona",
    sessionId: "failed-session",
    sandboxId: "failed-vm",
    cwd: "/test",
    trustProfile: "interactive",
    egressAllowlist: [],
    createdAt: "2026-09-16T00:00:00Z",
    lastActivityAt: "2026-09-16T00:00:00Z",
  });
}
function detach() {
  const path = "/api/sessions/failed-session/sandbox/detach";
  return handleSandboxRoutes({
    path,
    req: new Request(`http://localhost${path}`, { method: "POST", body: "{}" }),
  } as any);
}
beforeEach(() => {
  destroyError = undefined;
  events.length = 0;
  rmSync(join(root, "sandboxes"), { force: true, recursive: true });
  session = {
    id: "failed-session",
    source: "opensession",
    mode: "code",
    repo: "test-repo",
    branch: "test-branch",
    worktreeDir: "/test",
    sandbox: { provider: "daytona", lifecycle: "needs_attention" },
    sandboxCheckpoint: {
      branch: "test-branch",
      at: "2026-09-16T00:00:00Z",
      commit: "synthetic-checkpoint",
    },
  };
});
afterAll(() => {
  mock.restore();
  if (previous === undefined) delete process.env.OPENSESSION_SESSIONS_DIR;
  else process.env.OPENSESSION_SESSIONS_DIR = previous;
  rmSync(root, { force: true, recursive: true });
});
test("detach retires a failed provision before switching the session to the host", async () => {
  await mapping();
  const response = await detach();
  expect(response?.status).toBe(200);
  expect(events).toEqual(["restore", "destroy:failed-vm", "persist:local"]);
  expect(session.sandbox.provider).toBe("local");
});
test("detach keeps the provider selection if retiring its hidden machine fails", async () => {
  await mapping();
  destroyError = new Error("provider refused deletion");
  const response = await detach();
  expect(response?.status).toBe(500);
  expect(await response?.json()).toEqual({
    error: "provider refused deletion",
  });
  expect(session.sandbox.provider).toBe("daytona");
  expect(events).toEqual(["restore", "destroy:failed-vm"]);
});
test("detach waits for an in-flight ensure to make its machine discoverable", async () => {
  const release = Promise.withResolvers<void>();
  const ensure = withRemoteEnsureLock("daytona", "failed-session", async () => {
    await release.promise;
    await mapping();
  });
  const response = detach();
  release.resolve();
  await ensure;
  expect((await response)?.status).toBe(200);
  expect(events).toEqual(["restore", "destroy:failed-vm", "persist:local"]);
});
