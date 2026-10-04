import { expect, test } from "bun:test";
import { EngineRegistry, type EngineAdapter } from "./engine-adapter";
import { PI_CAPABILITIES } from "./engine-capabilities";

function fake(steering = false): EngineAdapter {
  return {
    kind: "test",
    capabilities: { ...PI_CAPABILITIES, supportsSteering: steering },
    async *run() {
      yield { type: "init", sessionId: "cursor" };
      yield { type: "done", result: "ok" };
    },
    busy: (id) => id === "cursor",
    activeCount: () => 1,
    steer: () => true,
    retract: () => true,
    cancel: () => true,
  };
}

test("registry dispatch decorates init without changing engine events", async () => {
  const registry = new EngineRegistry();
  registry.register(fake());
  const events = [];
  for await (const event of registry.run(
    "test",
    { prompt: "Hi", cwd: process.cwd(), mcpServers: [] },
    "test/model",
  ))
    events.push(event);
  expect(events[0]).toMatchObject({
    engineKind: "test",
    engineCapabilities: { version: 1, supportsSteering: false },
  });
  expect(events[1]).toEqual({ type: "done", result: "ok" });
  expect(registry.busy("cursor")).toBe(true);
  expect(registry.activeCount()).toBe(1);
});

test("unsupported actions never invoke the adapter", () => {
  const registry = new EngineRegistry();
  registry.register(fake());
  expect(registry.steer("cursor", "Hi")).toBe(false);
  expect(registry.retract("cursor", "receipt")).toBe(false);
  expect(registry.cancel("cursor")).toBe(true);
  expect(() => registry.register(fake())).toThrow("already registered");
  expect(() => registry.get("missing")).toThrow("Unknown engine");
});
