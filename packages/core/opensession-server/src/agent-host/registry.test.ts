import { describe, expect, test } from "bun:test";
import { AgentHostRegistry } from "../server/agent-host-registry";

const fence = {
  sessionId: "session",
  runId: "run",
  turnId: "turn",
  generation: 4,
};

describe("AgentHostRegistry", () => {
  test("registers, finds, and unregisters exact fenced ownership", () => {
    const registry = new AgentHostRegistry<object>();
    const owner = {};
    registry.register(fence, owner);
    expect(registry.find(fence)).toBe(owner);
    expect(registry.find({ ...fence, generation: 3 })).toBeUndefined();
    expect(registry.unregister({ ...fence, generation: 3 })).toBe(false);
    expect(registry.unregister(fence, {})).toBe(false);
    expect(registry.unregister(fence, owner)).toBe(true);
    expect(registry.find(fence)).toBeUndefined();
  });

  test("rejects duplicate and stale ownership", () => {
    const registry = new AgentHostRegistry<string>();
    registry.register(fence, "owner");
    expect(() => registry.register(fence, "duplicate")).toThrow("duplicate");
    expect(() =>
      registry.register({ ...fence, generation: 3 }, "stale"),
    ).toThrow("stale");
  });
});
