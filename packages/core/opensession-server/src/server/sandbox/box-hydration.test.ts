import { expect, test } from "bun:test";
import { noteBoxHydrated, waitForBoxHydration } from "./box-hydration";
import type { Sandbox } from "./provider";

function fakeSandbox(
  id: string,
  states: string[],
): Sandbox & { probes: number; repairs: number } {
  const sandbox = {
    id,
    provider: "box",
    probes: 0,
    repairs: 0,
    async exec(command: string[]) {
      if (command.join(" ").includes(".bun/bin/bun")) {
        sandbox.repairs += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const stdout = states[Math.min(sandbox.probes, states.length - 1)]!;
      sandbox.probes += 1;
      return { exitCode: 0, stdout: `${stdout}\n`, stderr: "" };
    },
  };
  return sandbox as unknown as Sandbox & { probes: number; repairs: number };
}

test("returns at once when the disk is not being restored", async () => {
  const sandbox = fakeSandbox("bx_ready", ["ready"]);
  expect(await waitForBoxHydration(sandbox)).toBeLessThan(500);
  expect(sandbox.probes).toBe(1);
  // A binary the restore lost is checked for after every wait.
  expect(sandbox.repairs).toBe(1);
});

test("Boat's hydrated event ends the wait before the next check", async () => {
  const sandbox = fakeSandbox("bx_restoring", ["hydrating", "ready"]);
  setTimeout(() => noteBoxHydrated("bx_restoring"), 50);
  const waited = await waitForBoxHydration(sandbox, { recheckMs: 60_000 });
  expect(waited).toBeLessThan(5_000);
  expect(sandbox.probes).toBe(2);
});

test("a lost event falls back to checking, and the wait is bounded", async () => {
  const recovers = fakeSandbox("bx_lost", ["hydrating", "hydrating", "ready"]);
  await waitForBoxHydration(recovers, { recheckMs: 20 });
  expect(recovers.probes).toBe(3);
  const stuck = fakeSandbox("bx_stuck", ["hydrating"]);
  const waited = await waitForBoxHydration(stuck, {
    maxMs: 100,
    recheckMs: 20,
  });
  expect(waited).toBeLessThan(2_000);
});
