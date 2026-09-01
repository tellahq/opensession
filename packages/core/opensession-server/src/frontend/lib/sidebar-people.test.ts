import { describe, expect, test } from "bun:test";
import { AGENT_PERSON_KEY } from "./automation-audience";
import { AGENT_NAME } from "./brand";
import type { Person } from "./people";
import {
  PERSON_RECENT_ACTIVITY_MS,
  sessionIsRecentlyActive,
  sidebarPersonSessions,
} from "./sidebar-people";
import type { UnifiedSession } from "./types";

const NOW = Date.parse("2026-08-24T12:00:00Z");
const roster: Person[] = [
  { name: "Kent", fullName: "Kent de Bruin", github: "kentdebruin" },
  { name: "Michiel", fullName: "Michiel Westerbeek", github: "happylinks" },
  { name: "Jeroen", fullName: "Jeroen Frolich", github: "jfrolich" },
];

function session(
  id: string,
  patch: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Michiel",
    title: id,
    lastActivity: new Date(NOW - 5 * 60 * 1000).toISOString(),
    createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    isRunning: false,
    ran: true,
    ...patch,
  };
}

describe("sidebar person sessions", () => {
  test("keeps running and recently active sessions in the compact list", () => {
    expect(
      sessionIsRecentlyActive(
        session("running", {
          isRunning: true,
          lastActivity: "2020-01-01T00:00:00Z",
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      sessionIsRecentlyActive(
        session("edge", {
          lastActivity: new Date(NOW - PERSON_RECENT_ACTIVITY_MS).toISOString(),
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      sessionIsRecentlyActive(
        session("old", {
          lastActivity: new Date(
            NOW - PERSON_RECENT_ACTIVITY_MS - 1,
          ).toISOString(),
        }),
        NOW,
      ),
    ).toBe(false);
    expect(sessionIsRecentlyActive(session("draft", { ran: false }), NOW)).toBe(
      false,
    );
  });

  test("keeps only active sessions in teammate groups", () => {
    const groups = sidebarPersonSessions(
      [
        session("recent", { startedBy: "Michiel Westerbeek" }),
        session("older", {
          startedBy: "happylinks",
          lastActivity: "2026-08-20T12:00:00Z",
        }),
        session("inactive-person", {
          startedBy: "Jeroen",
          lastActivity: "2026-08-20T12:00:00Z",
        }),
      ],
      roster,
      "Kent",
      NOW,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("michiel");
    expect(groups[0]?.label).toBe("Michiel");
    expect(groups[0]?.activeSessions.map((item) => item.id)).toEqual([
      "recent",
    ]);
  });

  test("excludes sessions already kept in personal sidebar lanes", () => {
    const groups = sidebarPersonSessions(
      [session("available"), session("kept")],
      roster,
      "Kent",
      NOW,
      new Map(),
      new Set(["kept"]),
    );

    expect(groups[0]?.activeSessions.map((item) => item.id)).toEqual([
      "available",
    ]);
  });

  test("uses the directory boundary and excludes the signed-in person", () => {
    const groups = sidebarPersonSessions(
      [
        session("me", { startedBy: "kentdebruin", isRunning: true }),
        session("worker", { startedBy: "worker os-123", isRunning: true }),
        session("teammate", { startedBy: "Jeroen", isRunning: true }),
      ],
      roster,
      "Kent",
      NOW,
    );

    expect(groups.map((group) => group.key)).toEqual(["jeroen"]);
  });

  test("files automations under their owner or the Agent person", () => {
    const groups = sidebarPersonSessions(
      [
        session("owned-automation", {
          startedBy: null,
          isRunning: true,
          automation: "Daily report",
        }),
        session("agent-automation", {
          startedBy: null,
          isRunning: true,
          automation: "PR review",
        }),
      ],
      roster,
      "Kent",
      NOW,
      new Map([["Daily report", "Michiel"]]),
    );

    expect(groups.map((group) => group.key)).toEqual([
      "michiel",
      AGENT_PERSON_KEY,
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Michiel", AGENT_NAME]);
  });
});
