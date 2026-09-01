import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import { isReusableEmptySession } from "./empty-session";

function session(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: "os-empty",
    source: "opensession",
    title: "New session",
    createdAt: "2026-08-21T12:00:00.000Z",
    lastActivity: "2026-08-21T12:00:00.000Z",
    ...overrides,
  } as UnifiedSession;
}

describe("isReusableEmptySession", () => {
  test("accepts one untouched native tab", () => {
    expect(isReusableEmptySession(session())).toBe(true);
  });

  test("rejects sessions with work, activity, or another source", () => {
    expect(
      isReusableEmptySession(session({ piSessionId: "engine-session" })),
    ).toBe(false);
    expect(isReusableEmptySession(session({ isRunning: true }))).toBe(false);
    expect(
      isReusableEmptySession(
        session({ duplicatedFromSessionId: "bks-source" }),
      ),
    ).toBe(false);
    expect(
      isReusableEmptySession(
        session({ lastActivity: "2026-08-21T12:00:01.000Z" }),
      ),
    ).toBe(false);
    expect(isReusableEmptySession(session({ source: "slack" }))).toBe(false);
  });
});
