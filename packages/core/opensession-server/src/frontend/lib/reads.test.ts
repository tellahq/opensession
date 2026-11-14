import { expect, test } from "bun:test";
import { isUnread, mergeReadMaps, readsForUnread } from "./reads";

test("read hydration merges persisted server and local marks", () => {
  expect(
    mergeReadMaps(
      {
        server: "2026-08-11T10:00:00.000Z",
        shared: "2026-08-11T10:00:00.000Z",
      },
      { local: "2026-08-11T11:00:00.000Z", shared: "2026-08-11T12:00:00.000Z" },
    ),
  ).toEqual({
    server: "2026-08-11T10:00:00.000Z",
    local: "2026-08-11T11:00:00.000Z",
    shared: "2026-08-11T12:00:00.000Z",
  });
});

test("an explicit mark made before hydration wins over persisted maps", () => {
  expect(
    mergeReadMaps(
      { session: "2026-08-11T12:00:00.000Z" },
      { session: "2026-08-11T11:00:00.000Z" },
      { session: "1970-01-01T00:00:00.000Z" },
    ),
  ).toEqual({ session: "1970-01-01T00:00:00.000Z" });
});

test("hydrated read maps retain only the most recent 500 entries", () => {
  const server = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [
      `session-${index}`,
      "2026-08-11T10:00:00.000Z",
    ]),
  );
  const reads = mergeReadMaps(server, {});
  expect(Object.keys(reads)).toHaveLength(500);
  expect(reads["session-0"]).toBeUndefined();
  expect(reads["session-500"]).toBe("2026-08-11T10:00:00.000Z");
});

test("a session is unread only after its turn finishes", () => {
  const reads = { a: "2026-08-20T10:00:00.000Z" };
  const session = {
    id: "a",
    lastActivity: "2026-08-20T11:00:00.000Z",
    isRunning: true,
  };
  expect(isUnread(session, reads)).toBe(false);
  expect(isUnread({ ...session, isRunning: false }, reads)).toBe(true);
  expect(isUnread({ ...session, isRunning: false }, {})).toBe(false);
});

test("a mark that flips no unread flag keeps the previous read map", () => {
  const sessions = [
    { id: "open", lastActivity: "2026-08-11T12:00:00.000Z", isRunning: false },
    {
      id: "running",
      lastActivity: "2026-08-11T12:00:00.000Z",
      isRunning: true,
    },
  ];
  const previous = {
    open: "2026-08-11T12:00:00.000Z",
    running: "2026-08-11T10:00:00.000Z",
  };
  expect(
    readsForUnread(sessions, previous, {
      ...previous,
      running: "2026-08-11T11:00:00.000Z",
      offscreen: "2026-08-11T11:00:00.000Z",
    }),
  ).toBe(previous);
  const flipped = { ...previous, open: "2026-08-11T11:00:00.000Z" };
  expect(readsForUnread(sessions, previous, flipped)).toBe(flipped);
});

test("a stale map is replaced once newer activity would read differently", () => {
  const previous = { open: "2026-08-11T11:00:00.000Z" };
  const next = { open: "2026-08-11T12:00:00.000Z" };
  const before = [
    { id: "open", lastActivity: "2026-08-11T11:00:00.000Z", isRunning: false },
  ];
  const after = [
    { id: "open", lastActivity: "2026-08-11T12:00:00.000Z", isRunning: false },
  ];
  expect(readsForUnread(before, previous, next)).toBe(previous);
  expect(readsForUnread(after, previous, next)).toBe(next);
  expect(readsForUnread(after, null, next)).toBe(next);
});
