import { describe, expect, test } from "bun:test";
import { descendants, threadRecap, threadStanding } from "./thread-recap";
import type { UnifiedSession } from "./types";

function session(over: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: "bks-x",
    source: "opensession",
    branch: "",
    worktreeDir: "",
    startedBy: "Ada",
    title: "Thread",
    lastActivity: "2026-11-07T12:00:00.000Z",
    createdAt: "2026-11-07T08:00:00.000Z",
    isRunning: false,
    ...over,
  } as UnifiedSession;
}

const since = Date.parse("2026-11-07T10:00:00.000Z");

describe("threadRecap", () => {
  test("recaps only threads that changed since, newest first", async () => {
    let prompt = "";
    const result = await threadRecap("ws-a", "bks-root", since, "Grace", {
      members: async () => [
        session({ id: "bks-root" }),
        session({
          id: "bks-old",
          parentSessionId: "bks-root",
          lastActivity: "2026-11-07T09:00:00.000Z",
        }),
        session({
          id: "bks-ship",
          parentSessionId: "bks-root",
          title: "Fix coupons",
          prState: "MERGED",
          lastActivity: "2026-11-07T11:00:00.000Z",
        }),
        session({
          id: "bks-run",
          parentSessionId: "bks-root",
          title: "Tax rules",
          isRunning: true,
          createdAt: "2026-11-07T10:30:00.000Z",
        }),
      ],
      lastMessage: async (s) => (s.id === "bks-ship" ? "Merged #12" : null),
      write: async (p) => {
        prompt = p;
        return " Coupons shipped. ";
      },
      now: () => since,
    });
    expect(result).toEqual({
      text: "Coupons shipped.",
      threadIds: ["bks-run", "bks-ship"],
    });
    expect(prompt).toContain("Grace is back");
    expect(prompt).toContain('"Tax rules" (new; working; started by Ada)');
    expect(prompt).toContain("Latest: Merged #12");
    expect(prompt).not.toContain("bks-old");
  });

  test("asks no model when nothing changed", async () => {
    const result = await threadRecap("ws-b", "bks-root", since, "Grace", {
      members: async () => [],
      lastMessage: async () => null,
      write: async () => {
        throw new Error("should not run");
      },
      now: () => since,
    });
    expect(result).toEqual({ text: null, threadIds: [] });
  });

  test("follows threads of threads, and only this root's", () => {
    const tree = [
      session({ id: "a", parentSessionId: "root" }),
      session({ id: "b", parentSessionId: "a" }),
      session({ id: "c", parentSessionId: "other" }),
    ];
    expect(descendants(tree, "root").map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("names where a thread stands", () => {
    expect(threadStanding(session({ prState: "MERGED" }))).toBe(
      "shipped (PR merged)",
    );
    expect(threadStanding(session({ isRunning: true }))).toBe("working");
  });
});
