import { expect, test } from "bun:test";
import {
  archiveWorkspaceSessions,
  type ArchiveWorkspaceSessionsDeps,
} from "./archive-workspace-sessions";
import type { UnifiedSession } from "./types";

function session(id: string, workspaceId?: string): UnifiedSession {
  // SAFETY: the archive helper reads only id and workspaceId.
  return { id, workspaceId } as UnifiedSession;
}

function harness(over: Partial<ArchiveWorkspaceSessionsDeps> = {}) {
  const state = new Map<string, boolean>();
  const sessionCalls: string[] = [];
  const workspaceCalls: string[] = [];
  const calls = { session: sessionCalls, workspace: workspaceCalls };
  const remembered: string[][] = [];
  const unpinned: string[][] = [];
  const deps: ArchiveWorkspaceSessionsDeps = {
    patch: (id, p) => state.set(id, !!p.archived),
    archiveSession: async (id) => {
      calls.session.push(id);
    },
    archiveWorkspace: async (id) => {
      calls.workspace.push(id);
      return { archived: [], failed: [] };
    },
    rememberArchived: (ids) => remembered.push(ids),
    dropStalePins: (s) => unpinned.push(s.map((x) => x.id)),
    refreshSessions: () => {},
    ...over,
  };
  return { deps, state, calls, remembered, unpinned };
}

test("archives the whole workspace on the server, hidden members included", async () => {
  const h = harness({
    archiveWorkspace: async () => ({
      archived: ["own", "review"],
      failed: [],
    }),
  });
  const ok = await archiveWorkspaceSessions([session("own", "ws")], h.deps);

  expect(ok).toBe(true);
  expect(h.state.get("own")).toBe(true);
  expect(h.state.get("review")).toBe(true);
  expect(h.calls.session).toEqual([]);
  expect(h.remembered).toEqual([["own", "review"]]);
});

test("archives a shown session the server's live list missed", async () => {
  const h = harness({
    archiveWorkspace: async () => ({ archived: ["a"], failed: [] }),
  });
  await archiveWorkspaceSessions(
    [session("a", "ws"), session("stale", "ws")],
    h.deps,
  );

  expect(h.calls.session).toEqual(["stale"]);
  expect(h.remembered).toEqual([["a", "stale"]]);
});

test("puts back only the sessions that failed", async () => {
  const h = harness({
    archiveWorkspace: async () => ({ archived: ["a"], failed: ["b"] }),
  });
  const ok = await archiveWorkspaceSessions(
    [session("a", "ws"), session("b", "ws")],
    h.deps,
  );

  expect(ok).toBe(true);
  expect(h.state.get("a")).toBe(true);
  expect(h.state.get("b")).toBe(false);
  expect(h.unpinned).toEqual([["a"]]);
});

test("sessions outside one workspace archive one by one", async () => {
  const h = harness();
  await archiveWorkspaceSessions([session("x"), session("y")], h.deps);

  expect(h.calls.workspace).toEqual([]);
  expect(h.calls.session).toEqual(["x", "y"]);
});

test("a failed workspace request restores every shown session", async () => {
  const h = harness({
    archiveWorkspace: async () => {
      throw new Error("offline");
    },
  });
  const ok = await archiveWorkspaceSessions(
    [session("a", "ws"), session("b", "ws")],
    h.deps,
  );

  expect(ok).toBe(false);
  expect([h.state.get("a"), h.state.get("b")]).toEqual([false, false]);
  expect(h.remembered).toEqual([]);
});
