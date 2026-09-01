import { describe, expect, test } from "bun:test";
import {
  inboxCreatedAt,
  sortInboxByCreation,
  type InboxRow,
} from "./sidebar-inbox";
import type { UnifiedSession, Workspace } from "./types";

function workspace(id: string, createdAt: string): Workspace {
  return { id, name: id, createdBy: "test", createdAt };
}

function session(id: string, createdAt: string): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: null,
    title: id,
    lastActivity: createdAt,
    createdAt,
    isRunning: false,
  };
}

function row(
  key: string,
  createdAt: string,
  sessionCreatedAt = createdAt,
): InboxRow {
  return {
    key,
    workspace: createdAt ? workspace(key, createdAt) : null,
    createdAt: sessionCreatedAt,
    sessions: [session(`${key}:session`, sessionCreatedAt)],
  };
}

describe("Inbox ordering", () => {
  test("uses workspace creation and ignores later activity", () => {
    const older = row("workspace:older", "2026-08-01T00:00:00Z");
    const newer = row("workspace:newer", "2026-08-02T00:00:00Z");
    expect(sortInboxByCreation([older, newer]).map((item) => item.key)).toEqual(
      ["workspace:newer", "workspace:older"],
    );
  });

  test("falls back to the oldest session and then the row key", () => {
    const a = row("a", "", "2026-08-01T00:00:00Z");
    const b = row("b", "", "2026-08-01T00:00:00Z");
    expect(inboxCreatedAt(a)).toBe("2026-08-01T00:00:00Z");
    expect(sortInboxByCreation([b, a]).map((item) => item.key)).toEqual([
      "a",
      "b",
    ]);
  });
});
