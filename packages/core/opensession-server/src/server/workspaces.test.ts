import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Workspaces live in the kernel's central application catalog. Every test
// gets a fresh in-memory kernel store and a cold projection, and the legacy
// export directory points at a scratch state root so nothing touches the
// operator's store. Re-pin the env per test too: bun runs all test files in
// one process, and another file's afterAll restoring the env mid-suite would
// otherwise send this file's exports into the live directory.
const scratch = mkdtempSync(join(tmpdir(), "opensession-workspaces-"));
const previous = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const { catalogDocuments, importApplicationCatalog } =
  await import("./catalog-documents");
const {
  DEFAULT_WORKSPACE_MODEL_SETTINGS,
  __resetWorkspaceProjectionForTest,
  createWorkspace,
  deleteWorkspace,
  findWorkspaceByBranch,
  findWorkspaceByKey,
  findWorkspaceByWorktree,
  getWorkspace,
  listWorkspaces,
  peekWorkspace,
  restampWorkspaceWorktree,
  stampWorkspaceIdentity,
  updateWorkspace,
  warmWorkspacesAsync,
  workspaceListVersion,
  workspaceName,
  workspaceNameSnapshot,
} = await import("./workspaces");
const { defaultRepo } = await import("./config");

let store: InstanceType<typeof SessionKernelStore>;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;

beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = scratch;
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  __resetWorkspaceProjectionForTest();
});

afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  __resetWorkspaceProjectionForTest();
});

afterAll(() => {
  if (previous === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previous;
  rmSync(scratch, { recursive: true, force: true });
});

/** Put a raw document in the catalog behind this module's back, the way an
 *  import or an operator repair would. */
async function seedRaw(id: string, value: unknown): Promise<void> {
  await catalogDocuments("workspaces").set(id, value);
}

describe("default workspace model settings", () => {
  test("offers Fable planning with an Astra high implementation worker", () => {
    expect(
      DEFAULT_WORKSPACE_MODEL_SETTINGS.presets?.find(
        (preset) => preset.id === "orchestrator-fable-sol",
      ),
    ).toMatchObject({
      label: "Orchestrator · Fable + Astra",
      lead: { model: "pi/anthropic/claude-fable-5-1", effort: "high" },
      supporting: [
        {
          model: "pi/openai/gpt-6-astra",
          effort: "high",
          role: "Implementation worker",
        },
      ],
    });
  });
});

describe("catalog storage", () => {
  test("a created workspace reads back from the catalog", async () => {
    const ws = await createWorkspace({ name: "Catalog", createdBy: "Kent" });
    expect(ws.id).toMatch(/^ws-/);
    expect(await getWorkspace(ws.id)).toEqual(ws);
    expect(await catalogDocuments("workspaces").get(ws.id)).toEqual(ws);
  });

  test("lists in sidebar order and follows writes", async () => {
    const b = await createWorkspace({
      name: "B",
      createdBy: "Kent",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    const a = await createWorkspace({
      name: "A",
      createdBy: "Kent",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect((await listWorkspaces()).map((w) => w.id)).toEqual([a.id, b.id]);
    const before = workspaceListVersion();
    await updateWorkspace(a.id, { order: 2 });
    await updateWorkspace(b.id, { order: 1 });
    expect(workspaceListVersion()).not.toBe(before);
    expect((await listWorkspaces()).map((w) => w.id)).toEqual([b.id, a.id]);
    await deleteWorkspace(b.id);
    expect((await listWorkspaces()).map((w) => w.id)).toEqual([a.id]);
  });

  test("the list survives a write racing the warm-up", async () => {
    await seedRaw("ws-seeded", {
      id: "ws-seeded",
      name: "Seeded",
      createdBy: "Kent",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const warm = warmWorkspacesAsync();
    const fresh = await createWorkspace({ name: "Fresh", createdBy: "Kent" });
    await warm;
    expect((await listWorkspaces()).map((w) => w.id).sort()).toEqual(
      [fresh.id, "ws-seeded"].sort(),
    );
  });

  test("delete reports whether anything existed", async () => {
    const ws = await createWorkspace({ name: "Gone", createdBy: "Kent" });
    expect(await deleteWorkspace(ws.id)).toBe(true);
    expect(await deleteWorkspace(ws.id)).toBe(false);
    expect(await getWorkspace(ws.id)).toBeNull();
    expect(await deleteWorkspace("../etc/passwd")).toBe(false);
  });

  test("an update on a missing workspace is null, not a tombstone", async () => {
    expect(await updateWorkspace("ws-missing", { name: "x" })).toBeNull();
    expect(await stampWorkspaceIdentity("ws-missing", { key: "k" })).toBeNull();
    expect(
      await restampWorkspaceWorktree("ws-missing", { repo: "opensession" }),
    ).toBeNull();
    await createWorkspace({ id: "ws-missing", name: "Now", createdBy: "Kent" });
    expect((await getWorkspace("ws-missing"))?.name).toBe("Now");
  });

  test("finders read the whole catalog", async () => {
    const older = await createWorkspace({
      name: "Older",
      createdBy: "Kent",
      key: "ghpr-1",
      branch: "feat",
      worktreeDir: "/tmp/wt-feat",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await createWorkspace({
      name: "Newer",
      createdBy: "Kent",
      branch: "feat",
      worktreeDir: "/tmp/wt-feat",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    expect((await findWorkspaceByKey("ghpr-1"))?.id).toBe(older.id);
    expect((await findWorkspaceByWorktree("/tmp/wt-feat"))?.id).toBe(older.id);
    expect((await findWorkspaceByBranch(defaultRepo().id, "feat"))?.id).toBe(
      older.id,
    );
    expect(await findWorkspaceByKey("nope")).toBeNull();
  });

  test("a swapped kernel store starts from a cold projection", async () => {
    const ws = await createWorkspace({ name: "Old store", createdBy: "Kent" });
    expect(peekWorkspace(ws.id)?.name).toBe("Old store");
    await warmWorkspacesAsync();
    expect(peekWorkspace(ws.id)?.name).toBe("Old store");
    const other = new SessionKernelStore(":memory:");
    const swapped = __setSessionKernelStoreForTest(other);
    __resetWorkspaceProjectionForTest();
    try {
      expect(peekWorkspace(ws.id)).toBeNull();
      expect(await getWorkspace(ws.id)).toBeNull();
      expect(await listWorkspaces()).toEqual([]);
    } finally {
      __setSessionKernelStoreForTest(swapped);
      other.close();
      __resetWorkspaceProjectionForTest();
    }
    expect((await getWorkspace(ws.id))?.name).toBe("Old store");
  });
});

describe("stampWorkspaceIdentity", () => {
  test("adopts the PR's repo when the workspace was minted in another one", async () => {
    // The real shape: a session working in repo A opens a PR in repo B
    // through an attached repo, and the workspace it minted carries repo A.
    const ws = await createWorkspace({
      name: "Keep the video playing",
      repo: "opensession",
      createdBy: "Kent",
    });
    const out = await stampWorkspaceIdentity(ws.id, {
      key: "ghpr-5678",
      prNumber: 5678,
      branch: "keep-editor-playing-on-tool-switch",
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("tella-fusion");
    expect(out?.branch).toBe("keep-editor-playing-on-tool-switch");
    expect((await getWorkspace(ws.id))?.repo).toBe("tella-fusion");
  });

  test("leaves the repo alone once the workspace owns a branch", async () => {
    const ws = await createWorkspace({
      name: "Its own branch",
      repo: "opensession",
      createdBy: "Kent",
      branch: "some-branch",
    });
    const out = await stampWorkspaceIdentity(ws.id, {
      key: "ghpr-42",
      prNumber: 42,
      branch: "other-branch",
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("opensession");
    expect(out?.branch).toBe("some-branch");
  });

  test("repairs a PR workspace stuck on its review checkout branch", async () => {
    const ws = await createWorkspace({
      name: "#306 Answer the ask card's letters",
      repo: "opensession",
      createdBy: "GitHub (automation)",
      key: "ghpr-opensession-306",
      prNumber: 306,
      branch: "ask-question-shortcuts-os-review",
    });
    const out = await stampWorkspaceIdentity(ws.id, {
      key: "ghpr-opensession-306",
      prNumber: 306,
      branch: "ask-question-shortcuts",
      repo: "opensession",
    });
    expect(out?.branch).toBe("ask-question-shortcuts");
    expect((await getWorkspace(ws.id))?.branch).toBe("ask-question-shortcuts");
  });

  test("leaves the repo alone once the workspace owns a worktree", async () => {
    const ws = await createWorkspace({
      name: "Materialized",
      repo: "opensession",
      createdBy: "Kent",
      worktreeDir: "/home/ubuntu/worktrees/opensession-thing",
    });
    const out = await stampWorkspaceIdentity(ws.id, {
      prNumber: 7,
      branch: "b",
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("opensession");
  });

  test("stamping the same repo is a no-op", async () => {
    const ws = await createWorkspace({
      name: "Same repo",
      repo: "tella-fusion",
      createdBy: "Kent",
    });
    const out = await stampWorkspaceIdentity(ws.id, {
      prNumber: 9,
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("tella-fusion");
  });

  test("refusing a re-key leaves the document untouched", async () => {
    const ws = await createWorkspace({
      name: "Keyed",
      createdBy: "Kent",
      key: "ghpr-1",
    });
    const version = workspaceListVersion();
    const out = await stampWorkspaceIdentity(ws.id, { key: "ghpr-2" });
    expect(out).toEqual(ws);
    expect(workspaceListVersion()).toBe(version);
  });
});

// The sessions list stamps each row with this name, so a stale answer would
// title a sidebar row after a workspace's old name (or after a workspace that
// no longer exists) until the server restarted.
describe("workspaceName", () => {
  test("follows create, rename and delete", async () => {
    const ws = await createWorkspace({
      name: "Add sound effects",
      createdBy: "Kent",
    });
    expect(workspaceName(ws.id)).toBe("Add sound effects");
    await updateWorkspace(ws.id, { name: "Add a sound library" });
    expect(workspaceName(ws.id)).toBe("Add a sound library");
    expect(workspaceNameSnapshot().get(ws.id)).toBe("Add a sound library");
    await deleteWorkspace(ws.id);
    expect(workspaceName(ws.id)).toBeNull();
    expect(workspaceNameSnapshot().has(ws.id)).toBe(false);
  });

  test("survives identity stamping, which rewrites the document", async () => {
    const ws = await createWorkspace({
      name: "Adopted by a PR",
      createdBy: "Kent",
    });
    await stampWorkspaceIdentity(ws.id, { key: "ghpr-1", prNumber: 1 });
    expect(workspaceName(ws.id)).toBe("Adopted by a PR");
  });

  test("refuses an unsafe id", () => {
    expect(workspaceName("../etc/passwd")).toBeNull();
    expect(peekWorkspace("../etc/passwd")).toBeNull();
  });

  test("is cold until warmed, then serves the catalog", async () => {
    await seedRaw("ws-cold", {
      id: "ws-cold",
      name: "Cold start",
      createdBy: "Kent",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect(workspaceName("ws-cold")).toBeNull();
    expect(workspaceNameSnapshot().size).toBe(0);
    await warmWorkspacesAsync();
    expect(workspaceName("ws-cold")).toBe("Cold start");
    expect(peekWorkspace("ws-cold")?.name).toBe("Cold start");
  });

  test("an authoritative read refreshes a projection that drifted", async () => {
    const ws = await createWorkspace({ name: "Before", createdBy: "Kent" });
    await seedRaw(ws.id, { ...ws, name: "After" });
    expect(peekWorkspace(ws.id)?.name).toBe("Before");
    expect((await getWorkspace(ws.id))?.name).toBe("After");
    expect(peekWorkspace(ws.id)?.name).toBe("After");
    // A read that finds nothing new leaves the list version alone.
    const version = workspaceListVersion();
    await getWorkspace(ws.id);
    expect(workspaceListVersion()).toBe(version);
  });
});

describe("the retired automatic repository sentinel", () => {
  test("repairs old workspace documents to the registered default on read", async () => {
    const ws = await createWorkspace({
      name: "Old automatic workspace",
      repo: "opensession",
      createdBy: "Kent",
    });
    await seedRaw(ws.id, { ...ws, repo: "auto" });

    expect((await getWorkspace(ws.id))?.repo).toBe(defaultRepo().id);
  });

  test("never writes the sentinel through create or update", async () => {
    const ws = await createWorkspace({
      name: "Stale create",
      repo: "auto",
      createdBy: "Kent",
    });
    expect(ws.repo).toBe(defaultRepo().id);
    expect((await updateWorkspace(ws.id, { repo: "auto" }))?.repo).toBe(
      defaultRepo().id,
    );
  });
});

// Open Session's own repo was renamed, and workspaces written before it still
// say `backstage` in the catalog. Clients group by the id they are handed, so
// an un-normalized read draws the repo a second sidebar band with no icon.
describe("a repo that has been renamed", () => {
  test("reads back under the id it is registered under now", async () => {
    const ws = await createWorkspace({
      name: "Written before the rename",
      repo: "opensession",
      createdBy: "Kent",
    });
    await seedRaw(ws.id, {
      ...ws,
      repo: "backstage",
      attachedRepos: [{ repo: "backstage", branch: "main", dir: "/tmp/wt" }],
    });
    __resetWorkspaceProjectionForTest();

    expect((await getWorkspace(ws.id))?.repo).toBe("opensession");
    expect((await getWorkspace(ws.id))?.attachedRepos?.[0]?.repo).toBe(
      "opensession",
    );
    expect((await listWorkspaces()).find((w) => w.id === ws.id)?.repo).toBe(
      "opensession",
    );
  });

  test("a legacy file imported at boot reads back normalized", async () => {
    const dir = join(scratch, ".opensession-workspaces");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ws-legacy.json"),
      JSON.stringify({
        id: "ws-legacy",
        name: "From the file",
        repo: "backstage",
        createdBy: "Kent",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    try {
      await importApplicationCatalog();
      expect((await getWorkspace("ws-legacy"))?.repo).toBe("opensession");
      // Earlier tests exported their documents into the same legacy
      // directory, and the import seeds those too.
      expect((await listWorkspaces()).map((w) => w.id)).toContain("ws-legacy");
    } finally {
      rmSync(join(dir, "ws-legacy.json"), { force: true });
    }
  });

  test("leaves an id that is registered alone", async () => {
    const ws = await createWorkspace({
      name: "Written after it",
      repo: "opensession",
      createdBy: "Kent",
    });
    expect((await getWorkspace(ws.id))?.repo).toBe("opensession");
  });
});

describe("workspace draft", () => {
  test("create carries a draft", async () => {
    const ws = await createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
      draft: {
        text: "fix the flaky test",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    expect((await getWorkspace(ws.id))?.draft?.text).toBe("fix the flaky test");
  });

  test("no draft on create means absent, not backfilled", async () => {
    const ws = await createWorkspace({ name: "No draft", createdBy: "Kent" });
    expect((await getWorkspace(ws.id))?.draft).toBeUndefined();
  });

  test("caps draft text at 32k on create", async () => {
    const ws = await createWorkspace({
      name: "Huge draft",
      createdBy: "Kent",
      draft: {
        text: "x".repeat(40_000),
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    expect((await getWorkspace(ws.id))?.draft?.text.length).toBe(32_000);
  });

  test("an update applies when there's no prior draft", async () => {
    const ws = await createWorkspace({ name: "Fresh", createdBy: "Kent" });
    const out = await updateWorkspace(ws.id, {
      draft: { text: "first draft", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    expect(out?.draft?.text).toBe("first draft");
  });

  test("a newer draft wins", async () => {
    const ws = await createWorkspace({
      name: "Newer wins",
      createdBy: "Kent",
      draft: { text: "old text", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    const out = await updateWorkspace(ws.id, {
      draft: { text: "new text", updatedAt: "2026-08-15T10:05:00.000Z" },
    });
    expect(out?.draft?.text).toBe("new text");
  });

  test("an older draft is refused", async () => {
    const ws = await createWorkspace({
      name: "Refuse older",
      createdBy: "Kent",
      draft: { text: "kept text", updatedAt: "2026-08-15T10:05:00.000Z" },
    });
    const out = await updateWorkspace(ws.id, {
      draft: { text: "stale text", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    expect(out?.draft?.text).toBe("kept text");
    expect((await getWorkspace(ws.id))?.draft?.text).toBe("kept text");
  });

  test("null clears the draft", async () => {
    const ws = await createWorkspace({
      name: "Clear me",
      createdBy: "Kent",
      draft: { text: "goodbye", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    const out = await updateWorkspace(ws.id, { draft: null });
    expect(out?.draft).toBeUndefined();
    expect((await getWorkspace(ws.id))?.draft).toBeUndefined();
  });

  test("caps draft text at 32k on update", async () => {
    const ws = await createWorkspace({
      name: "Cap on update",
      createdBy: "Kent",
    });
    const out = await updateWorkspace(ws.id, {
      draft: {
        text: "y".repeat(50_000),
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    expect(out?.draft?.text.length).toBe(32_000);
  });

  test("autoName follows the draft's first non-empty line", async () => {
    const ws = await createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    const out = await updateWorkspace(ws.id, {
      draft: {
        text: "\n  Fix the flaky login test  \nsome more detail here",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    expect(out?.name).toBe("Fix the flaky login test");
    expect(out?.draft?.autoName).toBe(true);
  });

  test("autoName keeps following on later draft updates", async () => {
    const ws = await createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    await updateWorkspace(ws.id, {
      draft: {
        text: "first line",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    const out = await updateWorkspace(ws.id, {
      draft: {
        text: "second line",
        updatedAt: "2026-08-15T10:05:00.000Z",
        autoName: true,
      },
    });
    expect(out?.name).toBe("second line");
  });

  test("a blank first line keeps the current name", async () => {
    const ws = await createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    const out = await updateWorkspace(ws.id, {
      draft: {
        text: "   \n\n  ",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    expect(out?.name).toBe("Untitled workspace");
  });

  test("manual rename sets autoName false and stops the follow", async () => {
    const ws = await createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    await updateWorkspace(ws.id, {
      draft: {
        text: "draft-derived name",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    const renamed = await updateWorkspace(ws.id, {
      name: "Manually chosen name",
    });
    expect(renamed?.name).toBe("Manually chosen name");
    expect(renamed?.draft?.autoName).toBe(false);

    // A later draft update no longer renames the workspace.
    const later = await updateWorkspace(ws.id, {
      draft: {
        text: "trying to rename again",
        updatedAt: "2026-08-15T10:10:00.000Z",
        autoName: true,
      },
    });
    expect(later?.name).toBe("Manually chosen name");
  });

  test("autoName:false on the incoming draft does not rename", async () => {
    const ws = await createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    const out = await updateWorkspace(ws.id, {
      draft: {
        text: "should not rename",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: false,
      },
    });
    expect(out?.name).toBe("Untitled workspace");
    expect(out?.draft?.autoName).toBe(false);
  });

  test("concurrent drafts serialize through the catalog", async () => {
    const ws = await createWorkspace({ name: "Race", createdBy: "Kent" });
    await Promise.all([
      updateWorkspace(ws.id, {
        draft: { text: "one", updatedAt: "2026-08-15T10:00:00.000Z" },
      }),
      updateWorkspace(ws.id, { color: "blue" }),
      updateWorkspace(ws.id, { order: 3 }),
    ]);
    expect(await getWorkspace(ws.id)).toMatchObject({
      draft: { text: "one" },
      color: "blue",
      order: 3,
    });
  });
});
