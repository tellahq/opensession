import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import {
  appliedTextAfterQueryChange,
  type StickySession,
} from "./session-list-state";

describe("appliedTextAfterQueryChange", () => {
  test("keeps the applied text so an identical scoped response is a no-op", () => {
    expect(appliedTextAfterQueryChange("[]", new Map())).toBe("[]");
    expect(appliedTextAfterQueryChange(null, new Map())).toBeNull();
  });

  test("re-applies while a sticky row reconciles against the selected session", () => {
    const created: UnifiedSession = {
      id: "os-new",
      source: "opensession",
      branch: null,
      worktreeDir: null,
      startedBy: null,
      title: "New session",
      lastActivity: "2026-10-30T12:00:00Z",
      createdAt: "2026-10-30T12:00:00Z",
      isRunning: false,
    };
    const sticky = new Map<string, StickySession>([
      [created.id, { session: created, serverSeen: true }],
    ]);
    expect(appliedTextAfterQueryChange("[]", sticky)).toBeNull();
  });
});
