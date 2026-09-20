import { afterAll, expect, test } from "bun:test";

const original = {
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
};
const storage = new Map<string, string>([
  ["opensession-user", "Ada"],
  ["opensession-pins-migrated", "1"],
]);
let serverPins: string[] = [];
let serverReads = { session: "2026-08-01T00:00:00.000Z" };
let deferredPins: Promise<Response> | undefined;
const writes: string[][] = [];
Object.assign(globalThis, {
  window: new EventTarget(),
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  fetch: async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0];
    if (path === "/api/pins") {
      if (init?.method === "PUT") {
        serverPins = JSON.parse(String(init.body)).pins;
        writes.push([...serverPins]);
      } else if (deferredPins) {
        const response = deferredPins;
        deferredPins = undefined;
        return response;
      }
      return Response.json({ pins: [...serverPins] });
    }
    if (path === "/api/reads") {
      if (init?.method === "PUT")
        serverReads = JSON.parse(String(init.body)).reads;
      return Response.json({ reads: { ...serverReads } });
    }
    return Response.json({ prefs: {} });
  },
});
const pins = await import("./pins");
const reads = await import("./reads");
const { resyncUserMap, resyncUserMaps } = await import("./user-map");
afterAll(() => Object.assign(globalThis, original));

test("reconnection pulls in missed pins and read/unread changes without writing back", async () => {
  await resyncUserMaps("Ada");
  serverPins = ["other-window"];
  serverReads = { session: "2026-09-01T00:00:00.000Z" };
  await resyncUserMaps("Ada");
  expect(pins.getPins()).toEqual(["other-window"]);
  expect(reads.getReads()).toEqual(serverReads);
  serverReads = { session: "1970-01-01T00:00:00.000Z" };
  await resyncUserMap("reads", "Ada");
  expect(reads.getReads()).toEqual(serverReads);
  expect(writes).toEqual([]);
});

test("another user's map invalidation leaves our caches alone", async () => {
  const before = reads.getReads();
  serverReads = { session: "2026-10-01T00:00:00.000Z" };
  await resyncUserMap("reads", "Bob");
  expect(reads.getReads()).toEqual(before);
});

test("a pin push fences an older in-flight load", async () => {
  let resolve!: (response: Response) => void;
  deferredPins = new Promise((done) => {
    resolve = done;
  });
  const loading = resyncUserMap("pins", "Ada");
  // resync first waits for pending saves before starting its GET.
  await Promise.resolve();
  pins.receivePins("ADA", ["new"]);
  resolve(Response.json({ pins: ["old"] }));
  await loading;
  expect(pins.getPins()).toEqual(["new"]);
});

test("rapid pin actions persist in order, then reconcile with the server", async () => {
  pins.togglePin("first");
  pins.togglePin("second");
  pins.reorderPins(["first", "second", "new"]);
  await resyncUserMap("pins", "Ada");
  expect(writes.slice(-3)).toEqual([
    ["first", "new"],
    ["second", "first", "new"],
    ["first", "second", "new"],
  ]);
  expect(pins.getPins()).toEqual(serverPins);
});
