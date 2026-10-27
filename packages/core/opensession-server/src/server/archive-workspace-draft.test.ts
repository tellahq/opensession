import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { UnifiedSession } from "./types";

// A parked draft is what keeps a sessionless workspace in the sidebar, so one
// left on a workspace whose sessions were all archived brings it straight back.
const scratch = mkdtempSync(join(tmpdir(), "opensession-archive-draft-"));
const previous = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const {
  __resetWorkspaceProjectionForTest,
  createWorkspace,
  discardWorkspaceDraft,
  getWorkspace,
} = await import("./workspaces");
const { unpinArchivedSessions } = await import("./archive");

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

function session(
  id: string,
  workspaceId: string,
  archived: boolean,
): UnifiedSession {
  return { id, workspaceId, archived } as UnifiedSession;
}

const draft = { text: "Follow up on the flaky test", updatedAt: "2026-01-01" };

test("archiving a workspace's last live session clears its parked draft", async () => {
  const ws = await createWorkspace({ name: "Acme", createdBy: "acme", draft });
  const archived = session("s1", ws.id, true);

  await unpinArchivedSessions([archived], [archived]);

  expect((await getWorkspace(ws.id))?.draft).toBeUndefined();
});

test("a workspace with a live session left keeps its draft", async () => {
  const ws = await createWorkspace({ name: "Acme", createdBy: "acme", draft });
  const archived = session("s1", ws.id, true);
  const live = session("s2", ws.id, false);

  await unpinArchivedSessions([archived], [archived, live]);

  expect((await getWorkspace(ws.id))?.draft?.text).toBe(draft.text);
});

test("discarding the draft of a workspace with archived sessions keeps the workspace", async () => {
  const ws = await createWorkspace({
    name: "Acme",
    createdBy: "acme",
    key: "session-create:acme",
    draft,
  });

  expect(await discardWorkspaceDraft(ws.id, true)).toBe("cleared");

  const kept = await getWorkspace(ws.id);
  expect(kept?.name).toBe("Acme");
  expect(kept?.draft).toBeUndefined();
});

test("discarding the draft of a sessionless draft workspace removes it", async () => {
  const ws = await createWorkspace({ name: "Acme", createdBy: "acme", draft });

  expect(await discardWorkspaceDraft(ws.id, false)).toBe("deleted");
  expect(await getWorkspace(ws.id)).toBeNull();
});

test("discarding the draft of a missing workspace reports it", async () => {
  expect(await discardWorkspaceDraft("ws-missing", false)).toBe("missing");
});
