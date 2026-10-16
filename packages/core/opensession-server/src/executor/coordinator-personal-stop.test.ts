import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutorCoordinator } from "./coordinator";
import { hostUnitActive } from "./host-unit";
import { runHostsDir } from "../runner-host/protocol";
import { EXECUTOR_PROTOCOL_VERSION } from "@tellahq/opensession-protocol/executor";

for (const scenario of [
  "collected",
  "active",
  "ready",
  "probe throws",
  "unknown boolean",
] as const)
  test(`failed stop dispatch barrier: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "collected-executor-"));
    const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc";
    const dir = join(runHostsDir(root), hostId);
    await mkdir(dir, { recursive: true });
    const bytes = JSON.stringify({
      hostId,
      osSessionId: "fixture",
      cwd: root,
      prompt: "synthetic",
      mcpServers: [],
    });
    await writeFile(join(dir, "spec.json"), bytes);
    const specHash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    let launched = false,
      stopping = false,
      launches = 0;
    const token = "synthetic";
    const coordinator = new ExecutorCoordinator(root, token, {
      launch: async () => {
        launches++;
        launched = true;
      },
      stop: async () => {
        stopping = true;
        throw new Error("collected unit is not loaded");
      },
      unitActive: async () => {
        if (!stopping) return false;
        if (scenario === "probe throws") throw new Error("probe unavailable");
        if (scenario === "unknown boolean")
          return undefined as unknown as boolean;
        return scenario === "active";
      },
      hostReady: () => (stopping ? scenario === "ready" : launched),
      hostStarted: () => launched,
      now: () => new Date().toISOString(),
    });
    const request = {
      token,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    };
    try {
      expect(
        (
          await coordinator.handle({
            ...request,
            t: "launch_host",
            requestId: "launch",
          })
        ).ok,
      ).toBe(true);
      const stopped = await coordinator.handle({
        ...request,
        t: "stop_host",
        requestId: "stop",
      });
      expect(stopped.ok).toBe(scenario === "collected");
      if (scenario === "collected") {
        expect(stopped.ok && stopped.status?.state).toBe("stopped");
        const replay = await coordinator.handle({
          ...request,
          t: "launch_host",
          requestId: "late launch",
        });
        expect(replay.ok && replay.status?.state).toBe("stopped");
        expect(launches).toBe(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("systemd no-unit output is distinct from failed or malformed unit probe", async () => {
  for (const value of [
    { output: "unknown\n", code: 4, result: false },
    { output: "active\n", code: 0, result: true },
    { output: "unrecognized\n", code: 1, result: true },
    { output: "", code: 1, result: "error" },
  ]) {
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdout: new Response(value.output).body,
      exited: Promise.resolve(value.code),
    })) as unknown as typeof Bun.spawn);
    try {
      if (value.result === "error")
        await expect(hostUnitActive("rh-fixture")).rejects.toThrow(
          "without a unit state",
        );
      else
        expect(await hostUnitActive("rh-fixture")).toBe(
          value.result as boolean,
        );
    } finally {
      spawn.mockRestore();
    }
  }
});
