import { afterEach, describe, expect, test } from "bun:test";
import {
  allClients,
  broadcastToSession,
  broadcastToUser,
  computeGlobalPresence,
  computeTypingPresence,
  computeTypingUsers,
  TYPING_PREVIEW_MAX,
  joinSession,
  leaveSession,
  sessionWatchers,
  setClientTyping,
  type WSClientData,
} from "./ws-hub";
import {
  holdSessionRunning,
  releaseSessionRunning,
} from "./session-state-events";

const sockets = new Set<any>();

afterEach(() => {
  for (const socket of sockets) allClients.delete(socket);
  sockets.clear();
  sessionWatchers.clear();
});

describe("computeGlobalPresence", () => {
  // Both stamps default to now: a face is earned by a live transport AND by
  // recent attention, so a fixture that let either lapse reads as gone.
  const viewer = (
    user: string | null,
    at: number,
    away?: boolean,
    activeAt = Date.now(),
  ) => ({
    data: {
      watchingSessionId: null,
      user,
      watchJoinedAt: at,
      away,
      activeAt,
      lastSeenAt: Date.now(),
    },
  });
  const watchers = (entries: Record<string, any[]>) =>
    new Map(Object.entries(entries).map(([id, set]) => [id, new Set(set)]));

  test("one entry per person, at their most recent join", () => {
    expect(
      computeGlobalPresence(
        watchers({ old: [viewer("Ada", 1)], recent: [viewer("Ada", 2)] }),
      ),
    ).toEqual([{ user: "Ada", sessionId: "recent" }]);
  });

  test("an away socket claims nobody — the whole point of the flag", () => {
    expect(
      computeGlobalPresence(watchers({ left: [viewer("Ada", 1, true)] })),
    ).toEqual([]);
  });

  test("a hidden tab can't outrank the visible one it joined after", () => {
    expect(
      computeGlobalPresence(
        watchers({
          looking: [viewer("Ada", 1)],
          // The tab she left open in the background, opened later.
          background: [viewer("Ada", 9, true)],
        }),
      ),
    ).toEqual([{ user: "Ada", sessionId: "looking" }]);
  });

  test("a focused window keeps claiming its owner while they read", () => {
    expect(
      computeGlobalPresence(
        watchers({
          // Reading is quiet work: a scroll a couple of minutes ago is
          // still "here now", and the client keeps saying so.
          reading: [viewer("Ada", 1, false, Date.now() - 2 * 60_000)],
        }),
      ),
    ).toEqual([{ user: "Ada", sessionId: "reading" }]);
  });

  test("a window left open stops claiming its owner once it goes quiet", () => {
    expect(
      computeGlobalPresence(
        watchers({
          // Frontmost and focused since this morning — a locked Mac still
          // reports both — but nothing has touched it: the watch survives,
          // the face does not.
          parked: [viewer("Ada", 1, false, Date.now() - 30 * 60_000)],
        }),
      ),
    ).toEqual([]);
  });

  test("a focused viewer disappears when its transport stops heartbeating", () => {
    expect(
      computeGlobalPresence(
        watchers({
          stale: [
            {
              data: {
                watchingSessionId: "stale",
                user: "Ada",
                watchJoinedAt: 1,
                away: false,
                activeAt: Date.now(),
                lastSeenAt: Date.now() - 5 * 60_000,
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("anonymous viewers stay out — there's nobody to follow", () => {
    expect(
      computeGlobalPresence(
        watchers({ s: [viewer("Anonymous", 1), viewer(null, 2)] }),
      ),
    ).toEqual([]);
  });

  test("disconnect cleanup removes the viewer from global presence", () => {
    const ws = {
      data: {
        watchingSessionId: "s",
        user: "Ada",
        watchJoinedAt: 1,
        activeAt: Date.now(),
        lastSeenAt: Date.now(),
      },
      send() {},
    };
    sessionWatchers.set("s", new Set([ws]));
    expect(computeGlobalPresence(sessionWatchers)).toHaveLength(1);

    leaveSession(ws);
    expect(computeGlobalPresence(sessionWatchers)).toEqual([]);
  });

  test("join tracks the complete runtime client state", () => {
    const sessionId = crypto.randomUUID();
    const data = {
      watchingSessionId: sessionId,
      user: "Automation",
      transcriptV2: true,
      presenceClient: "test-client",
      presenceSuppressed: true,
    } satisfies WSClientData;
    const socket: Parameters<typeof joinSession>[0] = {
      data,
      send() {},
    };

    joinSession(socket, sessionId);

    expect(socket.data.watchJoinedAt).toBeNumber();
    expect(socket.data).toMatchObject({
      transcriptV2: true,
      presenceClient: "test-client",
      presenceSuppressed: true,
    });
    leaveSession(socket);
  });

  test("a new watcher receives empty presence and typing snapshots", () => {
    const sessionId = crypto.randomUUID();
    const first = {
      data: { user: "Ada", watchingSessionId: sessionId, away: true },
      send() {},
    };
    const frames: any[] = [];
    const second = {
      data: { user: "Grace", watchingSessionId: sessionId, away: true },
      send(payload: string) {
        frames.push(JSON.parse(payload));
      },
    };

    joinSession(first, sessionId);
    joinSession(second, sessionId);

    expect(frames).toContainEqual({
      type: "presence",
      sessionId,
      viewers: [],
    });
    expect(frames).toContainEqual({
      type: "typing",
      sessionId,
      users: [],
    });
  });
});

describe("session status", () => {
  test("keeps legacy and feed clients busy while background work is live", () => {
    const sessionId = crypto.randomUUID();
    const legacyFrames: any[] = [];
    const feedFrames: any[] = [];
    const legacy = {
      data: { watchingSessionId: sessionId, user: "Ada" },
      send(payload: string) {
        legacyFrames.push(JSON.parse(payload));
      },
    };
    const feed = {
      data: {
        watchingSessionId: sessionId,
        user: "Grace",
        supportsFeed: true,
      },
      send(payload: string) {
        feedFrames.push(JSON.parse(payload));
      },
    };
    sessionWatchers.set(sessionId, new Set([legacy, feed]));
    holdSessionRunning(sessionId, "workflow:wf-1");

    broadcastToSession(sessionId, {
      type: "session_status",
      sessionId,
      isRunning: false,
    });

    expect(legacyFrames.at(-1)).toMatchObject({
      type: "session_status",
      isRunning: true,
    });
    expect(feedFrames.at(-1)).toMatchObject({
      type: "session_feed",
      event: { type: "session_status", isRunning: true },
    });
    releaseSessionRunning(sessionId, "workflow:wf-1");
  });
});

describe("typing presence", () => {
  test("deduplicates people and expires stale leases", () => {
    const now = Date.now();
    const viewers = new Set<any>([
      {
        data: {
          user: "Ada",
          typingUntil: now + 1_000,
          activeAt: now,
          lastSeenAt: now,
        },
      },
      {
        data: {
          user: "Ada",
          typingUntil: now + 2_000,
          activeAt: now,
          lastSeenAt: now,
        },
      },
      {
        data: {
          user: "Grace",
          typingUntil: now - 1,
          activeAt: now,
          lastSeenAt: now,
        },
      },
    ]);
    expect(computeTypingUsers(viewers, now)).toEqual(["Ada"]);
  });

  test("broadcasts start and stop to the other viewers", () => {
    const sessionId = crypto.randomUUID();
    const received: any[] = [];
    const ada = {
      data: { user: "Ada", watchingSessionId: sessionId },
      send() {},
    };
    const grace = {
      data: { user: "Grace", watchingSessionId: sessionId },
      send(payload: string) {
        received.push(JSON.parse(payload));
      },
    };
    joinSession(ada, sessionId);
    joinSession(grace, sessionId);
    received.length = 0;

    setClientTyping(ada, sessionId, true);
    expect(received).toContainEqual({
      type: "typing",
      sessionId,
      users: ["Ada"],
    });

    received.length = 0;
    setClientTyping(ada, sessionId, false);
    expect(received).toContainEqual({
      type: "typing",
      sessionId,
      users: [],
    });
  });

  test("carries the draft head to the other viewers and drops it with the lease", () => {
    const sessionId = crypto.randomUUID();
    const received: any[] = [];
    const ada = {
      data: { user: "Ada", watchingSessionId: sessionId },
      send() {},
    };
    const grace = {
      data: { user: "Grace", watchingSessionId: sessionId },
      send(payload: string) {
        received.push(JSON.parse(payload));
      },
    };
    joinSession(ada, sessionId);
    joinSession(grace, sessionId);
    received.length = 0;

    setClientTyping(ada, sessionId, true, "Could we show ");
    expect(received.at(-1)).toEqual({
      type: "typing",
      sessionId,
      users: ["Ada"],
      drafts: { Ada: "Could we show " },
    });

    // Same lease, newer text: the frame goes out again.
    received.length = 0;
    setClientTyping(ada, sessionId, true, "Could we show what");
    expect(received.at(-1)?.drafts).toEqual({ Ada: "Could we show what" });

    // The preview is bounded and never persisted beyond the socket.
    received.length = 0;
    setClientTyping(ada, sessionId, true, "x".repeat(TYPING_PREVIEW_MAX + 50));
    expect(received.at(-1)?.drafts.Ada).toHaveLength(TYPING_PREVIEW_MAX);

    received.length = 0;
    setClientTyping(ada, sessionId, false);
    expect(received.at(-1)).toEqual({ type: "typing", sessionId, users: [] });
    expect(ada.data).not.toHaveProperty("typingText", expect.any(String));
  });

  test("a viewer who arrives mid-draft gets the draft in the join snapshot", () => {
    const sessionId = crypto.randomUUID();
    const ada = {
      data: { user: "Ada", watchingSessionId: sessionId },
      send() {},
    };
    joinSession(ada, sessionId);
    setClientTyping(ada, sessionId, true, "still here");

    const received: any[] = [];
    const grace = {
      data: { user: "Grace", watchingSessionId: sessionId },
      send(payload: string) {
        received.push(JSON.parse(payload));
      },
    };
    joinSession(grace, sessionId);
    expect(received).toContainEqual({
      type: "typing",
      sessionId,
      users: ["Ada"],
      drafts: { Ada: "still here" },
    });
  });

  test("the freshest lease wins when one person composes on two devices", () => {
    const now = Date.now();
    const viewers = new Set<any>([
      {
        data: {
          user: "Ada",
          typingUntil: now + 1_000,
          typingText: "older",
          activeAt: now,
          lastSeenAt: now,
        },
      },
      {
        data: {
          user: "Ada",
          typingUntil: now + 2_000,
          typingText: "newer",
          activeAt: now,
          lastSeenAt: now,
        },
      },
    ]);
    expect(computeTypingPresence(viewers, now)).toEqual({
      users: ["Ada"],
      drafts: { Ada: "newer" },
    });
  });
});

describe("broadcastToUser", () => {
  const socket = (data: Partial<WSClientData>) => {
    const received: unknown[] = [];
    const ws = {
      data: { watchingSessionId: null, user: null, ...data },
      send(payload: string) {
        received.push(JSON.parse(payload));
      },
    };
    allClients.add(ws as never);
    sockets.add(ws);
    return received;
  };

  test("reaches every socket of that person and nobody else", () => {
    const signedIn = socket({ user: "michiel", authUser: "Michiel" });
    const picker = socket({ user: "Michiel" });
    const sidebar = socket({
      user: null,
      sidebarScope: {
        user: "Michiel",
        person: "me",
        repo: "all",
        autoCreated: "hide",
      },
    });
    const claimsOtherwise = socket({ user: "Michiel", authUser: "Louise" });
    const teammate = socket({ user: "Louise" });
    const anonymous = socket({});

    broadcastToUser("Michiel", { type: "user_map_changed", map: "lanes" });

    const frame = { type: "user_map_changed", map: "lanes" };
    expect(signedIn).toEqual([frame]);
    expect(picker).toEqual([frame]);
    expect(sidebar).toEqual([frame]);
    expect(claimsOtherwise).toEqual([]);
    expect(teammate).toEqual([]);
    expect(anonymous).toEqual([]);
  });

  test("an empty name reaches nobody", () => {
    const received = socket({ user: "" });
    broadcastToUser("  ", { type: "user_map_changed", map: "hides" });
    expect(received).toEqual([]);
  });
});
