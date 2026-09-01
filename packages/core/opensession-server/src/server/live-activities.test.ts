import { describe, expect, test } from "bun:test";
import {
  activityPushPayload,
  liveActivityRegistrationMatches,
  liveActivitySnapshot,
} from "./live-activities";
import type { UnifiedSession } from "./types";

function session(
  id: string,
  owner: string,
  running: boolean,
  lastActivity: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    claudeSessionId: null,
    source: "opensession",
    branch: "main",
    worktreeDir: "/tmp/opensession",
    startedBy: owner,
    title: id,
    lastActivity,
    createdAt: lastActivity,
    isRunning: running,
    transcriptPath: null,
    repo: "opensession",
    ...overrides,
  };
}

describe("liveActivitySnapshot", () => {
  test("shows only the owner's running sessions and caps the visible list", () => {
    const rows = [
      session("os-1", "Michiel", true, "2026-08-11T10:04:00Z"),
      session("os-2", "happylinks", true, "2026-08-11T10:03:00Z"),
      session("os-3", "Michiel", true, "2026-08-11T10:02:00Z"),
      session("os-4", "Michiel", true, "2026-08-11T10:01:00Z"),
      session("other", "Kent", true, "2026-08-11T10:05:00Z"),
      session("idle", "Michiel", false, "2026-08-11T10:06:00Z"),
      session("automation", "Michiel", true, "2026-08-11T10:07:00Z", {
        automation: "nightly",
      }),
    ];
    const snapshot = liveActivitySnapshot(
      { user: "Michiel", login: "happylinks" },
      rows,
      123_000,
    );

    expect(snapshot.totalCount).toBe(4);
    expect(snapshot.sessions.map((row) => row.id)).toEqual([
      "os-1",
      "os-2",
      "os-3",
    ]);
    expect(snapshot.updatedAt).toBe(123);
  });

  test("counts only owned unread sessions", () => {
    const rows = [
      session("finished", "Michiel", false, "2026-08-11T10:05:00Z"),
      session("still-running", "Michiel", true, "2026-08-11T10:04:00Z"),
      session("read", "Michiel", false, "2026-08-11T10:03:00Z"),
      session("worker", "Michiel", false, "2026-08-11T10:02:00Z", {
        spawnedBy: "finished",
      }),
      session("other", "Kent", false, "2026-08-11T10:06:00Z"),
    ];
    const snapshot = liveActivitySnapshot(
      { user: "Michiel", login: "happylinks" },
      rows,
      123_000,
      {
        finished: "2026-08-11T10:00:00Z",
        "still-running": "2026-08-11T10:00:00Z",
        read: "2026-08-11T10:03:00Z",
        worker: "2026-08-11T10:00:00Z",
        other: "2026-08-11T10:00:00Z",
      },
    );

    expect(snapshot.unreadCount).toBe(2);
  });

  test("verified creator login wins over an ambiguous display name", () => {
    const snapshot = liveActivitySnapshot({ user: "Alex", login: "alex-one" }, [
      session("mine", "Alex", true, "2026-08-11T10:00:00Z", {
        createdByLogin: "alex-one",
      }),
      session("not-mine", "Alex", true, "2026-08-11T10:01:00Z", {
        createdByLogin: "alex-two",
      }),
    ]);

    expect(snapshot.sessions.map((row) => row.id)).toEqual(["mine"]);
  });
});

describe("activityPushPayload", () => {
  test("start payload names the attributes type and carries a stale date", () => {
    const snapshot = {
      sessions: [],
      totalCount: 1,
      unreadCount: 0,
      updatedAt: 100,
    };
    expect(activityPushPayload("start", snapshot, "device-1", 100_000)).toEqual(
      {
        aps: {
          timestamp: 100,
          event: "start",
          "content-state": snapshot,
          "stale-date": 700,
          "attributes-type": "ActiveSessionsAttributes",
          attributes: { deviceId: "device-1" },
          alert: { title: "OS1", body: "A session is active" },
        },
      },
    );
  });

  test("end payload asks the system to dismiss after thirty seconds", () => {
    const payload = activityPushPayload(
      "end",
      { sessions: [], totalCount: 0, unreadCount: 0, updatedAt: 100 },
      undefined,
      100_000,
    ) as { aps: Record<string, unknown> };
    expect(payload.aps["dismissal-date"]).toBe(130);
  });
});

describe("liveActivityRegistrationMatches", () => {
  test("verified logins take precedence over ambiguous display names", () => {
    const registration = { user: "Alex", login: "alex-one" };
    expect(
      liveActivityRegistrationMatches(registration, {
        user: "Alex",
        login: "alex-one",
      }),
    ).toBe(true);
    expect(
      liveActivityRegistrationMatches(registration, {
        user: "Alex",
        login: "alex-two",
      }),
    ).toBe(false);
    expect(
      liveActivityRegistrationMatches(registration, { user: "Alex" }),
    ).toBe(false);
  });

  test("legacy display names match only when neither side has a login", () => {
    expect(
      liveActivityRegistrationMatches({ user: "Alex" }, { user: "Alex" }),
    ).toBe(true);
  });
});
