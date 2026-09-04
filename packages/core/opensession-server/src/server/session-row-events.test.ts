import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetSessionRowPublishesForTest,
  SESSION_ROW_COALESCE_MS,
  sessionRowVisible,
  sidebarSubscribers,
} from "./session-row-events";
import type { SidebarSessionScope } from "./sidebar-session-scope";
import type { UnifiedSession } from "./types";

afterEach(() => __resetSessionRowPublishesForTest());

function socket(sidebarScope?: SidebarSessionScope | null) {
  const sent: string[] = [];
  return {
    sent,
    data: sidebarScope === undefined ? {} : { sidebarScope },
    send(payload: string) {
      sent.push(payload);
    },
  };
}

function session(
  id: string,
  patch: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    createdBy: "Ada",
    startedBy: "Ada",
    title: id,
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    ...patch,
  } as UnifiedSession;
}

const scope = (patch: Partial<SidebarSessionScope> = {}) =>
  ({
    user: "Ada",
    person: "me",
    repo: "all",
    autoCreated: "hide",
    ...patch,
  }) satisfies SidebarSessionScope;

describe("session row fan-out", () => {
  test("coalesces a burst into one frame per session", () => {
    expect(SESSION_ROW_COALESCE_MS).toBe(250);
  });

  test("groups subscribed sockets by scope and skips the rest", () => {
    const ada = socket(scope());
    const adaAgain = socket(scope());
    const grace = socket(scope({ user: "Grace", person: "everyone" }));
    const unscoped = socket(null);
    const native = socket();

    const groups = sidebarSubscribers([ada, adaAgain, grace, unscoped, native]);

    expect(groups.size).toBe(3);
    const sockets = [...groups.values()].map((entry) => entry.sockets.length);
    expect(sockets.sort()).toEqual([1, 1, 2]);
    expect([...groups.values()].some((entry) => entry.scope === null)).toBe(
      true,
    );
    expect(
      [...groups.values()].flatMap((entry) => entry.sockets),
    ).not.toContain(native);
  });

  test("a row is visible in the lens that owns it and hidden from others", () => {
    const row = session("mine");
    expect(sessionRowVisible(row.id, [row], scope())).toBe(true);
    expect(sessionRowVisible(row.id, [row], null)).toBe(true);
    expect(sessionRowVisible(row.id, [], null)).toBe(false);
    expect(
      sessionRowVisible(row.id, [row], scope({ user: "Grace", person: "me" })),
    ).toBe(false);
    expect(
      sessionRowVisible(
        row.id,
        [row],
        scope({ user: "Grace", person: "everyone" }),
      ),
    ).toBe(true);
  });

  test("an archived row is never shown", () => {
    const row = session("done", { archived: true });
    expect(sessionRowVisible(row.id, [row], scope())).toBe(false);
    expect(sessionRowVisible(row.id, [row], null)).toBe(false);
  });

  test("group rules see siblings: an idle worker stays with its selected parent", () => {
    const parent = session("parent", { workspaceId: "ws-1" });
    const worker = session("worker", {
      workspaceId: "ws-1",
      parentSessionId: "parent",
      spawnedBy: "parent",
      createdBy: "Grace",
      startedBy: "Grace",
    });
    const selected = scope({ selectedSessionId: "parent" });
    // Alone, an idle spawned worker from another person is filtered out.
    expect(sessionRowVisible(worker.id, [worker], selected)).toBe(false);
    // With its parent present, it belongs to the selected workspace group.
    expect(sessionRowVisible(worker.id, [worker, parent], selected)).toBe(true);
  });
});
