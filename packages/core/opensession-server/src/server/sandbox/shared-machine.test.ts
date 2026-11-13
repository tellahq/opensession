import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { NativeSessionFile, UnifiedSession } from "../types";

let members: UnifiedSession[] = [];
let catalogError: Error | undefined;
let catalogCalls = 0;
const stored = new Map<string, NativeSessionFile>();
const archived = new Set<string>();

mock.module("../session-list-store", () => ({
  indexedWorkspaceMembers: async () => {
    catalogCalls += 1;
    if (catalogError) throw catalogError;
    return members;
  },
}));
mock.module("../session-cache", () => ({
  findSessionAsync: async (id: string) =>
    stored.has(id) ? ({ ...stored.get(id) } as UnifiedSession) : undefined,
  updateSessionFile: async (
    id: string,
    mutate: (data: NativeSessionFile) => NativeSessionFile,
  ) => {
    stored.set(id, mutate(stored.get(id) ?? ({} as NativeSessionFile)));
  },
}));
mock.module("../archive", () => ({
  isArchivedId: (id: string) => archived.has(id),
}));

const {
  mirrorSandboxToPeers,
  newTabWorkspace,
  sandboxHostSessionId,
  sandboxPeerBusy,
  sandboxPeers,
  sharedSandboxRefusal,
} = await import("./shared-machine");

function tab(
  id: string,
  extra: Partial<NativeSessionFile> = {},
): NativeSessionFile {
  return {
    id,
    workspaceId: "ws-1",
    sandboxHost: "tab-1",
    sandbox: {
      provider: "box",
      sandboxId: "bx_1",
      workspace: "volume",
      lifecycle: "awake",
    },
    ...extra,
  } as NativeSessionFile;
}

function seed(...tabs: NativeSessionFile[]) {
  for (const t of tabs) stored.set(t.id, t);
  members = tabs.map((t) => ({ ...t }) as unknown as UnifiedSession);
}

const asSession = (t: NativeSessionFile) => t as unknown as UnifiedSession;

beforeEach(() => {
  members = [];
  catalogError = undefined;
  catalogCalls = 0;
  stored.clear();
  archived.clear();
});
afterAll(() => mock.restore());

test("a tab reaches its machine through the session the provider keys it by", () => {
  expect(sandboxHostSessionId({ id: "tab-2", sandboxHost: "tab-1" })).toBe(
    "tab-1",
  );
  expect(sandboxHostSessionId({ id: "solo" })).toBe("solo");
});

test("a machine never shared has no peers and never asks the catalog", async () => {
  const solo = tab("solo", { sandboxHost: undefined });
  seed(solo, tab("tab-2"));
  expect(await sandboxPeers(asSession(solo))).toEqual([]);
  expect(await sandboxPeerBusy(asSession(solo), () => true)).toBe(false);
  expect(await sharedSandboxRefusal(asSession(solo))).toBeNull();
  expect(catalogCalls).toBe(0);
});

test("peers are the other existing tabs on the same machine", async () => {
  const host = tab("tab-1");
  const other = tab("tab-2");
  const elsewhere = tab("tab-3", { sandboxHost: "tab-9" });
  const local = tab("tab-4", { sandbox: { provider: "local" } });
  seed(host, other, elsewhere, local);
  // A deleted tab whose catalog row has not caught up yet.
  members.push(asSession(tab("deleted")));
  const peers = await sandboxPeers(asSession(host));
  expect(peers.map((peer) => peer.id)).toEqual(["tab-2"]);
});

test("archived tabs count as peers unless only live ones are asked for", async () => {
  const host = tab("tab-1");
  seed(host, tab("tab-2"));
  archived.add("tab-2");
  expect((await sandboxPeers(asSession(host))).map((p) => p.id)).toEqual([
    "tab-2",
  ]);
  expect(await sandboxPeers(asSession(host), { liveOnly: true })).toEqual([]);
});

test("a turn in another tab keeps the machine busy, and an unknown answer does too", async () => {
  const host = tab("tab-1");
  seed(host, tab("tab-2"));
  expect(await sandboxPeerBusy(asSession(host), (id) => id === "tab-2")).toBe(
    true,
  );
  expect(await sandboxPeerBusy(asSession(host), () => false)).toBe(false);
  catalogError = new Error("catalog down");
  expect(await sandboxPeerBusy(asSession(host), () => false)).toBe(true);
});

test("moves and rebuilds are refused while another tab uses the machine", async () => {
  const host = tab("tab-1");
  seed(host, tab("tab-2"));
  expect(await sharedSandboxRefusal(asSession(host))).toContain(
    "Other tabs in this workspace run in this Sandbox",
  );
  seed(host);
  expect(await sharedSandboxRefusal(asSession(host))).toBeNull();
  catalogError = new Error("catalog down");
  expect(await sharedSandboxRefusal(asSession(host))).toContain(
    "Could not check",
  );
});

test("a machine change is mirrored onto every other tab still on it", async () => {
  const host = tab("tab-1");
  const other = tab("tab-2");
  seed(host, other);
  // The other tab left for its own machine after the catalog row was read.
  stored.set("tab-2", { ...other, sandboxHost: undefined });
  await mirrorSandboxToPeers(asSession(host), { lifecycle: "sleeping" });
  expect(stored.get("tab-2")?.sandbox?.lifecycle).toBe("awake");

  stored.set("tab-2", other);
  await mirrorSandboxToPeers(asSession(host), {
    sandboxId: "bx_2",
    lifecycle: "sleeping",
  });
  expect(stored.get("tab-2")?.sandbox).toEqual({
    provider: "box",
    sandboxId: "bx_2",
    workspace: "volume",
    lifecycle: "sleeping",
  });
  expect(stored.get("tab-1")?.sandbox?.lifecycle).toBe("awake");
});

test("a normal tab of a Sandbox session joins its machine; other remote workspaces refuse", () => {
  const boat = {
    source: "opensession",
    sandbox: { provider: "box", sandboxId: "bx_1", workspace: "volume" },
  } as const;
  expect(newTabWorkspace(boat, "share", true)).toBe("join");
  expect(newTabWorkspace(boat, "ask", true)).toBe("host");
  expect(newTabWorkspace(boat, "stack", true)).toEqual({
    error: expect.stringContaining("Stacked tabs aren't supported"),
  });
  // A session whose workspace is on this host keeps the host path.
  expect(
    newTabWorkspace(
      { source: "opensession", sandbox: { provider: "local" } },
      "share",
      false,
    ),
  ).toBe("host");
  for (const source of [
    { ...boat, automation: "nightly" },
    { ...boat, automationId: "auto-1" },
    { source: "opensession", runner: { id: "mac", name: "Mac" } },
  ])
    expect(newTabWorkspace(source as never, "share", true)).toEqual({
      error: expect.stringContaining("Open an Ask tab instead"),
    });
});
