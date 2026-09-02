import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import {
  pickUnreadWorkspaceSession,
  shouldEmphasizeUnread,
} from "./sidebar-unread-session";

function session(over: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: "session",
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: null,
    title: "Session",
    createdAt: "2026-08-20T10:00:00.000Z",
    lastActivity: "2026-08-20T11:00:00.000Z",
    isRunning: false,
    workspaceId: "workspace",
    ...over,
  };
}

const READS = {
  older: "2026-08-20T10:00:00.000Z",
  newer: "2026-08-20T10:00:00.000Z",
  selected: "2026-08-20T10:00:00.000Z",
  worker: "2026-08-20T10:00:00.000Z",
};

describe("shouldEmphasizeUnread", () => {
  test("waits until unread agent work has finished", () => {
    expect(shouldEmphasizeUnread(true, true)).toBe(false);
    expect(shouldEmphasizeUnread(true, false)).toBe(true);
    expect(shouldEmphasizeUnread(false, false)).toBe(false);
  });
});

describe("pickUnreadWorkspaceSession", () => {
  test("opens the unread tab with the newest activity", () => {
    const older = session({
      id: "older",
      lastActivity: "2026-08-20T11:00:00.000Z",
    });
    const newer = session({
      id: "newer",
      lastActivity: "2026-08-20T12:00:00.000Z",
    });
    expect(pickUnreadWorkspaceSession([older, newer], null, READS)?.id).toBe(
      "newer",
    );
  });

  test("ignores the selected tab and spawned workers", () => {
    const selected = session({
      id: "selected",
      lastActivity: "2026-08-20T13:00:00.000Z",
    });
    const parent = session({
      id: "older",
      lastActivity: "2026-08-20T11:00:00.000Z",
    });
    const worker = session({
      id: "worker",
      parentSessionId: parent.id,
      lastActivity: "2026-08-20T14:00:00.000Z",
    });
    expect(
      pickUnreadWorkspaceSession([selected, parent, worker], selected.id, READS)
        ?.id,
    ).toBe(parent.id);
  });

  test("uses a worker when the workspace has no parent tab", () => {
    const worker = session({ id: "worker", parentSessionId: "missing" });
    expect(pickUnreadWorkspaceSession([worker], null, READS)?.id).toBe(
      worker.id,
    );
  });
});
