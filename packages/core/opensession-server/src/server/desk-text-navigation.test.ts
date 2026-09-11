import { describe, expect, test } from "bun:test";
import { DeskTextNavigation } from "./desk-text-navigation";

function setup(registry = new DeskTextNavigation(), login = "alice") {
  const connection = registry.connect("desk", login);
  if (!connection) throw new Error("missing connection");
  const bind = () => {
    const requestId = crypto.randomUUID();
    expect(
      registry.bind(
        login,
        connection.connectionId,
        connection.token,
        requestId,
      ),
    ).toBe(true);
    return requestId;
  };
  const poll = () => registry.handle(login, { action: "poll", ...connection });
  return { registry, connection, bind, poll };
}
const target = { kind: "workspace", id: "ws-1" } as const;

describe("text Desk navigation authority", () => {
  test("HTTP registration alone cannot authorize a run", () => {
    const { registry, bind } = setup();
    const request = bind();
    registry.begin("desk", "turn", [request]);
    expect(registry.forTurn("desk", "turn")).toBeUndefined();
  });

  test("requires the same verified sender and exact Desk session at intake", () => {
    for (const [sessionId, login] of [
      ["desk", undefined],
      ["desk", "other-alice"],
      ["other-desk", "alice"],
    ]) {
      const { registry, bind } = setup();
      const request = bind();
      registry.accept(sessionId!, request, login);
      registry.begin("desk", "turn", [request]);
      expect(registry.forTurn("desk", "turn")).toBeUndefined();
    }
  });

  test("delivers only to the originating browser and waits for its acknowledgment", async () => {
    const { registry, connection, bind, poll } = setup();
    const request = bind();
    registry.accept("desk", request, "alice");
    const finish = registry.begin("desk", "turn", [request]);
    const navigation = registry.forTurn("desk", "turn");
    if (!navigation) throw new Error("missing navigation");
    expect(registry.forTurn("desk", "different-turn")).toBeUndefined();
    expect(registry.forTurn("other-desk", "turn")).toBeUndefined();
    const shown = navigation.show(target);
    expect(
      registry.handle("other-alice", { action: "poll", ...connection }),
    ).toBeNull();
    expect(
      registry.handle("alice", {
        action: "poll",
        ...connection,
        token: crypto.randomUUID(),
      }),
    ).toBeNull();
    const polled = poll();
    if (!polled || !("command" in polled) || !polled.command)
      throw new Error("missing command");
    expect(polled.command.target).toEqual(target);
    expect(
      registry.handle("alice", {
        action: "ack",
        ...connection,
        commandId: polled.command.id,
        shown: true,
      }),
    ).toEqual({ ok: true });
    expect(await shown).toEqual({ shown: true });
    finish();
    expect(await navigation.show(target)).toMatchObject({ shown: false });
    expect(poll()).toEqual({ command: null, finished: true });
    expect(poll()).toBeNull();
  });

  test("queue batches from one browser work; mixed tabs and machine messages fail closed", () => {
    for (const mixed of [false, true]) {
      const { registry, bind } = setup();
      const other = mixed ? setup(registry).bind : bind;
      const ids = [bind(), other()];
      for (const id of ids) registry.accept("desk", id, "alice");
      const finish = registry.begin("desk", "turn", ids);
      expect(Boolean(registry.forTurn("desk", "turn"))).toBe(!mixed);
      finish();
    }
    const { registry, bind } = setup();
    const request = bind();
    registry.accept("desk", request, "alice");
    registry.begin("desk", "turn", [request, "machine-message"]);
    expect(registry.forTurn("desk", "turn")).toBeUndefined();
  });

  test("a later queued turn cannot retarget an earlier tool closure", async () => {
    const { registry, bind } = setup();
    const a = bind();
    registry.accept("desk", a, "alice");
    const finishA = registry.begin("desk", "turn-a", [a]);
    const previous = registry.forTurn("desk", "turn-a");
    const b = setup(registry).bind();
    registry.accept("desk", b, "alice");
    finishA();
    const finishB = registry.begin("desk", "turn-b", [b]);
    expect(await previous?.show(target)).toMatchObject({ shown: false });
    expect(registry.forTurn("desk", "turn-b")).toBeDefined();
    finishB();
  });

  test("another browser cannot replace a message binding", () => {
    const { registry, bind } = setup();
    const request = bind();
    const other = setup(registry).connection;
    expect(
      registry.bind("alice", other.connectionId, other.token, request),
    ).toBe(false);
  });

  test("steering from another browser or machine revokes the original turn", async () => {
    for (const sameBrowser of [true, false]) {
      const { registry, bind } = setup();
      const request = bind();
      registry.accept("desk", request, "alice");
      const finish = registry.begin("desk", "turn", [request]);
      const navigation = registry.forTurn("desk", "turn");
      const pending = navigation?.show(target);
      const steer = sameBrowser ? bind() : "machine-message";
      if (sameBrowser) registry.accept("desk", steer, "alice");
      registry.steer("desk", steer);
      expect(Boolean(registry.forTurn("desk", "turn"))).toBe(sameBrowser);
      finish();
      expect(await pending).toMatchObject({ shown: false });
    }
  });

  test("disconnect, expiry and restart invalidate outstanding authority", async () => {
    let now = 1_000;
    const { registry, connection, bind } = setup(
      new DeskTextNavigation(() => now),
    );
    const request = bind();
    registry.accept("desk", request, "alice");
    const finish = registry.begin("desk", "turn", [request]);
    const navigation = registry.forTurn("desk", "turn");
    const pending = navigation?.show(target);
    now += 60_001;
    expect(registry.forTurn("desk", "turn")).toBeUndefined();
    expect(await pending).toMatchObject({ shown: false });
    expect(await navigation?.show(target)).toMatchObject({ shown: false });
    expect(
      registry.disconnect("alice", connection.connectionId, connection.token),
    ).toBe(false);
    expect(new DeskTextNavigation().forTurn("desk", "turn")).toBeUndefined();
    finish();
  });
});
