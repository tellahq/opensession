import { getConfigAsync } from "./config";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prKey } from "../agents/github/constants";

const scratch = mkdtempSync(join(tmpdir(), "opensession-workspace-resolve-"));
const previousState = process.env.OPENSESSION_STATE_DIR;
const previousConfig = process.env.OPENSESSION_CONFIG;
const configPath = join(scratch, "config.json");
const repoId = "workspace-resolve-test";
const ghRepo = "tellahq/workspace-resolve-test";
writeFileSync(
  configPath,
  JSON.stringify({
    repos: {
      [repoId]: {
        repo: "/home/ubuntu/projects/opensession",
        ghRepo,
        label: "Workspace resolve test",
      },
    },
  }),
);
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_CONFIG = configPath;
await getConfigAsync();

const { SessionListStore } = await import("./session-list-sqlite");
const { __setSessionListStoreForTest } = await import("./session-list-store");
const { invalidateSessionsCache } = await import("./session-cache");
const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const { __resetWorkspaceProjectionForTest, createWorkspace, getWorkspace } =
  await import("./workspaces");
const { resolvePrWorkspace, workspaceBacksOpenPr } =
  await import("./workspace-resolve");

// Workspaces live in the kernel catalog: a fresh in-memory store per test.
let store: InstanceType<typeof SessionKernelStore>;
let index: InstanceType<typeof SessionListStore>;
let previousIndex: InstanceType<typeof SessionListStore> | undefined;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;
beforeEach(async () => {
  process.env.OPENSESSION_STATE_DIR = scratch;
  process.env.OPENSESSION_CONFIG = configPath;
  await getConfigAsync();
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  // Workspace resolution reads the session list to adopt matching siblings.
  // These fixtures have none; use a complete, isolated projection, not a scan
  // of the operator's legacy session directories.
  index = new SessionListStore(":memory:");
  index.replaceAll([]);
  previousIndex = __setSessionListStoreForTest(index);
  invalidateSessionsCache();
  __resetWorkspaceProjectionForTest();
});

afterEach(() => {
  __setSessionListStoreForTest(previousIndex);
  index.close();
  invalidateSessionsCache();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  __resetWorkspaceProjectionForTest();
});

afterAll(async () => {
  if (previousState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousState;
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = previousConfig;
    await getConfigAsync();
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("workspaceBacksOpenPr", () => {
  const openPrs = [
    {
      repo: repoId,
      number: 9128,
      branch: "skip-running-next-fallbacks",
    },
  ];

  test("keeps a session-less workspace active while its PR is open", () => {
    expect(
      workspaceBacksOpenPr(
        { repo: repoId, prNumber: 9128, branch: "skip-running-next-fallbacks" },
        openPrs,
        "fallback",
      ),
    ).toBe(true);
  });

  test("does not revive closed or cross-repo PR workspaces", () => {
    expect(
      workspaceBacksOpenPr(
        { repo: repoId, prNumber: 9129, branch: "other" },
        openPrs,
        "fallback",
      ),
    ).toBe(false);
    expect(
      workspaceBacksOpenPr(
        { repo: "other-repo", prNumber: 9128 },
        openPrs,
        "fallback",
      ),
    ).toBe(false);
  });
});

describe("resolvePrWorkspace", () => {
  test("repairs a generated placeholder when the PR title arrives", async () => {
    const number = 9128;
    const workspace = await createWorkspace({
      name: `#${number}`,
      repo: repoId,
      key: `ghpr-${prKey(number, ghRepo)}`,
      prNumber: number,
      createdBy: "Kent",
    });

    const resolved = await resolvePrWorkspace({
      repoId,
      number,
      branch: "skip-running-next-fallbacks",
      title: "Skip running native Next chat fallbacks",
      createdBy: "Kent",
    });

    expect(resolved?.created).toBe(false);
    expect(resolved?.workspace.name).toBe(
      `#${number} Skip running native Next chat fallbacks`,
    );
    expect(resolved?.workspace.branch).toBe("skip-running-next-fallbacks");
    expect((await getWorkspace(workspace.id))?.name).toBe(
      `#${number} Skip running native Next chat fallbacks`,
    );
  });

  test("preserves a manually chosen workspace name", async () => {
    const number = 9129;
    const workspace = await createWorkspace({
      name: "Native fallback cleanup",
      repo: repoId,
      key: `ghpr-${prKey(number, ghRepo)}`,
      prNumber: number,
      createdBy: "Kent",
    });

    const resolved = await resolvePrWorkspace({
      repoId,
      number,
      branch: "skip-running-next-fallbacks",
      title: "A newer PR title",
      createdBy: "Kent",
    });

    expect(resolved?.workspace.name).toBe("Native fallback cleanup");
    expect((await getWorkspace(workspace.id))?.name).toBe(
      "Native fallback cleanup",
    );
  });
});
