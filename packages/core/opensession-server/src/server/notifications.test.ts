import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const root = mkdtempSync(`${tmpdir()}/notifications-test-`);
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

const frames: Array<{ user: string; msg: Record<string, unknown> }> = [];
const pushes: Array<{ user: string; payload: Record<string, unknown> }> = [];
mock.module("./push", () => ({
  sendPushToUser: async (user: string, payload: Record<string, unknown>) => {
    pushes.push({ user, payload });
  },
}));

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const { allClients } = await import("./ws-hub");
// One signed-in socket for Ada: every frame the hub sends her lands here.
const socket = {
  data: { authUser: "Ada", watchingSessionId: null, user: null },
  send: (payload: string) =>
    frames.push({ user: "Ada", msg: JSON.parse(payload) }),
};
allClients.add(socket as unknown as Parameters<typeof allClients.add>[0]);
const {
  getNotificationInbox,
  markNotifications,
  notifyUser,
  sessionSubject,
  setAlertPrefs,
} = await import("./notifications");

let store: InstanceType<typeof SessionKernelStore>;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;
beforeEach(() => {
  frames.length = 0;
  pushes.length = 0;
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});
afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

const ask = {
  kind: "review_requested" as const,
  subject: sessionSubject("os-1", { title: "Fix login", repo: "acme" }),
  reason: "Sam asked for your review",
  body: "Please look today",
  url: "/session/os-1",
  eventKey: "review:1",
};

describe("notification inbox", () => {
  test("records, broadcasts and pushes a new event exactly once", async () => {
    expect(await notifyUser("Ada", ask)).toMatchObject({
      id: "session:os-1",
      unread: true,
    });
    // The restart case: the same request raised again is not news.
    expect(await notifyUser("Ada", ask)).toBeNull();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].payload).toMatchObject({
      title: "Sam asked for your review",
      body: "Fix login: Please look today",
      tag: "os-notification-session:os-1",
    });
    expect(frames.filter((f) => f.msg.type === "notification")).toHaveLength(1);
    const inbox = await getNotificationInbox("ada");
    expect(inbox.unread).toBe(1);
    expect(inbox.threads[0].subject.context).toBe("acme");
  });

  test("switched-off kinds are not recorded, broadcast or pushed", async () => {
    await setAlertPrefs("Ada", { collaborators: false });
    frames.length = 0;
    expect(
      await notifyUser("Ada", {
        kind: "collaborator",
        subject: { type: "workspace", id: "ws-1", title: "Shared work" },
        reason: "Sam added you to Shared work",
        url: "/workspace/ws-1",
      }),
    ).toBeNull();
    expect(pushes).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect((await getNotificationInbox("Ada")).threads).toHaveLength(0);
  });

  test("marking read reaches the person's other devices", async () => {
    await notifyUser("Ada", ask);
    frames.length = 0;
    expect(
      await markNotifications("Ada", { ids: ["session:os-1"], unread: false }),
    ).toBe(1);
    expect(frames).toEqual([
      { user: "Ada", msg: { type: "notifications_changed", user: "Ada" } },
    ]);
    expect((await getNotificationInbox("Ada")).unread).toBe(0);
    // Nothing changed, nothing announced.
    frames.length = 0;
    await markNotifications("Ada", { all: true, unread: false });
    expect(frames).toHaveLength(0);
  });
});
