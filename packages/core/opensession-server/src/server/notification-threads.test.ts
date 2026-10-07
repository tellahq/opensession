import { describe, expect, test } from "bun:test";
import {
  applyNotificationEvent,
  cleanDocument,
  EVENT_DEDUPE_MS,
  markNotificationThreads,
  MAX_THREADS,
  RETENTION_MS,
  shouldAlert,
  unreadCount,
  wireThread,
  type NotificationDocument,
  type NotificationEvent,
} from "./notification-threads";

const T0 = 1_800_000_000_000;

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: "review_requested",
    subject: { type: "session", id: "os-1", title: "Fix the login bug" },
    reason: "Sam asked for your review",
    body: "",
    url: "/session/os-1",
    at: T0,
    ...overrides,
  };
}

const empty: NotificationDocument = { threads: [] };

describe("notification threads", () => {
  test("a new event creates an unread thread keyed by its subject", () => {
    const { doc, thread } = applyNotificationEvent(empty, event());
    expect(thread?.id).toBe("session:os-1");
    expect(thread?.unread).toBe(true);
    expect(unreadCount(doc)).toBe(1);
  });

  test("a replayed event key changes nothing, so a restart cannot notify twice", () => {
    const first = applyNotificationEvent(
      empty,
      event({ eventKey: "review:abc" }),
    );
    const read = markNotificationThreads(first.doc, {
      ids: ["session:os-1"],
      unread: false,
    }).doc;
    const replay = applyNotificationEvent(
      read,
      event({ eventKey: "review:abc", at: T0 + 60_000 }),
    );
    expect(replay.thread).toBeNull();
    expect(replay.doc).toBe(read);
    expect(unreadCount(replay.doc)).toBe(0);
  });

  test("the same key notifies again once the dedupe window has passed", () => {
    const first = applyNotificationEvent(
      empty,
      event({ eventKey: "review:abc" }),
    );
    const later = applyNotificationEvent(
      first.doc,
      event({ eventKey: "review:abc", at: T0 + EVENT_DEDUPE_MS + 1 }),
    );
    expect(later.thread).not.toBeNull();
  });

  test("a second event on a subject bumps the one row instead of adding one", () => {
    let doc = applyNotificationEvent(empty, event()).doc;
    doc = applyNotificationEvent(
      doc,
      event({
        subject: { type: "session", id: "os-2", title: "Other" },
        at: T0 + 1,
      }),
    ).doc;
    doc = markNotificationThreads(doc, { all: true, done: true }).doc;
    const bumped = applyNotificationEvent(
      doc,
      event({ reason: "Alex asked for your review", at: T0 + 2 }),
    );
    expect(bumped.doc.threads.map((t) => t.id)).toEqual([
      "session:os-1",
      "session:os-2",
    ]);
    expect(bumped.thread).toMatchObject({
      reason: "Alex asked for your review",
      unread: true,
      done: false,
    });
  });

  test("done implies read and marks count what changed", () => {
    const doc = applyNotificationEvent(empty, event()).doc;
    const done = markNotificationThreads(doc, {
      ids: ["session:os-1"],
      done: true,
    });
    expect(done.changed).toBe(1);
    expect(done.doc.threads[0]).toMatchObject({ unread: false, done: true });
    expect(
      markNotificationThreads(done.doc, { ids: ["session:os-1"], done: true })
        .changed,
    ).toBe(0);
  });

  test("old threads are pruned and the inbox is capped", () => {
    let doc = applyNotificationEvent(empty, event()).doc;
    doc = applyNotificationEvent(
      doc,
      event({
        subject: { type: "session", id: "os-new", title: "New" },
        at: T0 + RETENTION_MS,
      }),
    ).doc;
    expect(doc.threads.map((t) => t.id)).toEqual(["session:os-new"]);
    for (let i = 0; i < MAX_THREADS + 5; i++)
      doc = applyNotificationEvent(
        doc,
        event({
          subject: { type: "session", id: `os-${i}`, title: `${i}` },
          at: T0 + RETENTION_MS + i,
        }),
      ).doc;
    expect(doc.threads).toHaveLength(MAX_THREADS);
  });

  test("alerts follow the person's settings", () => {
    expect(shouldAlert(null, "review_requested")).toBe(true);
    expect(shouldAlert(null, "collaborator")).toBe(true);
    expect(shouldAlert(null, "mention")).toBe(true);
    expect(shouldAlert(null, "reminder")).toBe(true);
    expect(
      shouldAlert({ threads: [], alerts: { reviews: false } }, "review_done"),
    ).toBe(false);
    // Team requests (code owners) switch off apart from requests by name.
    expect(shouldAlert(null, "team_review_requested")).toBe(true);
    expect(
      shouldAlert(
        { threads: [], alerts: { teamReviews: false } },
        "team_review_requested",
      ),
    ).toBe(false);
    expect(
      shouldAlert(
        { threads: [], alerts: { teamReviews: false } },
        "review_requested",
      ),
    ).toBe(true);
    expect(
      shouldAlert(
        { threads: [], alerts: { collaborators: false } },
        "collaborator",
      ),
    ).toBe(false);
  });

  test("a switched-off group never reaches the inbox", () => {
    const off: NotificationDocument = {
      threads: [],
      alerts: { teamReviews: false },
    };
    const team = applyNotificationEvent(
      off,
      event({ kind: "team_review_requested" }),
    );
    expect(team.thread).toBeNull();
    expect(team.doc).toBe(off);
    expect(unreadCount(team.doc)).toBe(0);
    const named = applyNotificationEvent(
      off,
      event({ kind: "review_requested" }),
    );
    expect(named.thread).not.toBeNull();
  });

  test("agent rows stored before they were removed are dropped", () => {
    const { doc } = applyNotificationEvent(empty, event());
    const stored = JSON.parse(JSON.stringify(doc));
    for (const kind of ["needs_input", "run_failed", "run_finished"])
      stored.threads.push({
        ...stored.threads[0],
        id: `session:${kind}`,
        kind,
        subject: { ...stored.threads[0].subject, id: kind },
      });
    stored.alerts = { needsInput: false, done: true };
    expect(cleanDocument(stored)).toEqual({ threads: doc.threads });
  });

  test("stored documents are cleaned and the wire form hides event keys", () => {
    const { doc } = applyNotificationEvent(empty, event({ eventKey: "k" }));
    const round = cleanDocument(JSON.parse(JSON.stringify(doc)));
    expect(round.threads[0].events).toHaveLength(1);
    expect("events" in wireThread(round.threads[0])).toBe(false);
    expect(
      cleanDocument({ threads: [{ id: "x", subject: { type: "nope" } }, 3] }),
    ).toEqual({ threads: [] });
  });
});
