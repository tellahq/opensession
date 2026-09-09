import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Workspaces live in the kernel catalog: every test gets a fresh in-memory
// kernel store and a cold projection. The legacy export directory follows
// OPENSESSION_STATE_DIR, so it is pinned to a scratch root before the first
// import and re-pinned per test, since another suite restoring its own value
// mid-run would send these exports to the live directory (see
// workspaces.test.ts).
const dir = mkdtempSync(join(tmpdir(), "session-workspace-"));
process.env.OPENSESSION_STATE_DIR = dir;

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const { __resetWorkspaceProjectionForTest, createWorkspace, getWorkspace } =
  await import("./workspaces");
const { settleProvisionalNames } = await import("./session-workspace");
import type { UnifiedSession } from "./types";

let store: InstanceType<typeof SessionKernelStore>;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;
beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = dir;
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  __resetWorkspaceProjectionForTest();
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  __resetWorkspaceProjectionForTest();
});

/** A Slack thread session: its id is `slack-<key>` and, until the generated
 *  title lands, its branch and title are that same raw key. */
const slack = (over: Partial<UnifiedSession> = {}): UnifiedSession =>
  ({
    id: "slack-C0BE8KVFBEX-1786887720.562319",
    source: "slack",
    branch: "C0BE8KVFBEX-1786887720.562319",
    title: "Fix sidebar hover states",
    createdAt: "2026-08-17T07:32:37.017Z",
    lastActivity: "2026-08-17T08:00:06.531Z",
    ...over,
  }) as UnifiedSession;

const workspace = (name: string) =>
  createWorkspace({ name, createdBy: "Kent", branch: name });

describe("settleProvisionalNames", () => {
  test("renames a workspace still wearing the session's raw key", async () => {
    const ws = await workspace("C0BE8KVFBEX-1786887720.562319");
    await settleProvisionalNames([slack({ workspaceId: ws.id })]);
    expect((await getWorkspace(ws.id))?.name).toBe("Fix sidebar hover states");
  });

  test("leaves it alone while the title is still that key", async () => {
    const key = "C0BE8KVFBEX-1786887720.562319";
    const ws = await workspace(key);
    await settleProvisionalNames([slack({ workspaceId: ws.id, title: key })]);
    expect((await getWorkspace(ws.id))?.name).toBe(key);
  });

  test("never overwrites a name someone chose", async () => {
    const ws = await workspace("Hover states");
    await settleProvisionalNames([slack({ workspaceId: ws.id })]);
    expect((await getWorkspace(ws.id))?.name).toBe("Hover states");
  });

  // The guard that keeps this off every workspace named after a real branch:
  // the trigger is the session's own id, which a branch name cannot spell.
  test("leaves a workspace named after a git branch alone", async () => {
    const ws = await workspace("fix-sidebar-hover");
    await settleProvisionalNames([
      slack({
        id: "os-01a00ea2-64d5-7000-8452-47a49d9915df",
        source: "opensession",
        branch: "fix-sidebar-hover",
        workspaceId: ws.id,
      }),
    ]);
    expect((await getWorkspace(ws.id))?.name).toBe("fix-sidebar-hover");
  });
});
