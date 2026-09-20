import { getConfigAsync } from "./config";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { allClients } from "./ws-hub";
type WebSocketClient = typeof allClients extends Set<infer T> ? T : never;
import { setLanes, updateLanes } from "./lanes";
import { setHides, updateHides } from "./hides";
import { setSnoozes, updateSnoozes } from "./snoozes";
import { setPins, pinForUser, unpinEverywhere } from "./pins";
import {
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "./workspaces";
import { buildAtCurrentSessionListRevision } from "./session-list-response-revision";

const home = mkdtempSync(join(tmpdir(), "sidebar-realtime-"));
const priorRoot = process.env.OPENSESSION_STATE_DIR;
const priorConfig = process.env.OPENSESSION_CONFIG;
const store = new SessionKernelStore(":memory:");
let priorStore: SessionKernelStore | undefined;
const sockets: WebSocketClient[] = [];
const snapshots = new Map<string, { expiresAt: number }>();
const state = globalThis as typeof globalThis & {
  __osSessionsResponseSnapshots?: Map<string, { expiresAt: number }>;
};
const priorSnapshots = state.__osSessionsResponseSnapshots;

beforeAll(async () => {
  process.env.OPENSESSION_STATE_DIR = home;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      repos: {
        opensession: {
          repo: "/tmp",
          ghRepo: "tellahq/opensession",
          label: "Open Session",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  await getConfigAsync();
  priorStore = __setSessionKernelStoreForTest(store);
  state.__osSessionsResponseSnapshots = snapshots;
});
afterAll(async () => {
  for (const ws of sockets) allClients.delete(ws);
  __setSessionKernelStoreForTest(priorStore);
  store.close();
  state.__osSessionsResponseSnapshots = priorSnapshots;
  if (priorRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorRoot;
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = priorConfig;
    await getConfigAsync();
  }
  rmSync(home, { recursive: true, force: true });
});

function windowFor(user: string) {
  const messages: unknown[] = [];
  const ws = {
    data: {
      watchingSessionId: null,
      user: null,
      sidebarScope: { user, person: "me", repo: "all", autoCreated: "hide" },
    },
    send(payload: string) {
      messages.push(JSON.parse(payload));
    },
  } as WebSocketClient;
  sockets.push(ws);
  allClients.add(ws);
  return messages;
}

for (const [map, set, update, value] of [
  ["lanes", setLanes, updateLanes, "mine"],
  ["hides", setHides, updateHides, "2026-09-01T00:00:00.000Z"],
  ["snoozes", setSnoozes, updateSnoozes, "someday"],
] as const) {
  test(`${map}: set, change and clear notify both windows after invalidating their cached scope`, async () => {
    const first = windowFor("Ada");
    const second = windowFor("Ada");
    const other = windowFor("Bob");
    const cached = { expiresAt: Date.now() + 60_000 };
    snapshots.set("sidebar\u0000ada", cached);
    let builds = 0;
    await buildAtCurrentSessionListRevision(async () => {
      if (++builds === 1) await set("Ada", { session: value });
    });
    expect(builds).toBe(2);
    expect(cached.expiresAt).toBe(0);
    await update("Ada", (current) => ({ ...current, second: value }));
    await update("Ada", () => ({}));
    const expected = Array.from({ length: 3 }, () => ({
      type: "user_map_changed",
      map,
      user: "Ada",
    }));
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(other).toEqual([]);
  });
}

test("pin, reorder, unpin and archive cleanup publish the authoritative order", async () => {
  const first = windowFor("Ada");
  const second = windowFor("Ada");
  const other = windowFor("Bob");
  await setPins("Ada", ["a", "b"]);
  await setPins("Ada", ["b", "a"]);
  await pinForUser("Ada", "c");
  await setPins("Ada", ["c", "b"]);
  await unpinEverywhere(["b"]);
  const expected = [
    ["a", "b"],
    ["b", "a"],
    ["c", "b", "a"],
    ["c", "b"],
    ["c"],
  ].map((pins) => ({ type: "pins_changed", user: "Ada", pins }));
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  expect(other).toEqual([]);
});

test("workspace create, rename, color, order and delete notify every window", async () => {
  const first = windowFor("Ada");
  const second = windowFor("Bob");
  const workspace = await createWorkspace({ name: "Before", createdBy: "Ada" });
  await updateWorkspace(workspace.id, { name: "After" });
  await updateWorkspace(workspace.id, { color: "blue" });
  await updateWorkspace(workspace.id, { order: 4 });
  await deleteWorkspace(workspace.id);
  const expected = Array.from({ length: 5 }, () => ({
    type: "workspaces_changed",
  }));
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
});

test("read/unread and tab color routes notify only the current user's windows", async () => {
  const { handlePrefsRoutes } = await import("./routes/prefs");
  const first = windowFor("Ada");
  const second = windowFor("Ada");
  const other = windowFor("Bob");
  for (const [path, body] of [
    ["reads", { reads: { session: "2026-09-01T00:00:00.000Z" } }],
    ["reads", { reads: { session: "1970-01-01T00:00:00.000Z" } }],
    ["tab-colors", { set: { session: "blue" }, remove: [] }],
    ["tab-colors", { set: {}, remove: ["session"] }],
  ] as const) {
    const url = new URL(`http://localhost/api/${path}`);
    const response = await handlePrefsRoutes({
      req: new Request(url, {
        method: "PUT",
        body: JSON.stringify({ user: "Ada", ...body }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });
    expect(response?.status).toBe(200);
  }
  const expected = ["reads", "reads", "tab-colors", "tab-colors"].map(
    (map) => ({ type: "user_map_changed", user: "Ada", map }),
  );
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  expect(other).toEqual([]);
});
