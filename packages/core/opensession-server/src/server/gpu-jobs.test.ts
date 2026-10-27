import { describe, expect, test } from "bun:test";
import {
  gpuJobEndedMessage,
  gpuMachineOwner,
  gpuMachineSessionId,
  isGpuJobMachine,
  MAX_GPU_JOB_MINUTES,
  parseRepoGpuJobs,
  type GpuJobRecord,
} from "./gpu-jobs";

describe("repository GPU job declarations", () => {
  test("keeps well-formed jobs and fills defaults", () => {
    const jobs = parseRepoGpuJobs(
      JSON.stringify({
        jobs: {
          "gpu-tests": {
            command: "scripts/gpu-tests.sh",
            gpu: "l4",
            timeoutMinutes: 9999,
            description: "Render tests",
          },
          quick: { command: "nvidia-smi" },
          "bad name!": { command: "true" },
          empty: { command: "  " },
        },
      }),
    );
    expect(jobs).toEqual({
      "gpu-tests": {
        command: "scripts/gpu-tests.sh",
        gpu: "L4",
        timeoutMinutes: MAX_GPU_JOB_MINUTES,
        description: "Render tests",
      },
      quick: { command: "nvidia-smi", gpu: "T4", timeoutMinutes: 60 },
    });
  });

  test("a malformed file declares nothing", () => {
    expect(parseRepoGpuJobs("{")).toEqual({});
    expect(parseRepoGpuJobs('{"jobs":[]}')).toEqual({});
  });
});

describe("GPU job machine ids", () => {
  test("map back to their session", () => {
    expect(gpuMachineSessionId("os-1")).toBe("os-1--gpu");
    expect(isGpuJobMachine("md-os-1--gpu")).toBe(true);
    expect(isGpuJobMachine("md-os-1")).toBe(false);
    expect(gpuMachineOwner("md-os-1--gpu")).toBe("os-1");
    expect(gpuMachineOwner("md-os-1--portals")).toBeNull();
  });
});

describe("the message that wakes the session", () => {
  const job: GpuJobRecord = {
    id: "gj-1",
    sessionId: "os-1",
    title: "gpu-tests",
    command: "x",
    gpu: "T4",
    state: "exited",
    exitCode: 1,
    startedAt: "2026-10-26T10:00:00.000Z",
    endedAt: "2026-10-26T10:03:05.000Z",
    deadlineAt: "2026-10-26T11:00:00.000Z",
    commit: "0123456789abcdef",
    logPath: "/scratch/gpu-jobs/gj-1.log",
  };

  test("says how it ended, where, and how it ended up", () => {
    const text = gpuJobEndedMessage(job, "test result: FAILED\n");
    expect(text).toContain(
      'GPU job "gpu-tests" (gj-1, T4) exited with code 1 after 3m 5s.',
    );
    expect(text).toContain("It ran on 0123456789ab.");
    expect(text).toContain("Full log: /scratch/gpu-jobs/gj-1.log");
    expect(text).toContain("Last output:\ntest result: FAILED");
  });

  test("a job that never ran reports its error, not an exit code", () => {
    const text = gpuJobEndedMessage(
      { ...job, state: "failed", error: "no capacity", logPath: undefined },
      "",
    );
    expect(text).toContain("could not run after");
    expect(text).toContain("Error: no capacity");
    expect(text).not.toContain("code 1");
  });
});
