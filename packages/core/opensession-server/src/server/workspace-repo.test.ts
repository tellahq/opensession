import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import {
  __resetWorkspaceProjectionForTest,
  createWorkspace,
  getWorkspace,
  materializeWorkspaceWorktree,
  peekWorkspace,
  stampWorkspaceIdentity,
  updateWorkspace,
  WorkspaceRepoConflictError,
} from "./workspaces";
import { createPlanWorkspaceId } from "./session-create-plan";
import {
  requestCreationWorkspace,
  patchCreationSetupPlan,
} from "./session-kernel/creation-intents";
import {
  executeCreationWorkspacePrepare,
  type CreationWorkspaceEffectItem,
} from "./session-kernel/creation-effect-executors";
import type { CreationEventDecision } from "./session-kernel/store";

const root = await mkdtemp(join(tmpdir(), "workspace-repo-test-"));
const previousConfig = process.env.OPENSESSION_CONFIG;
const previousState = process.env.OPENSESSION_STATE_DIR;
const config = join(root, "config.json");
const repoA = join(root, "acme-a");
const repoB = join(root, "acme-b");
// Deliberately misleading names: only Git metadata may authorize a correction.
const treeA = join(root, "acme-b-feature");
const treeB = join(root, "acme-a-feature");
for (const [repo, tree] of [
  [repoA, treeA],
  [repoB, treeB],
]) {
  await $`git init -b main ${repo}`.quiet();
  await $`git -C ${repo} -c user.name=Acme -c user.email=dev@example.test commit --allow-empty -m initial`.quiet();
  await $`git -C ${repo} worktree add -b feature ${tree}`.quiet();
}
await writeFile(
  config,
  JSON.stringify({
    repos: {
      "acme-a": { repo: repoA, label: "A", defaultBranch: "main" },
      "acme-b": { repo: repoB, label: "B", defaultBranch: "main" },
    },
  }),
);
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(async () => {
  process.env.OPENSESSION_CONFIG = config;
  process.env.OPENSESSION_STATE_DIR = root;
  await getConfigAsync();
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  __resetWorkspaceProjectionForTest();
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  __resetWorkspaceProjectionForTest();
});
afterAll(async () => {
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previousConfig;
  if (previousState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousState;
  await rm(root, { recursive: true, force: true });
});

async function staleWorkspace(worktreeDir = treeB, key?: string) {
  return createWorkspace({
    name: "Feature",
    createdBy: "Acme",
    repo: "acme-a",
    branch: "feature",
    worktreeDir,
    key,
  });
}

describe("first code workspace materialization", () => {
  test("a timed-out workspace receipt and retried plan retain the authoritative checkout repo", async () => {
    const sessionId = "create-retry";
    const identity = "request-retry";
    const workspaceId = createPlanWorkspaceId(sessionId);
    const kernel = {
      creationState: () => store.creationState(sessionId),
      applyCreationEvent: (input: Omit<CreationEventDecision, "sessionId">) =>
        store.applyCreationEvent({ ...input, sessionId }),
    };
    const plan = await patchCreationSetupPlan(
      sessionId,
      identity,
      { workspaceId },
      kernel,
    );
    const input = {
      sessionId,
      identity,
      workspaceId: plan.workspaceId!,
      dedupeKey: `session-create:${identity}`,
      name: "Feature",
      createdBy: "Acme",
      project: "acme-a",
    };
    await expect(
      requestCreationWorkspace(input, { kernel, timeoutMs: 0 }),
    ).rejects.toThrow("remains durably pending");
    const [effect] = store.pendingOutbox();
    await executeCreationWorkspacePrepare(
      effect as CreationWorkspaceEffectItem,
      {
        getWorkspace,
        createWorkspace,
        result: () =>
          kernel.applyCreationEvent({
            identity,
            event: "preparation_started",
            effectId: effect.effectKey,
          }),
      },
    );
    expect((await getWorkspace(workspaceId))?.repo).toBe("acme-a");
    // Completed receipts intentionally do not rerun workspace creation. The
    // first-code write must carry all of the resolved destination's identity.
    await requestCreationWorkspace({ ...input, project: "acme-b" }, { kernel });
    const destination = {
      repo: "acme-b",
      worktreeDir: treeB,
      branch: "feature",
    };
    await materializeWorkspaceWorktree(workspaceId, destination);
    await materializeWorkspaceWorktree(workspaceId, destination);
    expect(await getWorkspace(workspaceId)).toMatchObject(destination);
    expect(peekWorkspace(workspaceId)).toMatchObject(destination);
    expect(store.creationState(sessionId)?.setupPlan?.workspaceId).toBe(
      workspaceId,
    );
  });

  test("keeps PR head identity and refuses a competing checkout", async () => {
    const ws = await createWorkspace({
      name: "PR",
      createdBy: "Acme",
      repo: "acme-a",
      prNumber: 7,
      branch: "feature",
    });
    await materializeWorkspaceWorktree(ws.id, {
      repo: "acme-b",
      worktreeDir: treeB,
      branch: "feature-os-review",
    });
    expect(await getWorkspace(ws.id)).toMatchObject({
      repo: "acme-b",
      branch: "feature",
      worktreeDir: treeB,
    });
    await expect(
      materializeWorkspaceWorktree(ws.id, {
        repo: "acme-a",
        worktreeDir: treeA,
        branch: "other",
      }),
    ).rejects.toThrow("already owns another checkout");
    expect((await getWorkspace(ws.id))?.repo).toBe("acme-b");
  });
});

test("same-repo first creates both continue while the first writer keeps ownership", async () => {
  const ws = await createWorkspace({
    name: "Race",
    createdBy: "Acme",
    repo: "acme-a",
  });
  const first = { repo: "acme-a", worktreeDir: treeA, branch: "feature" };
  const second = {
    repo: "acme-a",
    worktreeDir: join(root, "acme-a-second"),
    branch: "second",
  };
  const results = await Promise.all([
    materializeWorkspaceWorktree(ws.id, first),
    materializeWorkspaceWorktree(ws.id, second),
  ]);
  const owner = await getWorkspace(ws.id);
  if (!owner?.worktreeDir) throw new Error("No first-create checkout owner");
  expect([first.worktreeDir, second.worktreeDir]).toContain(owner.worktreeDir);
  const winningDestination =
    owner.worktreeDir === first.worktreeDir ? first : second;
  expect(owner).toMatchObject(winningDestination);
  expect(results[0]).toEqual(owner);
  expect(results[1]).toEqual(owner);
  expect(peekWorkspace(ws.id)).toEqual(owner);
});

test("a same-repo late materialization preserves the existing PR head and checkout", async () => {
  const ws = await createWorkspace({
    name: "PR",
    createdBy: "Acme",
    repo: "acme-a",
    worktreeDir: treeA,
    branch: "feature",
    prNumber: 7,
  });
  expect(
    await materializeWorkspaceWorktree(ws.id, {
      repo: "acme-a",
      worktreeDir: join(root, "acme-a-second"),
      branch: "second",
    }),
  ).toEqual(ws);
  expect(await getWorkspace(ws.id)).toEqual(ws);
});

test("cross-repo competing first creates cannot split the repo from the checkout", async () => {
  const ws = await createWorkspace({
    name: "Race",
    createdBy: "Acme",
    repo: "acme-a",
  });
  const destinations = [
    { repo: "acme-a", worktreeDir: treeA, branch: "feature" },
    { repo: "acme-b", worktreeDir: treeB, branch: "feature" },
  ];
  const results = await Promise.allSettled(
    destinations.map((next) => materializeWorkspaceWorktree(ws.id, next)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const winner = results.findIndex((r) => r.status === "fulfilled");
  expect(await getWorkspace(ws.id)).toMatchObject(destinations[winner]);
});

async function patchWorkspace(id: string, body: object) {
  const { handleWorkspaceRoutes } = await import("./routes/workspace");
  const url = new URL(`https://example.test/api/workspaces/${id}`);
  return handleWorkspaceRoutes({
    req: new Request(url, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    url,
    path: url.pathname,
    publicPrefix: "/opensession",
  });
}

test("HTTP PATCH repairs a proven repo and ignores checkout identity fields", async () => {
  const ws = await staleWorkspace();
  const response = await patchWorkspace(ws.id, {
    repo: "acme-b",
    worktreeDir: treeA,
    branch: "other",
    key: "replace",
  });
  expect(response?.status).toBe(200);
  expect((await response!.json()).workspace).toMatchObject({
    repo: "acme-b",
    worktreeDir: treeB,
    branch: "feature",
  });
  expect((await getWorkspace(ws.id))?.key).toBeUndefined();
});

test("HTTP PATCH rejects a repository that does not own the checkout", async () => {
  const ws = await staleWorkspace(treeA);
  const response = await patchWorkspace(ws.id, {
    repo: "acme-b",
    worktreeDir: treeB,
  });
  expect(response?.status).toBe(409);
  expect(await getWorkspace(ws.id)).toMatchObject({
    repo: "acme-a",
    worktreeDir: treeA,
  });
});

describe("explicit checkout identity correction", () => {
  test("PR stamps correct a stale repo using Git ownership, not the directory prefix", async () => {
    const ws = await staleWorkspace();
    expect(
      await stampWorkspaceIdentity(ws.id, {
        repo: "acme-b",
        key: "ghpr-acme-b-7",
        prNumber: 7,
      }),
    ).toMatchObject({ repo: "acme-b", key: "ghpr-acme-b-7", prNumber: 7 });
    expect(peekWorkspace(ws.id)?.repo).toBe("acme-b");
  });

  test("a durable creation key does not block repo repair or get replaced", async () => {
    const ws = await staleWorkspace(treeB, "session-create:request");
    expect(
      await stampWorkspaceIdentity(ws.id, {
        repo: "acme-b",
        key: "ghpr-acme-b-7",
        prNumber: 7,
      }),
    ).toMatchObject({ repo: "acme-b", key: "session-create:request" });
  });

  test("explicit repo patches repair a proven mismatch", async () => {
    const ws = await staleWorkspace();
    expect(await updateWorkspace(ws.id, { repo: "acme-b" })).toMatchObject({
      repo: "acme-b",
      worktreeDir: treeB,
    });
  });

  test("symlinked checkout paths still use the same Git identity", async () => {
    const link = join(root, "checkout-link");
    await symlink(treeB, link);
    const ws = await staleWorkspace(link);
    expect(
      (await stampWorkspaceIdentity(ws.id, { repo: "acme-b" }))?.repo,
    ).toBe("acme-b");
  });

  test.each([treeA, join(root, "missing-acme-b-feature")])(
    "does not rewrite a real owner or guess from an absent path: %s",
    async (path) => {
      const ws = await staleWorkspace(path);
      expect(
        (await stampWorkspaceIdentity(ws.id, { repo: "acme-b", prNumber: 7 }))
          ?.repo,
      ).toBe("acme-a");
      await expect(
        updateWorkspace(ws.id, { repo: "acme-b" }),
      ).rejects.toBeInstanceOf(WorkspaceRepoConflictError);
      expect((await getWorkspace(ws.id))?.repo).toBe("acme-a");
    },
  );

  test("an attached repository's PR does not replace the primary checkout repo", async () => {
    const ws = await staleWorkspace(treeA);
    await updateWorkspace(ws.id, {
      attachedRepos: [{ repo: "acme-b", dir: treeB, branch: "feature" }],
    });
    expect(
      (await stampWorkspaceIdentity(ws.id, { repo: "acme-b", prNumber: 7 }))
        ?.repo,
    ).toBe("acme-a");
  });
});
