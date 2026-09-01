import { describe, expect, test } from "bun:test";
import { type MapDelta, makeUserMap } from "./user-map";

// A store with the server side driven by hand. There is no DOM under the test
// runner, so nothing auto-hydrates and no retry timer is armed: every
// hydration below is the one the test asked for.
function harness(user = "ann") {
  const saves: { user: string; delta: MapDelta<string> }[] = [];
  let respond: (map: Record<string, string>) => void = () => {};
  let fail: () => void = () => {};
  let resolveSave: () => void = () => {};
  let mode: "fail" | "deferred" | Record<string, string> = {};
  let saveMode: "success" | "fail" | "deferred" = "success";
  const store = makeUserMap<string>({
    changeEvent: "test-map-changed",
    fetchMap: () => {
      if (mode === "fail") return Promise.reject(new Error("502"));
      if (mode === "deferred")
        return new Promise<Record<string, string>>((resolve, reject) => {
          respond = resolve;
          fail = () => reject(new Error("502"));
        });
      return Promise.resolve({ ...mode });
    },
    saveDelta: async (u, delta) => {
      saves.push({ user: u, delta });
      if (saveMode === "fail") throw new Error("502");
      if (saveMode === "deferred")
        await new Promise<void>((resolve) => {
          resolveSave = resolve;
        });
      return delta;
    },
    currentUser: () => user,
  });
  return {
    store,
    saves,
    serves: (map: Record<string, string>) => {
      mode = map;
    },
    failsFetch: () => {
      mode = "fail";
    },
    failsSave: (on: boolean) => {
      saveMode = on ? "fail" : "success";
    },
    defersSave: () => {
      saveMode = "deferred";
    },
    resolveSave: () => resolveSave(),
    defers: () => {
      mode = "deferred";
    },
    respond: (map: Record<string, string>) => respond(map),
    fail: () => fail(),
    switchTo: (next: string) => {
      user = next;
    },
  };
}

describe("makeUserMap", () => {
  test("a failed hydration keeps the cache and does not mark the store ready", async () => {
    const h = harness();
    h.serves({ a: "1" });
    await h.store.hydrate();
    expect(h.store.get()).toEqual({ a: "1" });
    expect(h.store.ready()).toBe(true);

    h.failsFetch();
    await h.store.hydrate();
    // The empty response the fetch never gave us must not land in the cache.
    expect(h.store.get()).toEqual({ a: "1" });
    expect(h.saves).toEqual([]);
  });

  test("nothing is written when the first hydration fails", async () => {
    const h = harness();
    h.failsFetch();
    await h.store.hydrate();
    expect(h.store.ready()).toBe(false);
    expect(h.store.get()).toEqual({});

    // The write is held as an intent while the store has no server map.
    h.store.update((map) => ({ ...map, hidden: "now" }));
    await Promise.resolve();
    expect(h.saves).toEqual([]);
    expect(h.store.get()).toEqual({ hidden: "now" });

    // Once the server answers, the intent lands on top of its map and only
    // that one key is sent.
    h.serves({ other: "kept", gone: "kept" });
    await h.store.hydrate();
    expect(h.store.get()).toEqual({
      other: "kept",
      gone: "kept",
      hidden: "now",
    });
    expect(h.saves).toEqual([
      { user: "ann", delta: { set: { hidden: "now" }, remove: [] } },
    ]);
  });

  test("a delete made before hydration is applied to the server map", async () => {
    const h = harness();
    h.failsFetch();
    await h.store.hydrate();
    h.store.update((map) => ({ ...map, a: "local" }));
    h.store.update((map) => {
      const next = { ...map };
      delete next.a;
      return next;
    });
    h.serves({ a: "server", b: "server" });
    await h.store.hydrate();
    expect(h.store.get()).toEqual({ b: "server" });
    expect(h.saves).toEqual([
      { user: "ann", delta: { set: {}, remove: ["a"] } },
    ]);
  });

  test("a write during an in-flight hydration survives it", async () => {
    const h = harness();
    h.defers();
    const inFlight = h.store.hydrate();
    h.store.update((map) => ({ ...map, mine: "fresh" }));
    h.respond({ mine: "stale", other: "server" });
    await inFlight;
    expect(h.store.get()).toEqual({ mine: "fresh", other: "server" });
    expect(h.store.ready()).toBe(true);
  });

  test("a user switch mid-flight discards the stale response", async () => {
    const h = harness("ann");
    h.defers();
    const inFlight = h.store.hydrate("ann");
    h.switchTo("bo");
    h.respond({ ann: "only" });
    await inFlight;
    expect(h.store.get()).toEqual({});
    expect(h.store.ready()).toBe(false);
    expect(h.saves).toEqual([]);
  });

  test("a hydration superseded by a newer one is discarded", async () => {
    const h = harness();
    h.defers();
    const first = h.store.hydrate();
    const stale = h.respond;
    h.serves({ newer: "1" });
    await h.store.hydrate();
    stale({ older: "1" });
    await first;
    expect(h.store.get()).toEqual({ newer: "1" });
  });

  test("a write sends only what it changed", async () => {
    const h = harness();
    h.serves({ a: "1" });
    await h.store.hydrate();
    h.store.update((map) => ({ ...map, b: "2" }));
    expect(h.saves).toEqual([
      { user: "ann", delta: { set: { b: "2" }, remove: [] } },
    ]);
  });

  // The bug this file exists for: a Someday snooze made on one device came
  // back on its own because another client PUT its whole (older) map.
  test("a GET started before save confirmation cannot resurrect a removed key", async () => {
    const h = harness();
    h.serves({ ws: "someday" });
    await h.store.hydrate();
    h.defersSave();
    h.store.update((map) => {
      const next = { ...map };
      delete next.ws;
      return next;
    });

    // The GET reads before the delete lands, but its response reaches the
    // client after the delete's acknowledgement.
    h.defers();
    const staleGet = h.store.hydrate();
    h.resolveSave();
    await Promise.resolve();
    await Promise.resolve();
    h.respond({ ws: "someday" });
    await staleGet;
    expect(h.store.get()).toEqual({});
  });

  test("serializes writes so a later value cannot reach the server first", async () => {
    const h = harness();
    h.serves({});
    await h.store.hydrate();
    h.defersSave();
    h.store.update((map) => ({ ...map, ws: "tomorrow" }));
    h.store.update((map) => ({ ...map, ws: "someday" }));
    expect(h.saves).toEqual([
      { user: "ann", delta: { set: { ws: "tomorrow" }, remove: [] } },
    ]);

    h.resolveSave();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.saves).toEqual([
      { user: "ann", delta: { set: { ws: "tomorrow" }, remove: [] } },
      { user: "ann", delta: { set: { ws: "someday" }, remove: [] } },
    ]);
    h.resolveSave();
    await Promise.resolve();
  });

  test("a write whose save failed is re-sent on the next hydration", async () => {
    const h = harness();
    h.serves({});
    await h.store.hydrate();
    h.failsSave(true);
    h.store.update((map) => ({ ...map, ws: "someday" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.saves.length).toBe(1);

    // The server never got it, so its map lacks the key. The intent puts it
    // back and sends it again rather than letting the snooze evaporate.
    h.failsSave(false);
    h.serves({});
    await h.store.hydrate();
    expect(h.store.get()).toEqual({ ws: "someday" });
    expect(h.saves.length).toBe(2);
    expect(h.saves[1]).toEqual({
      user: "ann",
      delta: { set: { ws: "someday" }, remove: [] },
    });
  });

  test("a confirmed write stops being re-applied", async () => {
    const h = harness();
    h.serves({});
    await h.store.hydrate();
    h.store.update((map) => ({ ...map, ws: "someday" }));
    await Promise.resolve();
    await Promise.resolve();

    // Another device has since unsnoozed it. Our write is confirmed, so the
    // server's map is authoritative and the row stays awake.
    h.serves({});
    await h.store.hydrate();
    expect(h.store.get()).toEqual({});
    expect(h.saves.length).toBe(1);
  });

  test("a mutator returning null changes nothing", async () => {
    const h = harness();
    h.serves({ a: "1" });
    await h.store.hydrate();
    expect(h.store.update(() => null)).toEqual({ a: "1" });
    expect(h.saves).toEqual([]);
  });
});
