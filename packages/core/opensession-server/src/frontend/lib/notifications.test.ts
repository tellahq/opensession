import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { NotificationThread } from "./api/notifications";

const original = {
  Notification: globalThis.Notification,
  window: globalThis.window,
  document: globalThis.document,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
};

const storage = new Map<string, string>([
  ["opensession-user", "Ada"],
  ["opensession-notif-alerts-migrated", "1"],
]);
let focused = true;
const banners: string[] = [];
const marks: unknown[] = [];
let serverThreads: NotificationThread[] = [];

class FakeNotification {
  static permission = "granted";
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(title: string) {
    banners.push(title);
  }
  close() {}
}

const win = Object.assign(new EventTarget(), {
  Notification: FakeNotification,
  focus: () => {},
});
Object.assign(globalThis, {
  Notification: FakeNotification,
  window: win,
  document: Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
  }),
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  fetch: async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0];
    if (path === "/api/notifications/mark") {
      marks.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, changed: 1 });
    }
    return Response.json({
      threads: serverThreads,
      unread: 0,
      alerts: {
        reviews: true,
        mentions: true,
        collaborators: true,
        reminders: true,
      },
    });
  },
});

// Client data belongs to a resolved signed-in scope (client-data-scope.ts).
const { publishClientDataIdentity } = await import("./client-data-scope");
publishClientDataIdentity({
  required: true,
  authenticated: true,
  githubAccountId: 11,
});
const store = await import("./notifications");
afterAll(() => Object.assign(globalThis, original));

function thread(
  id: string,
  overrides: Partial<NotificationThread> = {},
): NotificationThread {
  return {
    id: `session:${id}`,
    subject: { type: "session", id, title: `Session ${id}` },
    kind: "review_requested",
    reason: "Sam asked for your review",
    body: "",
    url: `/session/${id}`,
    updatedAt: Date.now(),
    unread: true,
    done: false,
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  focused = true;
  banners.length = 0;
  marks.length = 0;
  serverThreads = [];
  store.startNotifications(() => {});
  store.refreshNotifications();
  await settle();
});

describe("notification inbox on this device", () => {
  test("news about the session you are looking at is read everywhere", async () => {
    const stop = store.watchSessionNotifications("os-open");
    store.receiveNotification("Ada", thread("os-open"), true);
    await settle();
    expect(store.unreadNotificationCount()).toBe(0);
    // The server hears it too, or the other devices keep it unread.
    expect(marks).toContainEqual({
      user: "Ada",
      ids: ["session:os-open"],
      unread: false,
    });
    expect(banners).toEqual([]);
    stop();
  });

  test("a background window keeps it unread and raises a banner", async () => {
    focused = false;
    const stop = store.watchSessionNotifications("os-open");
    store.receiveNotification("Ada", thread("os-open"), true);
    await settle();
    expect(store.unreadNotificationCount()).toBe(1);
    expect(marks).toEqual([]);
    expect(banners).toEqual(["Sam asked for your review"]);
    stop();
  });

  test("reconnecting refreshes the list without replaying anything", async () => {
    focused = false;
    serverThreads = [thread("os-1"), thread("os-2")];
    store.refreshNotifications();
    await settle();
    expect(store.unreadNotificationCount()).toBe(2);
    expect(banners).toEqual([]);
  });

  test("switched-off kinds land in the list without a banner", async () => {
    focused = false;
    store.receiveNotification(
      "Ada",
      thread("os-3", { kind: "collaborator", reason: "Sam added you" }),
      false,
    );
    expect(store.unreadNotificationCount()).toBe(1);
    expect(banners).toEqual([]);
  });

  test("frames for somebody else are ignored", () => {
    store.receiveNotification("Grace", thread("os-4"), true);
    expect(store.getNotificationState().threads).toEqual([]);
  });

  test("filters: done rows only show under Done", () => {
    const rows = [
      thread("a", { unread: false, updatedAt: 1 }),
      thread("b", { updatedAt: 2 }),
      thread("c", { done: true, unread: false, updatedAt: 3 }),
    ];
    expect(store.filterThreads(rows, "all").map((t) => t.id)).toEqual([
      "session:b",
      "session:a",
    ]);
    expect(store.filterThreads(rows, "unread").map((t) => t.id)).toEqual([
      "session:b",
    ]);
    expect(store.filterThreads(rows, "done").map((t) => t.id)).toEqual([
      "session:c",
    ]);
  });
});
