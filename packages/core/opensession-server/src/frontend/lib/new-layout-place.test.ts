import { describe, expect, test } from "bun:test";
import {
  conversationExists,
  placeOfRoute,
  placeOverride,
} from "./new-layout-place";

test("a route that names its place ignores where you were", () => {
  expect(placeOfRoute({ view: "feed" }, "sessions")).toBe("activity");
  expect(placeOfRoute({ view: "prs" }, "activity")).toBe("library");
  expect(placeOfRoute({ view: "plain" }, "library")).toBe("support");
  expect(placeOfRoute({ view: "archived" }, "activity")).toBe("sessions");
});

test("a session stays in Activity and otherwise belongs to Sessions", () => {
  const session = { view: "session", id: "s1" } as const;
  expect(placeOfRoute(session, "activity")).toBe("activity");
  expect(placeOfRoute(session, "sessions")).toBe("sessions");
  expect(placeOfRoute(session, "library")).toBe("sessions");
  expect(placeOfRoute(session, "support")).toBe("sessions");
});

describe("placeOverride", () => {
  test("records only a place the route does not give", () => {
    expect(placeOverride({ view: "session", id: "a" }, "sessions")).toBe(
      undefined,
    );
    expect(placeOverride({ view: "session", id: "a" }, "activity")).toBe(
      "activity",
    );
    expect(placeOverride({ view: "issues" }, "library")).toBe(undefined);
    expect(placeOverride({ view: "issues" }, "sessions")).toBe("sessions");
  });
});

describe("conversationExists", () => {
  const sessions = [{ id: "live" }, { id: "old", archived: true }];
  const workspaces = [{ id: "ws-1" }];

  test("a session has to be listed and not archived", () => {
    const exists = (id: string) =>
      conversationExists({ view: "session", id }, sessions, workspaces);
    expect(exists("live")).toBe(true);
    expect(exists("old")).toBe(false);
    expect(exists("deleted")).toBe(false);
  });

  test("an unlisted session is looked up, not taken as gone", async () => {
    const server = new Map([
      ["hidden", { archived: false }],
      ["shelved", { archived: true }],
    ]);
    const exists = (id: string) =>
      conversationExists({ view: "session", id }, sessions, workspaces, {
        session: (key) => Promise.resolve(server.get(key) ?? null),
        workspace: () => Promise.resolve(false),
      });
    expect(exists("live")).toBe(true);
    expect(await exists("hidden")).toBe(true);
    expect(await exists("shelved")).toBe(false);
    expect(await exists("deleted")).toBe(false);
  });

  test("a workspace has to exist", () => {
    const exists = (id: string) =>
      conversationExists({ view: "workspace", id }, sessions, workspaces);
    expect(exists("ws-1")).toBe(true);
    expect(exists("ws-deleted")).toBe(false);
  });

  test("an unlisted workspace is looked up, not taken as gone", async () => {
    // A ticket's workspace with no live session: real, but off the list.
    const server = new Set(["ws-quiet"]);
    const exists = (id: string) =>
      conversationExists({ view: "workspace", id }, sessions, workspaces, {
        session: () => Promise.resolve(null),
        workspace: (key) => Promise.resolve(server.has(key)),
      });
    expect(exists("ws-1")).toBe(true);
    expect(await exists("ws-quiet")).toBe(true);
    expect(await exists("ws-deleted")).toBe(false);
  });

  test("a failed lookup rejects, so the conversation is not forgotten", async () => {
    const down = () => Promise.reject(new Error("offline"));
    const exists = (route: Parameters<typeof conversationExists>[0]) =>
      conversationExists(route, sessions, workspaces, {
        session: down,
        workspace: down,
      });
    await expect(exists({ view: "workspace", id: "ws-x" })).rejects.toThrow();
    await expect(exists({ view: "session", id: "s-x" })).rejects.toThrow();
  });
});
