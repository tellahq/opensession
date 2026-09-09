import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  __resetSessionRowPublishesForTest,
  createSessionRowPublisher,
  SESSION_ROW_COALESCE_MS,
  sessionRowVisible,
  sidebarSubscribers,
} from "./session-row-events";
import type {
  SidebarSessionScope,
  SidebarSessionScopeContext,
} from "./sidebar-session-scope";
import type { UnifiedSession } from "./types";

afterEach(() => __resetSessionRowPublishesForTest());

function socket(sidebarScope?: SidebarSessionScope | null) {
  const sent: string[] = [];
  return {
    sent,
    data: sidebarScope === undefined ? {} : { sidebarScope },
    send(payload: string) {
      sent.push(payload);
    },
  };
}

function session(
  id: string,
  patch: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    createdBy: "Ada",
    startedBy: "Ada",
    title: id,
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    ...patch,
  } as UnifiedSession;
}

const scope = (patch: Partial<SidebarSessionScope> = {}) =>
  ({
    user: "Ada",
    person: "me",
    repo: "all",
    autoCreated: "hide",
    ...patch,
  }) satisfies SidebarSessionScope;

describe("session row fan-out", () => {
  test("coalesces a burst into one frame per session", () => {
    expect(SESSION_ROW_COALESCE_MS).toBe(250);
  });

  test("groups subscribed sockets by scope and skips the rest", () => {
    const ada = socket(scope());
    const adaAgain = socket(scope());
    const grace = socket(scope({ user: "Grace", person: "everyone" }));
    const unscoped = socket(null);
    const native = socket();

    const groups = sidebarSubscribers([ada, adaAgain, grace, unscoped, native]);

    expect(groups.size).toBe(3);
    const sockets = [...groups.values()].map((entry) => entry.sockets.length);
    expect(sockets.sort()).toEqual([1, 1, 2]);
    expect([...groups.values()].some((entry) => entry.scope === null)).toBe(
      true,
    );
    expect(
      [...groups.values()].flatMap((entry) => entry.sockets),
    ).not.toContain(native);
  });

  test("a row is visible in the lens that owns it and hidden from others", async () => {
    const row = session("mine");
    expect(await sessionRowVisible(row.id, [row], scope())).toBe(true);
    expect(await sessionRowVisible(row.id, [row], null)).toBe(true);
    expect(await sessionRowVisible(row.id, [], null)).toBe(false);
    expect(
      await sessionRowVisible(
        row.id,
        [row],
        scope({ user: "Grace", person: "me" }),
      ),
    ).toBe(false);
    expect(
      await sessionRowVisible(
        row.id,
        [row],
        scope({ user: "Grace", person: "everyone" }),
      ),
    ).toBe(true);
  });

  test("an archived row is never shown", async () => {
    const row = session("done", { archived: true });
    expect(await sessionRowVisible(row.id, [row], scope())).toBe(false);
    expect(await sessionRowVisible(row.id, [row], null)).toBe(false);
  });

  test("group rules see siblings: an idle worker stays with its selected parent", async () => {
    const parent = session("parent", { workspaceId: "ws-1" });
    const worker = session("worker", {
      workspaceId: "ws-1",
      parentSessionId: "parent",
      spawnedBy: "parent",
      createdBy: "Grace",
      startedBy: "Grace",
    });
    const selected = scope({ selectedSessionId: "parent" });
    // Alone, an idle spawned worker from another person is filtered out.
    expect(await sessionRowVisible(worker.id, [worker], selected)).toBe(false);
    // With its parent present, it belongs to the selected workspace group.
    expect(await sessionRowVisible(worker.id, [worker, parent], selected)).toBe(
      true,
    );
  });
});

function emptyContext(): SidebarSessionScopeContext {
  return {
    pins: new Set(),
    lanes: new Set(),
    snoozes: new Set(),
    hides: new Set(),
    mentions: new Set(),
    workspaces: new Map(),
    automations: new Map(),
    defaultRepo: "opensession",
  };
}
const publishers: ReturnType<typeof createSessionRowPublisher>[] = [];
afterEach(() => {
  for (const publisher of publishers.splice(0)) publisher.reset();
});
function setupPublisher(clients = [socket(scope())]) {
  const loaded: string[] = [];
  const contexts: Array<{ user: string; ids: string[] }> = [];
  const errors: unknown[] = [];
  const options: Parameters<typeof createSessionRowPublisher>[0] = {
    async loadRow(id: string) {
      loaded.push(id);
      const row = session(id, { workspaceId: `ws-${id}` });
      return { row, group: [row] };
    },
    subscribers: () => sidebarSubscribers(clients),
    async loadContext(
      scope: SidebarSessionScope,
      group: readonly UnifiedSession[],
    ) {
      contexts.push({ user: scope.user, ids: group.map((row) => row.id) });
      return emptyContext();
    },
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
  const publisher = createSessionRowPublisher(options);
  publishers.push(publisher);
  return { publisher, options, loaded, contexts, errors, clients };
}

describe("bounded row publisher", () => {
  test("60 changed rows share one catalog context per user, including every workspace", async () => {
    const ada = socket(scope());
    const selected = socket(scope({ selectedSessionId: "row-0" }));
    const grace = socket(scope({ user: "Grace", person: "everyone" }));
    const { publisher, loaded, contexts, errors } = setupPublisher([
      ada,
      selected,
      grace,
    ]);
    const ids = Array.from({ length: 60 }, (_, i) => `row-${i}`);
    for (const id of ids) {
      publisher.publish(id);
      publisher.publish(id);
    }
    await publisher.flush();
    expect(loaded).toEqual(ids);
    expect(contexts).toEqual([
      { user: "Ada", ids },
      { user: "Grace", ids },
    ]);
    expect(ada.sent).toHaveLength(60);
    expect(selected.sent).toHaveLength(60);
    expect(grace.sent).toHaveLength(60);
    expect(errors).toEqual([]);
  });

  test("keeps only one flush in flight while writes accumulate for the next batch", async () => {
    const { publisher, options, loaded, contexts, clients } = setupPublisher();
    const gate = Promise.withResolvers<void>();
    const original = options.loadRow;
    options.loadRow = async (id) => {
      await gate.promise;
      return original(id);
    };
    publisher.publish("a");
    const first = publisher.flush();
    for (let i = 0; i < 100; i++) publisher.publish("a");
    publisher.publish("b");
    expect(publisher.flush()).toBe(first);
    expect(publisher.pending()).toEqual(["a", "b"]);
    gate.resolve();
    await first;
    expect(loaded).toEqual(["a"]);
    expect(contexts).toHaveLength(1);
    await publisher.flush();
    expect(loaded).toEqual(["a", "a", "b"]);
    // No cross-batch cache: preferences changed during a flush are re-read.
    expect(contexts).toHaveLength(2);
    expect(clients[0]!.sent).toHaveLength(3);
  });

  test("limits each batch and schedules the remaining rows without dropping them", async () => {
    const { publisher, loaded, contexts } = setupPublisher();
    for (let i = 0; i < 100; i++) publisher.publish(String(i));
    await publisher.flush();
    expect(loaded).toHaveLength(64);
    expect(publisher.pending()).toHaveLength(36);
    await publisher.flush();
    expect(loaded).toHaveLength(100);
    expect(new Set(loaded).size).toBe(100);
    expect(contexts).toHaveLength(2);
    expect(publisher.pending()).toEqual([]);
  });

  test("a failed row does not remove it or prevent other rows from publishing", async () => {
    const { publisher, options, clients, errors } = setupPublisher();
    const original = options.loadRow;
    options.loadRow = async (id) => {
      if (id === "bad") throw new Error("index unavailable");
      return original(id);
    };
    publisher.publish("bad");
    publisher.publish("good");
    await publisher.flush();
    expect(errors).toHaveLength(1);
    expect(
      clients[0]!.sent.map((payload) => JSON.parse(payload).row.id),
    ).toEqual(["good"]);
  });

  test("a failed context neither hides rows nor prevents other users from receiving them", async () => {
    const ada = socket(scope());
    const grace = socket(scope({ user: "Grace", person: "everyone" }));
    const { publisher, options, errors } = setupPublisher([ada, grace]);
    const original = options.loadContext;
    options.loadContext = async (scope, group) => {
      if (scope.user === "Ada") throw new Error("catalog unavailable");
      return original(scope, group);
    };
    publisher.publish("a");
    await publisher.flush();
    expect(errors).toHaveLength(1);
    expect(ada.sent).toHaveLength(0);
    expect(grace.sent).toHaveLength(1);
  });

  test("removes missing rows without a catalog read", async () => {
    const { publisher, options, contexts, clients } = setupPublisher();
    options.loadRow = async () => null;
    publisher.publish("deleted");
    await publisher.flush();
    expect(contexts).toEqual([]);
    expect(clients[0]!.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "session_row_removed", id: "deleted" },
    ]);
  });

  test("an alias publishes the canonical row identity", async () => {
    const { publisher, options, clients } = setupPublisher();
    const original = options.loadRow;
    options.loadRow = () => original("canonical");
    publisher.publish("alias");
    await publisher.flush();
    expect(JSON.parse(clients[0]!.sent[0]!)).toMatchObject({
      type: "session_row",
      row: { id: "canonical" },
    });
  });

  test("no subscribers means no index or catalog reads", async () => {
    const { publisher, loaded, contexts } = setupPublisher([]);
    publisher.publish("a");
    await publisher.flush();
    expect(loaded).toEqual([]);
    expect(contexts).toEqual([]);
  });
});

test("a row wave bounds real catalog reads independently of row count", async () => {
  const { SessionKernelStore } = await import("./session-kernel/store");
  const { __setSessionKernelStoreForTest } =
    await import("./session-kernel/kernel");
  const { loadSidebarSessionScopeContext } =
    await import("./sidebar-session-scope");
  const store = new SessionKernelStore(":memory:");
  const previous = __setSessionKernelStoreForTest(store);
  const get = spyOn(store, "catalogDocumentGet");
  const getMany = spyOn(store, "catalogDocumentGetMany");
  const page = spyOn(store, "catalogDocumentPage");
  try {
    const { publisher, options, clients } = setupPublisher();
    options.loadContext = loadSidebarSessionScopeContext;
    for (let i = 0; i < 60; i++) publisher.publish(`row-${i}`);
    await publisher.flush();
    expect(clients[0]!.sent).toHaveLength(60);
    expect(get).toHaveBeenCalledTimes(1);
    expect(getMany.mock.calls.length).toBeLessThanOrEqual(6);
    // Each selected namespace is read once, whether workspace ownership is
    // supplied by the catalog or its warm gateway projection.
    expect(
      new Set(getMany.mock.calls.map(([namespace]) => namespace)).size,
    ).toBe(getMany.mock.calls.length);
    expect(page).toHaveBeenCalledTimes(1);
  } finally {
    get.mockRestore();
    getMany.mockRestore();
    page.mockRestore();
    __setSessionKernelStoreForTest(previous);
    store.close();
  }
});
