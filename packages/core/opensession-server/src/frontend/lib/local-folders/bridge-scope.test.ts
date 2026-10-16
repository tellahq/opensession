import { afterAll, expect, test } from "bun:test";

// A connected folder on this device, served through the Mac app bridge.
const opened: string[] = [];
const closed: string[] = [];
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    opened.push(url);
  }
  send() {}
  close() {
    closed.push(this.url);
  }
}
const original = {
  window: globalThis.window,
  WebSocket: globalThis.WebSocket,
  location: globalThis.location,
};
Object.assign(globalThis, {
  WebSocket: FakeSocket,
  location: { protocol: "https:", host: "example.test" },
  window: Object.assign(new EventTarget(), {
    os1: {
      localFolders: {
        device: async () => ({ id: "device-1", label: "Test device" }),
        list: async () => [
          {
            id: "folder-1",
            name: "acme",
            readOnly: false,
            sessionIds: ["session-1"],
          },
        ],
        pick: async () => null,
        update: async () => {},
        remove: async () => {},
        op: async () => null,
        onChange: () => () => {},
      },
    },
  }),
});
afterAll(() => Object.assign(globalThis, original));

const { publishClientDataIdentity } = await import("../client-data-scope");
const { startLocalFolderBridge } = await import("./bridge");
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the folder socket waits for a signed-in account and follows account changes", async () => {
  publishClientDataIdentity(null);
  startLocalFolderBridge();
  await settle();
  // No account yet: nothing to announce the folders for, and no throw.
  expect(opened).toEqual([]);
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 11,
  });
  await settle();
  expect(opened).toHaveLength(1);
  // Another account signs in: the old account's socket closes first.
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 12,
  });
  await settle();
  expect(closed).toEqual([opened[0]]);
  expect(opened).toHaveLength(2);
});
