import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "../config";
import {
  execOnMachine,
  listMachineViews,
  pollMachine,
  reserveMachine,
  setManagedMachineDepsForTests,
  startMachine,
  stopMachine,
} from ".";
import type { CommandResult } from "./run";
import { resetMachineStoreForTests } from "./store";

const dir = mkdtempSync(join(tmpdir(), "os-managed-machines-"));
process.env.OPENSESSION_STATE_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
let now = 0;
let status: CommandResult;
let calls: string[][];
let powerResult: CommandResult;

async function configure(extra: Record<string, unknown> = {}) {
  const path = join(dir, `config-${Math.random()}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      managedMachines: [
        {
          id: "gpu-box",
          label: "GPU box",
          start: ["power", "on"],
          stop: ["power", "off"],
          status: ["power", "status"],
          exec: ["remote", "--", "bash", "-lc"],
          idleStopMinutes: 30,
          idleCpuBelow: 0.1,
          idleGpuBelow: 0.05,
          ...extra,
        },
        // Rejected: a shell string, not an argv array.
        { id: "bad", start: "power on", stop: ["x"], status: ["y"] },
      ],
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
}

function json(value: unknown): CommandResult {
  return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

async function view() {
  const machines = await listMachineViews("ana");
  return machines.find((m) => m.id === "gpu-box")!;
}

async function pollFor(minutes: number) {
  const { managedMachines } = await getConfigAsync();
  for (let m = 0; m < minutes; m++) {
    now += MIN;
    await pollMachine(managedMachines![0]);
  }
}

const stops = () => calls.filter((c) => c[1] === "off").length;

beforeEach(async () => {
  // A fresh state dir per case: reservations are durable.
  process.env.OPENSESSION_STATE_DIR = mkdtempSync(join(dir, "state-"));
  now = 1_000 * MIN;
  calls = [];
  status = json({ state: "on", cpu: 0.01, gpu: 0 });
  powerResult = { code: 0, stdout: "", stderr: "" };
  resetMachineStoreForTests();
  setManagedMachineDepsForTests({
    now: () => now,
    run: async (argv, options) => {
      calls.push(argv);
      if (argv[1] === "status") return status;
      if (argv[0] === "remote") {
        if (options.signal)
          await new Promise((resolve) => {
            if (options.signal!.aborted) resolve(null);
            options.signal!.addEventListener("abort", resolve);
          });
        return { code: 0, stdout: "ran\n", stderr: "" };
      }
      return powerResult;
    },
  });
  await configure();
});

describe("managed machine config", () => {
  test("parseConfig keeps valid machines and drops shell strings", async () => {
    const config = await getConfigAsync();
    expect(config.managedMachines?.map((m) => m.id)).toEqual(["gpu-box"]);
    expect(config.managedMachines?.[0]).toMatchObject({
      exec: ["remote", "--", "bash", "-lc"],
      pollSeconds: 60,
      idle: { minutes: 30, cpuBelow: 0.1, gpuBelow: 0.05 },
    });
  });

  test("an idle stop needs an activity threshold", async () => {
    await configure({ idleCpuBelow: undefined, idleGpuBelow: undefined });
    expect((await getConfigAsync()).managedMachines).toEqual([]);
  });
});

describe("idle stop", () => {
  test("stops after the full idle period, once", async () => {
    await pollFor(30);
    expect(stops()).toBe(0);
    await pollFor(1);
    expect(stops()).toBe(1);
    expect((await view()).lastAction).toMatchObject({
      kind: "stop",
      via: "idle",
      ok: true,
    });
  });

  test("a failing status command keeps it on and asks for attention", async () => {
    await pollFor(20);
    status = { code: 1, stdout: "", stderr: "Unauthorized" };
    await pollFor(1);
    status = json({ state: "on", cpu: 0.01, gpu: 0 });
    await pollFor(30);
    expect(stops()).toBe(0);
    status = { code: 1, stdout: "", stderr: "Unauthorized" };
    await pollFor(1);
    expect((await view()).state).toBe("unknown");
    expect((await view()).attention).toContain("Unauthorized");
  });

  test("a reservation keeps it on", async () => {
    await reserveMachine("gpu-box", {
      user: "ana",
      reason: "training",
      durationMinutes: 120,
    });
    await pollFor(90);
    expect(stops()).toBe(0);
    expect((await view()).idle).toMatchObject({ kind: "held" });
  });

  test("an exec in flight keeps it on", async () => {
    await pollFor(1);
    const controller = new AbortController();
    const running = execOnMachine("gpu-box", "train.py", {
      user: "ana",
      timeoutMs: 60 * MIN,
      signal: controller.signal,
    });
    while (!calls.some((call) => call[0] === "remote")) await Bun.sleep(1);
    await pollFor(60);
    expect(stops()).toBe(0);
    controller.abort();
    await running;
    await pollFor(30);
    expect(stops()).toBe(0);
    await pollFor(1);
    expect(stops()).toBe(1);
  });

  test("a failed stop is shown and retried later, not hidden", async () => {
    powerResult = { code: 2, stdout: "", stderr: "workflow not found" };
    await pollFor(31);
    expect(stops()).toBe(1);
    const machine = await view();
    expect(machine.lastAction).toMatchObject({ ok: false });
    expect(machine.attention).toContain("workflow not found");
    // The attempt itself restarts the idle period, so the retry waits a
    // full period again (and at least ten minutes).
    await pollFor(30);
    expect(stops()).toBe(1);
    await pollFor(1);
    expect(stops()).toBe(2);
  });
});

describe("start, stop and exec", () => {
  test("exec appends the command as one argument", async () => {
    await pollFor(1);
    const result = await execOnMachine("gpu-box", "nvidia-smi; ls", {
      user: "ana",
      timeoutMs: 1_000,
    });
    expect(result.stdout).toBe("ran\n");
    expect(calls.at(-1)).toEqual([
      "remote",
      "--",
      "bash",
      "-lc",
      "nvidia-smi; ls",
    ]);
  });

  test("exec is refused unless the last poll says on", async () => {
    status = json({ state: "off" });
    await pollFor(1);
    await expect(
      execOnMachine("gpu-box", "ls", { user: "ana", timeoutMs: 1_000 }),
    ).rejects.toThrow(/is off.*start_runner/);
  });

  test("stop is refused while someone else holds a reservation", async () => {
    await reserveMachine("gpu-box", { user: "bo", reason: "eval" });
    await expect(
      stopMachine("gpu-box", { user: "ana", via: "agent" }),
    ).rejects.toThrow(/in use/);
    await stopMachine("gpu-box", { user: "bo", via: "agent" });
    expect(stops()).toBe(1);
  });

  test("a failed start throws and is kept as the last action", async () => {
    powerResult = { code: 1, stdout: "", stderr: "quota" };
    await expect(
      startMachine("gpu-box", { user: "ana", via: "user" }),
    ).rejects.toThrow(/quota/);
    expect((await view()).lastAction).toMatchObject({
      kind: "start",
      ok: false,
    });
  });

  test("allowedUsers limits who may use it", async () => {
    await configure({ allowedUsers: ["bo"] });
    await expect(
      startMachine("gpu-box", { user: "ana", via: "user" }),
    ).rejects.toThrow(/not allowed/);
    expect((await view()).allowed).toBe(false);
  });
});
