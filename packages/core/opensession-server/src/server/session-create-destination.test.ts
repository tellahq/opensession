import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerWebSocket } from "bun";
import { configPath, getConfig, publishConfigSnapshot } from "./config";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import {
  startSessionKernelRuntime,
  stopSessionKernelRuntime,
  waitForSessionKernelRuntimeIdle,
} from "./session-kernel/runtime";
import {
  SessionListStore,
  __setSessionListStoreForTest,
} from "./session-list-store";
import {
  __resetWorkspaceProjectionForTest,
  createWorkspace,
  getWorkspace,
} from "./workspaces";
import { handleCreateSessionMessage } from "./session-create";
import { waitForCreationStateChange } from "./session-kernel/wakes";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import type { WSClientData } from "./ws-hub";

let root: string;
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let index: SessionListStore;
let previousIndex: SessionListStore | undefined;
let previousConfig: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "create-destination-"));
  previousConfig = JSON.stringify(getConfig());
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const args of [
    ["init", "-b", "main", repo],
    ["-C", repo, "remote", "add", "origin", repo],
    [
      "-C",
      repo,
      "-c",
      "user.name=Acme",
      "-c",
      "user.email=acme@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    ],
    [
      "-C",
      repo,
      "worktree",
      "add",
      "--detach",
      join(root, "worktrees", "docs-ask-checkout"),
      "main",
    ],
  ]) {
    const child = Bun.spawn(["git", ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (await child.exited)
      throw new Error(await new Response(child.stderr).text());
  }
  publishConfigSnapshot(
    configPath(),
    JSON.stringify({
      repos: {
        "acme-app": {
          repo: join(root, "app"),
          wtPrefix: "app",
          defaultBranch: "main",
        },
        "acme-docs": {
          repo,
          wtPrefix: "docs",
          defaultBranch: "main",
          sharedCheckout: false,
          default: true,
        },
      },
      paths: { worktreesDir: join(root, "worktrees") },
    }),
  );
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  index = new SessionListStore(":memory:");
  previousIndex = __setSessionListStoreForTest(index);
  __resetWorkspaceProjectionForTest();
  startSessionKernelRuntime(5);
});

afterEach(async () => {
  await waitForSessionKernelRuntimeIdle();
  stopSessionKernelRuntime();
  __setSessionKernelStoreForTest(previousStore);
  __setSessionListStoreForTest(previousIndex);
  store.close();
  index.close();
  __resetWorkspaceProjectionForTest();
  publishConfigSnapshot(configPath(), previousConfig);
  await rm(root, { recursive: true, force: true });
});

async function create(
  mode: "ask" | "code" | "scratch",
  workspaceId: string,
  createWorkspace?: { name: string },
) {
  const frames: Record<string, unknown>[] = [];
  const socket = {
    data: {},
    send: (text: string) => frames.push(JSON.parse(text)),
  } as unknown as ServerWebSocket<WSClientData>;
  const response = await handleCreateSessionMessage(socket, {
    prompt: "",
    user: "Acme",
    mode,
    checkoutMode: "checkout",
    repo: mode === "scratch" ? "none" : "acme-docs",
    branch: "feature",
    workspaceId,
    createWorkspace,
    sandbox: "local",
  });
  expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  expect(response?.type).toBe("session_created");
  const sessionId = String(response!.id);
  const deadline = Date.now() + 3000;
  while (
    store.creationState(sessionId)?.state !== "ready" &&
    Date.now() < deadline
  )
    await waitForCreationStateChange(sessionId, 50);
  expect(store.creationState(sessionId)?.state).toBe("ready");
  await waitForSessionKernelRuntimeIdle();
  const session = JSON.parse(
    await readFile(
      join(OPENSESSION_SESSIONS_DIR, `${response!.id}.json`),
      "utf8",
    ),
  );
  return {
    response: response!,
    session,
    workspace: await getWorkspace(session.workspaceId),
  };
}

test.each(["ask", "code", "scratch"] as const)(
  "%s with a foreign workspace id mints a compatible workspace",
  async (mode) => {
    const original = await createWorkspace({
      name: "App code",
      repo: "acme-app",
      createdBy: "Acme",
      branch: "feature",
      worktreeDir: join(root, "app-feature"),
    });
    const result = await create(mode, original.id);
    expect(result.session.workspaceId).not.toBe(original.id);
    expect(result.response.workspaceId).toBe(result.workspace?.id);
    expect(result.workspace?.repo).toBe(
      mode === "scratch" ? undefined : "acme-docs",
    );
    expect(result.session.repo).toBe(
      mode === "scratch" ? undefined : "acme-docs",
    );
    expect(await getWorkspace(original.id)).toEqual(original);
  },
);

test("a rejected join preserves an explicit createWorkspace request", async () => {
  const original = await createWorkspace({
    name: "App draft",
    repo: "acme-app",
    createdBy: "Acme",
  });
  const result = await create("ask", original.id, { name: "Docs question" });
  expect(result.workspace?.id).not.toBe(original.id);
  expect(result.workspace?.name).toBe("Docs question");
  expect(result.workspace?.repo).toBe("acme-docs");
});

test("same-repo Ask does not join a materialized code workspace", async () => {
  const original = await createWorkspace({
    name: "Docs code",
    repo: "acme-docs",
    createdBy: "Acme",
    branch: "feature",
    worktreeDir: join(root, "docs-feature"),
  });
  const result = await create("ask", original.id);
  expect(result.workspace?.id).not.toBe(original.id);
  expect(result.session.worktreeDir).toBe(
    join(root, "worktrees", "docs-ask-checkout"),
  );
});

test("a same-repo unmaterialized draft is still adopted", async () => {
  const original = await createWorkspace({
    name: "Docs draft",
    repo: "acme-docs",
    createdBy: "Acme",
  });
  const result = await create("ask", original.id);
  expect(result.workspace?.id).toBe(original.id);
});

test("an unknown workspace id is not persisted as orphan membership", async () => {
  const result = await create("scratch", "ws-missing");
  expect(result.workspace?.id).not.toBe("ws-missing");
  expect(result.workspace?.id).toBeTruthy();
});

test("same-repo Code retains its workspace and checkout", async () => {
  const original = await createWorkspace({
    name: "Docs code",
    repo: "acme-docs",
    createdBy: "Acme",
    branch: "main",
    worktreeDir: join(root, "repo"),
  });
  const result = await create("code", original.id);
  expect(result.workspace?.id).toBe(original.id);
  expect(result.session.worktreeDir).toBe(original.worktreeDir);
});

test("repo-less siblings retain their shared scratch directory", async () => {
  const first = await create("scratch", "ws-missing");
  const second = await create("scratch", first.workspace!.id);
  expect(second.workspace?.id).toBe(first.workspace?.id);
  expect(second.session.worktreeDir).toBe(first.session.worktreeDir);
});
