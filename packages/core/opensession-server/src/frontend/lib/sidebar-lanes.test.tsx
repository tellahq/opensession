import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import { mineStatus, ownedBy } from "./sidebar-lanes";

function session(overrides: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: "session-1",
    title: "Session",
    createdAt: "2026-08-22T12:00:00Z",
    lastActivity: "2026-08-22T12:00:00Z",
    isRunning: false,
    transcriptPath: null,
    ...overrides,
  } as UnifiedSession;
}

describe("ownedBy", () => {
  test("matches a full starter name to the current person's short name", () => {
    expect(ownedBy(session({ startedBy: "Kent de Bruin" }), "Kent")).toBe(true);
  });

  test("does not claim automation runs for their matching reporter", () => {
    expect(
      ownedBy(
        session({ startedBy: "Kent de Bruin", automation: "daily-recap" }),
        "Kent",
      ),
    ).toBe(false);
  });
});

describe("mineStatus", () => {
  test("files every working chat under In progress", () => {
    expect(
      mineStatus(session({ isRunning: true, manualStatus: "pending" })),
    ).toBe("inprogress");
  });

  test("restores a pinned lane when the chat becomes idle", () => {
    expect(mineStatus(session({ manualStatus: "review" }))).toBe("review");
  });

  test("files a safety pause under needs input even with a stale running bit", () => {
    expect(
      mineStatus(
        session({
          isRunning: true,
          safety: {
            status: "paused_for_safety",
            explanation: "Paused",
            automaticReconciliationRunning: false,
            pausedAt: "2026-08-22T12:00:00Z",
            operation: "finishing the current turn",
            repairAvailable: false,
          },
        }),
      ),
    ).toBe("needsinput");
  });

  test("keeps a blocked chat above running state", () => {
    expect(
      mineStatus(session({ isRunning: true, waitingForInput: true })),
    ).toBe("needsinput");
  });
});
