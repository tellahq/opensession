import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "../lib/types";
import {
  LIVE_POLL_FALLBACK_MS,
  liveSnapshotMatchesQuery,
  reconcilePendingSessionPatches,
  reconcileStickySessions,
  sessionPatchNeedsAcknowledgement,
  sidebarSessionsQuery,
} from "./useSessions";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const hookSource = await Bun.file(
  new URL("useSessions.ts", import.meta.url),
).text();

test("uses a slow safety poll behind WebSocket invalidations", () => {
  expect(LIVE_POLL_FALLBACK_MS).toBe(60_000);
});

describe("session feed socket ownership", () => {
  test("keeps invalidation and reconnect transport concerns in useSessions", () => {
    expect(hookSource).toContain(
      'socket?: Pick<SessionSocket, "addHandler"> & { connected: boolean }',
    );
    expect(hookSource).toContain(
      'if (message.type === "sessions_invalidated") onInvalidated()',
    );
    expect(hookSource).toContain(
      "const onInvalidated = useEffectEvent(() => refreshInvalidated())",
    );
    expect(hookSource).toContain("}, [addHandler]);");
    expect(hookSource).toContain("}, [socketConnected]);");
    expect(hookSource).not.toContain("    refreshInvalidated,\n    inject,");
  });

  test("passes the main socket into useSessions before feed consumers", () => {
    const socket = appSource.indexOf("const mainSocket = useWebSocket()");
    const sessions = appSource.indexOf("useSessions({");

    expect(socket).toBeGreaterThan(-1);
    expect(socket).toBeLessThan(sessions);
    expect(appSource).toContain("socket: mainSocket");
    expect(appSource).not.toContain("refreshInvalidated");
    expect(appSource).not.toContain("webSocketConnectedOnceRef");
    expect(appSource).not.toContain("sessions_invalidated");
  });

  test("preserves session-list rendering and retry wiring", () => {
    expect(appSource).toContain("sessionsError={sessionsError}");
    expect(appSource).toContain("sessionsLoading={loading}");
    expect(appSource).toContain("onRetrySessions={() => void refresh()}");
    expect(appSource).toContain("loaded={archivedLoaded}");
    expect(appSource).toContain("onShowArchived={refreshArchived}");
  });
});

function session(archived: boolean): UnifiedSession {
  return { id: "session-1", archived } as UnifiedSession;
}

describe("sidebarSessionsQuery", () => {
  test("asks for the active server-side sidebar projection", () => {
    expect(
      sidebarSessionsQuery({
        user: "Ada Lovelace",
        person: "me",
        repo: "tella fusion",
        autoCreated: "hide",
        selectedSessionId: "os-1",
      }),
    ).toBe(
      "?archived=exclude&view=sidebar&user=Ada+Lovelace&person=me&repo=tella+fusion&autoCreated=hide&session=os-1",
    );
  });
});

describe("liveSnapshotMatchesQuery", () => {
  test("fences a response scoped to the previously selected session", () => {
    const archivedRoute = sidebarSessionsQuery({
      user: "Ada Lovelace",
      person: "me",
      repo: "all",
      autoCreated: "hide",
      selectedSessionId: "archived-session",
    });
    const nextRoute = sidebarSessionsQuery({
      user: "Ada Lovelace",
      person: "me",
      repo: "all",
      autoCreated: "hide",
      selectedSessionId: "next-session",
    });

    expect(liveSnapshotMatchesQuery(archivedRoute, nextRoute)).toBe(false);
    expect(liveSnapshotMatchesQuery(nextRoute, nextRoute)).toBe(true);
  });
});

describe("reconcileStickySessions", () => {
  const optimistic: UnifiedSession = {
    ...session(false),
    title: "New session",
    workspaceId: null,
  };
  const authoritative: UnifiedSession = {
    ...optimistic,
    title: "Fix the sidebar",
    workspaceId: "workspace-1",
  };

  test("keeps an unseen optimistic row across stale snapshots", () => {
    const sticky = new Map([
      [optimistic.id, { session: optimistic, serverSeen: false }],
    ]);

    expect(reconcileStickySessions([], sticky)).toEqual([optimistic]);
    expect(sticky.has(optimistic.id)).toBe(true);
  });

  test("keeps the selected row as a fallback after the server first sees it", () => {
    const sticky = new Map([
      [optimistic.id, { session: optimistic, serverSeen: false }],
    ]);

    expect(
      reconcileStickySessions([authoritative], sticky, optimistic.id),
    ).toEqual([authoritative]);
    expect(sticky.get(optimistic.id)).toEqual({
      session: authoritative,
      serverSeen: true,
    });

    // An indexed/cached projection can briefly lose the just-created row. It
    // stays in place using the freshest server shape rather than disappearing.
    expect(reconcileStickySessions([], sticky, optimistic.id)).toEqual([
      authoritative,
    ]);
  });

  test("retires the fallback after leaving a server-confirmed session", () => {
    const sticky = new Map([
      [optimistic.id, { session: authoritative, serverSeen: true }],
    ]);

    expect(reconcileStickySessions([], sticky, "another-session")).toEqual([]);
    expect(sticky.has(optimistic.id)).toBe(false);
  });

  test("retires a background create as soon as the server returns it", () => {
    const sticky = new Map([
      [optimistic.id, { session: optimistic, serverSeen: false }],
    ]);

    expect(reconcileStickySessions([authoritative], sticky)).toEqual([
      authoritative,
    ]);
    expect(sticky.has(optimistic.id)).toBe(false);
  });
});

describe("reconcilePendingSessionPatches", () => {
  test("keeps the chat's running state applied across a stale list poll", () => {
    const pending = new Map([
      [
        "session-1",
        {
          values: {
            isRunning: true,
            runStartedAt: "2026-08-22T12:00:00Z",
          },
          runtimeRevision: 1,
        },
      ],
    ]);

    const [reconciled] = reconcilePendingSessionPatches(
      [{ ...session(false), isRunning: false }],
      pending,
      0,
    );

    expect(reconciled.isRunning).toBe(true);
    expect(reconciled.runStartedAt).toBe("2026-08-22T12:00:00Z");
    expect(pending.has("session-1")).toBe(true);
  });

  test("accepts idle state from a poll started after the run frame", () => {
    const idle = session(false);
    const pending = new Map([
      [
        "session-1",
        {
          values: {
            isRunning: true,
            runStartedAt: "2026-08-22T12:00:00Z",
          },
          runtimeRevision: 1,
        },
      ],
    ]);

    expect(reconcilePendingSessionPatches([idle], pending, 1)).toEqual([idle]);
    expect(pending.has("session-1")).toBe(false);
  });

  test("holds runtime, archive, and review patches until the server acknowledges them", () => {
    expect(sessionPatchNeedsAcknowledgement({ isRunning: true })).toBe(true);
    expect(sessionPatchNeedsAcknowledgement({ archived: true })).toBe(true);
    expect(
      sessionPatchNeedsAcknowledgement({
        reviewRequest: {
          to: "Michiel",
          by: "Kent",
          at: "2026-09-01T13:03:20Z",
        },
      }),
    ).toBe(true);
    expect(sessionPatchNeedsAcknowledgement({ title: "Renamed" })).toBe(false);
  });

  test("keeps an optimistic review request applied across a stale poll", () => {
    const request = {
      to: "Michiel",
      by: "Kent",
      at: "2026-09-01T13:03:20Z",
    } satisfies NonNullable<UnifiedSession["reviewRequest"]>;
    const pending = new Map([
      ["session-1", { values: { reviewRequest: request } }],
    ]);

    const [reconciled] = reconcilePendingSessionPatches(
      [session(false)],
      pending,
    );

    expect(reconciled.reviewRequest).toEqual(request);
    expect(pending.has("session-1")).toBe(true);
  });

  test("accepts the persisted review request despite its server timestamp", () => {
    const optimistic = {
      to: "Michiel",
      by: "Kent",
      at: "2026-09-01T13:03:20Z",
    } satisfies NonNullable<UnifiedSession["reviewRequest"]>;
    const pending = new Map([
      ["session-1", { values: { reviewRequest: optimistic } }],
    ]);
    const acknowledged = {
      ...session(false),
      reviewRequest: {
        ...optimistic,
        at: "2026-09-01T13:03:40Z",
      },
    };

    expect(reconcilePendingSessionPatches([acknowledged], pending)).toEqual([
      acknowledged,
    ]);
    expect(pending.has("session-1")).toBe(false);
  });

  test("does not mistake an older request for the new handoff", () => {
    const optimistic = {
      to: "Michiel",
      by: "Kent",
      at: "2026-09-01T13:03:20Z",
    } satisfies NonNullable<UnifiedSession["reviewRequest"]>;
    const pending = new Map([
      ["session-1", { values: { reviewRequest: optimistic } }],
    ]);
    const stale = {
      ...session(false),
      reviewRequest: {
        ...optimistic,
        at: "2026-08-30T09:00:00Z",
      },
    };

    const [reconciled] = reconcilePendingSessionPatches([stale], pending);

    expect(reconciled.reviewRequest).toEqual(optimistic);
    expect(pending.has("session-1")).toBe(true);
  });

  test("keeps an optimistic archive applied across a stale poll", () => {
    const pending = new Map([
      [
        "session-1",
        { values: { archived: true, archivedReason: "manual" as const } },
      ],
    ]);

    const [reconciled] = reconcilePendingSessionPatches(
      [session(false)],
      pending,
    );

    expect(reconciled.archived).toBe(true);
    expect(reconciled.archivedReason).toBe("manual");
    expect(pending.has("session-1")).toBe(true);
  });

  test("drops the optimistic patch after the server acknowledges it", () => {
    const pending = new Map([
      [
        "session-1",
        { values: { archived: true, archivedReason: "manual" as const } },
      ],
    ]);
    const acknowledged = {
      ...session(true),
      archivedReason: "manual" as const,
    };

    expect(reconcilePendingSessionPatches([acknowledged], pending)).toEqual([
      acknowledged,
    ]);
    expect(pending.has("session-1")).toBe(false);
  });
});
