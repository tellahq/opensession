import { expect, test } from "bun:test";
import { waitForPortalPort } from "./portal-supervisor";

function ops(state: { listening: boolean; alive: boolean }) {
  return {
    probePort: async () => state.listening,
    pidAlive: async () => state.alive,
    groupAlive: async () => state.alive,
  };
}

test("a server that answers once and then exits is not ready", async () => {
  const state = { listening: true, alive: true };
  const waiting = waitForPortalPort(ops(state), 4000, { pid: 42 }, 5_000, 50);
  // Next binds, then fails to load its config and exits.
  setTimeout(() => {
    state.listening = false;
    state.alive = false;
  }, 10);
  expect(await waiting).toBe("exited");
});

test("a server that keeps listening is ready after the settle window", async () => {
  const state = { listening: true, alive: true };
  expect(
    await waitForPortalPort(ops(state), 4000, { pid: 42 }, 5_000, 20),
  ).toBe("ready");
});
