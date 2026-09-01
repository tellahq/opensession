import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// workspaces.ts resolves its directory per call (statePath reads the env at
// call time), so pointing OPENSESSION_STATE_DIR at a scratch dir isolates
// every write. Re-pin it before each test too: bun runs all test files in one
// process, and another file's afterAll restoring the env mid-suite would
// otherwise send this file's fixtures into the live store.
let scratch = "";
let previous: string | undefined;
scratch = mkdtempSync(join(tmpdir(), "opensession-workspaces-"));
previous = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;
beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = scratch;
});

const {
  DEFAULT_WORKSPACE_MODEL_SETTINGS,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  stampWorkspaceIdentity,
  updateWorkspace,
  workspaceName,
} = await import("./workspaces");
const { defaultRepo } = await import("./config");

afterAll(() => {
  if (previous === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previous;
  rmSync(scratch, { recursive: true, force: true });
});

describe("default workspace model settings", () => {
  test("offers Fable planning with a Sol high implementation worker", () => {
    expect(
      DEFAULT_WORKSPACE_MODEL_SETTINGS.presets?.find(
        (preset) => preset.id === "orchestrator-fable-sol",
      ),
    ).toMatchObject({
      label: "Orchestrator · Fable + Sol",
      lead: { model: "pi/anthropic/claude-fable-5", effort: "high" },
      supporting: [
        {
          model: "pi/openai/gpt-5.6-sol",
          effort: "high",
          role: "Implementation worker",
        },
      ],
    });
  });
});

describe("stampWorkspaceIdentity", () => {
  test("adopts the PR's repo when the workspace was minted in another one", () => {
    // The real shape: a session working in repo A opens a PR in repo B
    // through an attached repo, and the workspace it minted carries repo A.
    const ws = createWorkspace({
      name: "Keep the video playing",
      repo: "opensession",
      createdBy: "Kent",
    });
    const out = stampWorkspaceIdentity(ws.id, {
      key: "ghpr-5678",
      prNumber: 5678,
      branch: "keep-editor-playing-on-tool-switch",
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("tella-fusion");
    expect(out?.branch).toBe("keep-editor-playing-on-tool-switch");
    expect(getWorkspace(ws.id)?.repo).toBe("tella-fusion");
  });

  test("leaves the repo alone once the workspace owns a branch", () => {
    const ws = createWorkspace({
      name: "Its own branch",
      repo: "opensession",
      createdBy: "Kent",
      branch: "some-branch",
    });
    const out = stampWorkspaceIdentity(ws.id, {
      key: "ghpr-42",
      prNumber: 42,
      branch: "other-branch",
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("opensession");
    expect(out?.branch).toBe("some-branch");
  });

  test("leaves the repo alone once the workspace owns a worktree", () => {
    const ws = createWorkspace({
      name: "Materialized",
      repo: "opensession",
      createdBy: "Kent",
      worktreeDir: "/home/ubuntu/worktrees/opensession-thing",
    });
    const out = stampWorkspaceIdentity(ws.id, {
      prNumber: 7,
      branch: "b",
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("opensession");
  });

  test("stamping the same repo is a no-op", () => {
    const ws = createWorkspace({
      name: "Same repo",
      repo: "tella-fusion",
      createdBy: "Kent",
    });
    const out = stampWorkspaceIdentity(ws.id, {
      prNumber: 9,
      repo: "tella-fusion",
    });
    expect(out?.repo).toBe("tella-fusion");
  });
});

// The sessions list stamps each row with this name, so a stale answer would
// title a sidebar row after a workspace's old name (or after a workspace that
// no longer exists) until the server restarted.
describe("workspaceName", () => {
  test("follows create, rename and delete", () => {
    const ws = createWorkspace({
      name: "Add sound effects",
      createdBy: "Kent",
    });
    expect(workspaceName(ws.id)).toBe("Add sound effects");
    updateWorkspace(ws.id, { name: "Add a sound library" });
    expect(workspaceName(ws.id)).toBe("Add a sound library");
    deleteWorkspace(ws.id);
    expect(workspaceName(ws.id)).toBeNull();
  });

  test("survives identity stamping, which rewrites the file", () => {
    const ws = createWorkspace({ name: "Adopted by a PR", createdBy: "Kent" });
    stampWorkspaceIdentity(ws.id, { key: "ghpr-1", prNumber: 1 });
    expect(workspaceName(ws.id)).toBe("Adopted by a PR");
  });

  test("refuses an unsafe id", () => {
    expect(workspaceName("../etc/passwd")).toBeNull();
  });

  test("follows the active state root", () => {
    const otherRoot = mkdtempSync(
      join(tmpdir(), "opensession-workspaces-other-"),
    );
    const id = "ws-state-root-switch";
    try {
      createWorkspace({ id, name: "First root", createdBy: "Kent" });
      expect(workspaceName(id)).toBe("First root");

      process.env.OPENSESSION_STATE_DIR = otherRoot;
      createWorkspace({ id, name: "Second root", createdBy: "Kent" });
      expect(workspaceName(id)).toBe("Second root");

      process.env.OPENSESSION_STATE_DIR = scratch;
      expect(workspaceName(id)).toBe("First root");
    } finally {
      process.env.OPENSESSION_STATE_DIR = scratch;
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("the retired automatic repository sentinel", () => {
  test("repairs old workspace files to the registered default on read", () => {
    const ws = createWorkspace({
      name: "Old automatic workspace",
      repo: "opensession",
      createdBy: "Kent",
    });
    writeFileSync(
      join(scratch, ".opensession-workspaces", `${ws.id}.json`),
      JSON.stringify({ ...ws, repo: "auto" }),
    );

    expect(getWorkspace(ws.id)?.repo).toBe(defaultRepo().id);
  });

  test("never writes the sentinel through create or update", () => {
    const ws = createWorkspace({
      name: "Stale create",
      repo: "auto",
      createdBy: "Kent",
    });
    expect(ws.repo).toBe(defaultRepo().id);
    expect(updateWorkspace(ws.id, { repo: "auto" })?.repo).toBe(
      defaultRepo().id,
    );
  });
});

// Open Session's own repo was renamed, and workspaces written before it still
// say `backstage` on disk. Clients group by the id they are handed, so an
// un-normalized read draws the repo a second sidebar band with no icon.
describe("a repo that has been renamed", () => {
  test("reads back under the id it is registered under now", () => {
    const ws = createWorkspace({
      name: "Written before the rename",
      repo: "opensession",
      createdBy: "Kent",
    });
    writeFileSync(
      join(scratch, ".opensession-workspaces", `${ws.id}.json`),
      JSON.stringify({
        ...ws,
        repo: "backstage",
        attachedRepos: [{ repo: "backstage", branch: "main", dir: "/tmp/wt" }],
      }),
    );

    expect(getWorkspace(ws.id)?.repo).toBe("opensession");
    expect(getWorkspace(ws.id)?.attachedRepos?.[0]?.repo).toBe("opensession");
    expect(listWorkspaces().find((w) => w.id === ws.id)?.repo).toBe(
      "opensession",
    );
  });

  test("leaves an id that is registered alone", () => {
    const ws = createWorkspace({
      name: "Written after it",
      repo: "opensession",
      createdBy: "Kent",
    });
    expect(getWorkspace(ws.id)?.repo).toBe("opensession");
  });
});

describe("workspace draft", () => {
  test("create carries a draft", () => {
    const ws = createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
      draft: {
        text: "fix the flaky test",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    expect(getWorkspace(ws.id)?.draft?.text).toBe("fix the flaky test");
  });

  test("no draft on create means absent, not backfilled", () => {
    const ws = createWorkspace({ name: "No draft", createdBy: "Kent" });
    expect(getWorkspace(ws.id)?.draft).toBeUndefined();
  });

  test("caps draft text at 32k on create", () => {
    const ws = createWorkspace({
      name: "Huge draft",
      createdBy: "Kent",
      draft: {
        text: "x".repeat(40_000),
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    expect(getWorkspace(ws.id)?.draft?.text.length).toBe(32_000);
  });

  test("an update applies when there's no prior draft", () => {
    const ws = createWorkspace({ name: "Fresh", createdBy: "Kent" });
    const out = updateWorkspace(ws.id, {
      draft: { text: "first draft", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    expect(out?.draft?.text).toBe("first draft");
  });

  test("a newer draft wins", () => {
    const ws = createWorkspace({
      name: "Newer wins",
      createdBy: "Kent",
      draft: { text: "old text", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    const out = updateWorkspace(ws.id, {
      draft: { text: "new text", updatedAt: "2026-08-15T10:05:00.000Z" },
    });
    expect(out?.draft?.text).toBe("new text");
  });

  test("an older draft is refused", () => {
    const ws = createWorkspace({
      name: "Refuse older",
      createdBy: "Kent",
      draft: { text: "kept text", updatedAt: "2026-08-15T10:05:00.000Z" },
    });
    const out = updateWorkspace(ws.id, {
      draft: { text: "stale text", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    expect(out?.draft?.text).toBe("kept text");
    expect(getWorkspace(ws.id)?.draft?.text).toBe("kept text");
  });

  test("null clears the draft", () => {
    const ws = createWorkspace({
      name: "Clear me",
      createdBy: "Kent",
      draft: { text: "goodbye", updatedAt: "2026-08-15T10:00:00.000Z" },
    });
    const out = updateWorkspace(ws.id, { draft: null });
    expect(out?.draft).toBeUndefined();
    expect(getWorkspace(ws.id)?.draft).toBeUndefined();
  });

  test("caps draft text at 32k on update", () => {
    const ws = createWorkspace({ name: "Cap on update", createdBy: "Kent" });
    const out = updateWorkspace(ws.id, {
      draft: {
        text: "y".repeat(50_000),
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    expect(out?.draft?.text.length).toBe(32_000);
  });

  test("autoName follows the draft's first non-empty line", () => {
    const ws = createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    const out = updateWorkspace(ws.id, {
      draft: {
        text: "\n  Fix the flaky login test  \nsome more detail here",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    expect(out?.name).toBe("Fix the flaky login test");
    expect(out?.draft?.autoName).toBe(true);
  });

  test("autoName keeps following on later draft updates", () => {
    const ws = createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    updateWorkspace(ws.id, {
      draft: {
        text: "first line",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    const out = updateWorkspace(ws.id, {
      draft: {
        text: "second line",
        updatedAt: "2026-08-15T10:05:00.000Z",
        autoName: true,
      },
    });
    expect(out?.name).toBe("second line");
  });

  test("a blank first line keeps the current name", () => {
    const ws = createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    const out = updateWorkspace(ws.id, {
      draft: {
        text: "   \n\n  ",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    expect(out?.name).toBe("Untitled workspace");
  });

  test("manual rename sets autoName false and stops the follow", () => {
    const ws = createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    updateWorkspace(ws.id, {
      draft: {
        text: "draft-derived name",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: true,
      },
    });
    const renamed = updateWorkspace(ws.id, { name: "Manually chosen name" });
    expect(renamed?.name).toBe("Manually chosen name");
    expect(renamed?.draft?.autoName).toBe(false);

    // A later draft update no longer renames the workspace.
    const later = updateWorkspace(ws.id, {
      draft: {
        text: "trying to rename again",
        updatedAt: "2026-08-15T10:10:00.000Z",
        autoName: true,
      },
    });
    expect(later?.name).toBe("Manually chosen name");
  });

  test("autoName:false on the incoming draft does not rename", () => {
    const ws = createWorkspace({
      name: "Untitled workspace",
      createdBy: "Kent",
    });
    const out = updateWorkspace(ws.id, {
      draft: {
        text: "should not rename",
        updatedAt: "2026-08-15T10:00:00.000Z",
        autoName: false,
      },
    });
    expect(out?.name).toBe("Untitled workspace");
    expect(out?.draft?.autoName).toBe(false);
  });
});
