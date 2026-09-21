/**
 * Title refresh on later prompts: manual renames and fixed-title sessions are
 * never touched, follow-up shaped prompts never buy a model call, KEEP leaves
 * the title alone, concurrent prompts coalesce onto one lane per session,
 * failures are soft, and the first generated title names a pending workspace
 * once. The registry path is pinned at module load, so the scratch store env
 * is set before the import.
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionsDir = join(
  tmpdir(),
  `generated-titles-${crypto.randomUUID()}`,
  "sessions",
);
mkdirSync(sessionsDir, { recursive: true });
process.env.OPENSESSION_SESSIONS_DIR = sessionsDir;

type Titles = typeof import("./generated-titles");
type Overrides = typeof import("./title-overrides");
let titles: Titles;
let overrides: Overrides;

type Call = { prompt: string; label?: string; user?: string };
let calls: Call[] = [];
let callWaiters: Array<{ count: number; resolve: () => void }> = [];
function waitForCalls(count: number): Promise<void> {
  if (calls.length >= count) return Promise.resolve();
  return new Promise((resolve) => callWaiters.push({ count, resolve }));
}
let answer: (call: Call) => Promise<string | null> = async () => null;
const restores: Array<() => void> = [];

beforeAll(async () => {
  titles = await import("./generated-titles");
  overrides = await import("./title-overrides");
  restores.push(
    titles.__setGeneratedTitleOneShotForTest((prompt, opts) => {
      const call = { prompt, label: opts?.label, user: opts?.user };
      calls.push(call);
      const result = answer(call);
      callWaiters = callWaiters.filter((waiter) => {
        if (calls.length < waiter.count) return true;
        waiter.resolve();
        return false;
      });
      return result;
    }),
  );
});
afterEach(() => {
  calls = [];
  answer = async () => null;
});
afterAll(() => {
  for (const restore of restores.splice(0)) restore();
  rmSync(join(sessionsDir, ".."), { recursive: true, force: true });
});

let counter = 0;
function sessionId(): string {
  counter++;
  return `os-${String(counter).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

async function registry(): Promise<Record<string, string>> {
  return JSON.parse(
    await readFile(join(sessionsDir, "generated-titles.json"), "utf-8"),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const session = { title: "Add onboarding flow" };

test("first title is generated once and persisted through the async writer", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  expect(
    await titles.ensureGeneratedTitle(id, "Please add an onboarding flow"),
  ).toBe("Add onboarding flow");
  expect(titles.getGeneratedTitle(id)).toBe("Add onboarding flow");
  expect((await registry())[id]).toBe("Add onboarding flow");
  // Already titled: no second call.
  expect(await titles.ensureGeneratedTitle(id, "anything")).toBeNull();
  expect(calls.length).toBe(1);
});

test("follow-up shaped prompts keep the title without a model call", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  calls = [];
  for (const prompt of [
    "yes",
    "do it",
    "ok go ahead",
    "Yes, please do that now.",
    "looks good, ship it please",
    "LGTM! merge it",
    "<!--os:worker-report:x-->\nWorker finished the migration to postgres",
    "",
  ]) {
    expect(
      await titles.refreshGeneratedTitle(id, prompt, { user: "ada", session }),
    ).toBeNull();
  }
  expect(calls.length).toBe(0);
  // Short tasks and questions are not follow-ups by shape: the model judges.
  answer = async () => "KEEP";
  for (const prompt of [
    "OK now fix uploads",
    "Please add dark mode",
    "How does login work?",
    "Fix login tests",
  ]) {
    await titles.refreshGeneratedTitle(id, prompt, { user: "ada", session });
  }
  expect(calls.length).toBe(4);
  expect(titles.getGeneratedTitle(id)).toBe("Add onboarding flow");
});

test("a KEEP verdict leaves the title alone and is not asked again for the same prompt", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  answer = async () => "KEEP";
  const prompt = "Now also cover the returning-user case in the same flow";
  expect(
    await titles.refreshGeneratedTitle(id, prompt, { user: "ada", session }),
  ).toBeNull();
  expect(calls.length).toBe(2);
  expect(calls[1]!.label).toBe("generated-titles-refresh");
  expect(calls[1]!.prompt).toContain('titled "Add onboarding flow"');
  expect(calls[1]!.prompt).toContain(prompt);
  // Redelivered prompt: judged already.
  expect(
    await titles.refreshGeneratedTitle(id, prompt, { user: "ada", session }),
  ).toBeNull();
  expect(calls.length).toBe(2);
  expect(titles.getGeneratedTitle(id)).toBe("Add onboarding flow");
});

test("a meaningfully different task replaces the title", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  answer = async () => '"Fix flaky login test."';
  expect(
    await titles.refreshGeneratedTitle(
      id,
      "Onboarding is merged. Next, the login integration test fails every third run on CI, find out why and fix it.",
      { user: "ada", session },
    ),
  ).toBe("Fix flaky login test");
  expect(titles.getGeneratedTitle(id)).toBe("Fix flaky login test");
  expect((await registry())[id]).toBe("Fix flaky login test");
  // A short imperative is a task for the model to judge, not a follow-up.
  answer = async () => "Fix upload progress bar";
  expect(
    await titles.refreshGeneratedTitle(id, "Now fix uploads", {
      user: "ada",
      session,
    }),
  ).toBe("Fix upload progress bar");
  expect(calls.at(-1)!.prompt).toContain('titled "Fix flaky login test"');
});

test("prose, an unchanged title and an empty answer are all kept", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  const prompt = (n: number) =>
    `Message number ${n} about a task that is long enough to be judged by the model`;
  answer = async () =>
    "This continues the same task. It refines the onboarding work.";
  expect(
    await titles.refreshGeneratedTitle(id, prompt(1), { user: "ada", session }),
  ).toBeNull();
  answer = async () => "add onboarding flow";
  expect(
    await titles.refreshGeneratedTitle(id, prompt(2), { user: "ada", session }),
  ).toBeNull();
  answer = async () => null;
  expect(
    await titles.refreshGeneratedTitle(id, prompt(3), { user: "ada", session }),
  ).toBeNull();
  // A failed call is not remembered as judged: the same prompt may retry.
  answer = async () => "Rename the widgets";
  expect(
    await titles.refreshGeneratedTitle(id, prompt(3), { user: "ada", session }),
  ).toBe("Rename the widgets");
});

test("manual renames, fixed-title sessions and machine prompters are never re-titled", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  answer = async () => "Fix flaky login test";
  const prompt =
    "Switch to the flaky login integration test and find out why it fails";
  for (const s of [
    { ...session, desk: true },
    { ...session, goalId: "goal-1" },
    { ...session, automationId: "auto-1" },
    { ...session, automation: "Nightly triage" },
  ]) {
    expect(
      await titles.refreshGeneratedTitle(id, prompt, {
        user: "ada",
        session: s,
      }),
    ).toBeNull();
  }
  expect(
    await titles.refreshGeneratedTitle(id, prompt, {
      user: "auto-continue",
      session,
    }),
  ).toBeNull();
  overrides.setTitleOverride(id, "My chosen name");
  try {
    expect(
      await titles.refreshGeneratedTitle(id, prompt, { user: "ada", session }),
    ).toBeNull();
  } finally {
    overrides.setTitleOverride(id, null);
  }
  expect(calls.length).toBe(1);
  expect(titles.getGeneratedTitle(id)).toBe("Add onboarding flow");
});

test("a rename made while the model call is in flight wins", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  const gate = deferred<string | null>();
  answer = () => gate.promise;
  const pending = titles.refreshGeneratedTitle(
    id,
    "Switch to the flaky login integration test and find out why it fails",
    { user: "ada", session },
  );
  await waitForCalls(2);
  expect(calls.length).toBe(2);
  overrides.setTitleOverride(id, "My chosen name");
  try {
    gate.resolve("Fix flaky login test");
    expect(await pending).toBeNull();
  } finally {
    overrides.setTitleOverride(id, null);
  }
  expect(titles.getGeneratedTitle(id)).toBe("Add onboarding flow");
});

test("prompts arriving during an in-flight call coalesce onto the latest one", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  const gates: Array<ReturnType<typeof deferred<string | null>>> = [];
  answer = () => {
    const gate = deferred<string | null>();
    gates.push(gate);
    return gate.promise;
  };
  const a = titles.refreshGeneratedTitle(
    id,
    "Prompt one is long enough to be judged by the model for sure",
    { user: "ada", session },
  );
  const b = titles.refreshGeneratedTitle(
    id,
    "Prompt two is long enough to be judged by the model for sure",
    { user: "ada", session },
  );
  const c = titles.refreshGeneratedTitle(
    id,
    "Prompt three is long enough to be judged by the model for sure",
    { user: "ada", session },
  );
  await waitForCalls(2);
  expect(gates.length).toBe(1);
  gates[0]!.resolve("KEEP");
  expect(await a).toBeNull();
  await waitForCalls(3);
  // Only the latest parked prompt ran; prompt two was superseded.
  expect(gates.length).toBe(2);
  expect(calls[2]!.prompt).toContain("Prompt three");
  gates[1]!.resolve("Migrate billing to Stripe");
  expect(await Promise.all([b, c])).toEqual([
    "Migrate billing to Stripe",
    "Migrate billing to Stripe",
  ]);
  expect(titles.getGeneratedTitle(id)).toBe("Migrate billing to Stripe");
  // The lane is free again: a new prompt runs immediately.
  answer = async () => "KEEP";
  await titles.refreshGeneratedTitle(
    id,
    "Prompt four is long enough to be judged by the model for sure",
    { user: "ada", session },
  );
  expect(calls.length).toBe(4);
});

test("a parked refresh is judged against the title the previous call stored", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  const gate = deferred<string | null>();
  answer = () => gate.promise;
  const a = titles.refreshGeneratedTitle(
    id,
    "Prompt one is long enough to be judged by the model for sure",
    { user: "ada", session },
  );
  const b = titles.refreshGeneratedTitle(
    id,
    "Prompt two is long enough to be judged by the model for sure",
    { user: "ada", session },
  );
  await waitForCalls(2);
  answer = async () => "KEEP";
  gate.resolve("Fix flaky login test");
  expect(await a).toBe("Fix flaky login test");
  expect(await b).toBeNull();
  expect(calls[2]!.prompt).toContain('titled "Fix flaky login test"');
});

test("a throwing model call is soft and frees the lane", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Please add an onboarding flow");
  answer = async () => {
    throw new Error("provider down");
  };
  expect(
    await titles.refreshGeneratedTitle(
      id,
      "Prompt one is long enough to be judged by the model for sure",
      { user: "ada", session },
    ),
  ).toBeNull();
  expect(titles.getGeneratedTitle(id)).toBe("Add onboarding flow");
  // The lane is free: the next prompt reaches the model.
  answer = async () => "KEEP";
  await titles.refreshGeneratedTitle(
    id,
    "Prompt two is long enough to be judged by the model for sure",
    { user: "ada", session },
  );
  expect(calls.length).toBe(3);
});

test("a session without a title yet is not refreshed; ensure covers it", async () => {
  const id = sessionId();
  answer = async () => "Fix flaky login test";
  expect(
    await titles.refreshGeneratedTitle(
      id,
      "Switch to the flaky login integration test and find out why it fails",
      { user: "ada", session: { title: "New session" } },
    ),
  ).toBeNull();
  expect(calls.length).toBe(0);
});

test("a manual rename blocks the first generation too, before and during the call", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  overrides.setTitleOverride(id, "My chosen name");
  try {
    expect(await titles.ensureGeneratedTitle(id, "Please add onboarding")).toBe(
      null,
    );
    expect(calls.length).toBe(0);
  } finally {
    overrides.setTitleOverride(id, null);
  }
  const gate = deferred<string | null>();
  answer = () => gate.promise;
  const pending = titles.ensureGeneratedTitle(id, "Please add onboarding");
  await waitForCalls(1);
  overrides.setTitleOverride(id, "My chosen name");
  try {
    gate.resolve("Add onboarding flow");
    expect(await pending).toBeNull();
  } finally {
    overrides.setTitleOverride(id, null);
  }
  expect(titles.getGeneratedTitle(id)).toBeUndefined();
});

test("desk session files keep their fixed title on the ensure path", async () => {
  const id = sessionId();
  writeFileSync(
    join(sessionsDir, `${id}.json`),
    JSON.stringify({ id, desk: true, title: "Desk" }),
  );
  answer = async () => "Plan the week";
  expect(await titles.ensureGeneratedTitle(id, "Plan my week")).toBeNull();
  expect(calls.length).toBe(0);
});

test("the pending workspace marker names the workspace once, only while it wears the marked name", async () => {
  const id = sessionId();
  let marker: { id: string; name: string } | null = {
    id: "ws-1",
    name: "New workspace",
  };
  let workspaceName = "New workspace";
  const renames: string[] = [];
  const io = {
    async readMarker() {
      return marker;
    },
    async clearMarker(_id: string, expected: { id: string; name: string }) {
      if (marker?.id === expected.id && marker.name === expected.name)
        marker = null;
    },
    async getWorkspace() {
      return { name: workspaceName };
    },
    async renameWorkspace(_id: string, name: string, expectedName: string) {
      if (workspaceName !== expectedName) return false;
      renames.push(name);
      workspaceName = name;
      return true;
    },
  };
  expect(
    await titles.applyPendingWorkspaceTitle(id, "Add onboarding flow", io),
  ).toBe(true);
  expect(renames).toEqual(["Add onboarding flow"]);
  // The marker is gone: a second title never renames again.
  expect(
    await titles.applyPendingWorkspaceTitle(id, "Fix login test", io),
  ).toBe(false);
  expect(renames).toEqual(["Add onboarding flow"]);
  // A manual workspace rename before the title lands wins.
  marker = { id: "ws-1", name: "New workspace" };
  workspaceName = "Chosen by hand";
  expect(
    await titles.applyPendingWorkspaceTitle(id, "Add onboarding flow", io),
  ).toBe(false);
  expect(renames).toEqual(["Add onboarding flow"]);
  // Failures are soft.
  marker = { id: "ws-1", name: "Chosen by hand" };
  expect(
    await titles.applyPendingWorkspaceTitle(id, "Add onboarding flow", {
      ...io,
      async renameWorkspace() {
        throw new Error("disk full");
      },
    }),
  ).toBe(false);
  expect(marker).toEqual({ id: "ws-1", name: "Chosen by hand" });
  expect(
    await titles.applyPendingWorkspaceTitle(id, "Add onboarding flow", io),
  ).toBe(true);
  expect(marker).toBeNull();
});

test("revisiting an earlier task after another task can refresh its title again", async () => {
  const id = sessionId();
  answer = async () => "Add onboarding flow";
  await titles.ensureGeneratedTitle(id, "Add onboarding flow");
  answer = async () => "Fix login tests";
  await titles.refreshGeneratedTitle(id, "Fix login tests", { session });
  answer = async () => "Add dark mode";
  await titles.refreshGeneratedTitle(id, "Add dark mode", { session });
  answer = async () => "Fix login tests";
  expect(
    await titles.refreshGeneratedTitle(id, "Fix login tests", { session }),
  ).toBe("Fix login tests");
});

test("a persisted title retries failed workspace naming through the catalog sweep without another model call", async () => {
  const {
    SessionKernelStore,
    __setSessionKernelStoreForTest,
    sessionMetadata,
  } = await import("./session-kernel");
  const { SessionListStore, __setSessionListStoreForTest } =
    await import("./session-list-store");
  const { updateSessionFile } = await import("./session-cache");
  const workspaces = await import("./workspaces");
  const store = new SessionKernelStore(":memory:");
  const previous = __setSessionKernelStoreForTest(store);
  const index = new SessionListStore(":memory:");
  const previousIndex = __setSessionListStoreForTest(index);
  let restoreRename: (() => void) | undefined;
  try {
    const id = sessionId();
    const workspace = await workspaces.createWorkspace({
      name: "Workspace",
      createdBy: "Alex",
    });
    await updateSessionFile(id, () => ({
      id,
      claudeSessionId: "",
      branch: "",
      worktreeDir: sessionsDir,
      createdBy: "Alex",
      createdAt: "2000-01-01T00:00:00.000Z",
      lastActivity: "2000-01-01T00:00:00.000Z",
      title: "Add onboarding flow",
      workspaceId: workspace.id,
      pendingWorkspaceTitle: { id: workspace.id, name: workspace.name },
    }));
    await sessionMetadata({ op: "mark_catalog_complete" });
    const rename = spyOn(workspaces, "updateWorkspace").mockRejectedValue(
      new Error("catalog temporarily unavailable"),
    );
    restoreRename = () => rename.mockRestore();
    answer = async () => "Add onboarding flow";
    expect(await titles.ensureGeneratedTitle(id, "Please add onboarding")).toBe(
      "Add onboarding flow",
    );
    expect(titles.getGeneratedTitle(id)).toBe("Add onboarding flow");
    const doc = () =>
      readFile(join(sessionsDir, `${id}.json`), "utf8").then(JSON.parse);
    expect((await doc()).pendingWorkspaceTitle).toEqual({
      id: workspace.id,
      name: "Workspace",
    });
    expect((await workspaces.getWorkspace(workspace.id))?.name).toBe(
      "Workspace",
    );
    // Existing titles, even outside the normal three-day window, remain retryable.
    expect(await titles.sweepCandidates()).toContainEqual({
      id,
      title: "Add onboarding flow",
    });
    restoreRename();
    restoreRename = undefined;
    await titles.ensureGeneratedTitle(id, "Please add onboarding");
    expect(calls).toHaveLength(1);
    expect((await workspaces.getWorkspace(workspace.id))?.name).toBe(
      "Add onboarding flow",
    );
    expect((await doc()).pendingWorkspaceTitle).toBeUndefined();
    expect(await titles.sweepCandidates()).not.toContainEqual({
      id,
      title: "Add onboarding flow",
    });
  } finally {
    restoreRename?.();
    __setSessionKernelStoreForTest(previous);
    __setSessionListStoreForTest(previousIndex);
    workspaces.__resetWorkspaceProjectionForTest();
    store.close();
    index.close();
  }
});

test("workspace read and marker-clear failures retain retry intent without renaming twice", async () => {
  const id = sessionId();
  let marker: { id: string; name: string } | null = {
    id: "ws-retry",
    name: "Workspace",
  };
  let workspaceName = "Workspace";
  let failRead = true;
  let failClear = true;
  let renames = 0;
  const io = {
    async readMarker() {
      return marker;
    },
    async clearMarker() {
      if (failClear) throw new Error("metadata unavailable");
      marker = null;
    },
    async getWorkspace() {
      if (failRead) throw new Error("catalog unavailable");
      return { name: workspaceName };
    },
    async renameWorkspace(_id: string, name: string, expected: string) {
      if (workspaceName !== expected) return false;
      workspaceName = name;
      renames++;
      return true;
    },
  };
  expect(
    await titles.applyPendingWorkspaceTitle(id, "Add onboarding flow", io),
  ).toBe(false);
  expect(marker).not.toBeNull();
  failRead = false;
  expect(
    await titles.applyPendingWorkspaceTitle(id, "Add onboarding flow", io),
  ).toBe(false);
  expect(marker).not.toBeNull();
  expect(workspaceName).toBe("Add onboarding flow");
  failClear = false;
  await titles.applyPendingWorkspaceTitle(id, "Add onboarding flow", io);
  expect(marker).toBeNull();
  expect(renames).toBe(1);
});
