import { describe, expect, test } from "bun:test";
import {
  daytonaCreateResources,
  daytonaCreateSource,
  daytonaSnapshotIsRecent,
  daytonaSnapshotIsRecoverable,
  parseDaytonaExecResult,
} from "./daytona";

describe("Daytona create source", () => {
  test("uses the per-project machine profile for cold session fallbacks", () => {
    expect(
      daytonaCreateResources({} as any, {
        cpu: 2,
        memoryMb: 4096,
        diskGb: 8,
      }),
    ).toEqual({ cpu: 2, memory: 4, disk: 8 });
  });

  test("uses an explicit image whenever custom resources are requested", () => {
    expect(
      daytonaCreateSource(undefined, { cpu: 2, memory: 4, disk: 8 }),
    ).toEqual({
      image: "daytonaio/sandbox:0.8.0",
      resources: { cpu: 2, memory: 4, disk: 8 },
    });
  });

  test("never combines custom resources with a snapshot", () => {
    expect(
      daytonaCreateSource("opensession-tella-fusion", {
        cpu: 2,
        memory: 4,
        disk: 8,
      }),
    ).toEqual({ snapshot: "opensession-tella-fusion" });
  });

  test("recovers only fresh, completed provider snapshots", () => {
    const now = Date.parse("2026-08-11T13:00:00.000Z");
    expect(
      daytonaSnapshotIsRecoverable(
        { state: "active", updatedAt: "2026-08-11T12:55:00.000Z" },
        now,
      ),
    ).toBe(true);
    expect(
      daytonaSnapshotIsRecoverable(
        { state: "snapshotting", updatedAt: "2026-08-11T12:55:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      daytonaSnapshotIsRecoverable(
        { state: "active", updatedAt: "2026-08-11T11:55:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      daytonaSnapshotIsRecent({ updatedAt: "2026-08-11T12:55:00.000Z" }, now),
    ).toBe(true);
    expect(
      daytonaSnapshotIsRecent({ updatedAt: "2026-08-11T11:55:00.000Z" }, now),
    ).toBe(false);
  });
});

describe("Daytona exec transport", () => {
  test("recovers separate streams and a non-zero command exit code", () => {
    expect(
      parseDaytonaExecResult({
        exitCode: 0,
        result:
          "qualification-out__OS_STDERR_7f3a__qualification-err__OS_EXIT_91c2__7",
      }),
    ).toEqual({
      exitCode: 7,
      stdout: "qualification-out",
      stderr: "qualification-err",
    });
  });

  test("falls back to the SDK response for an unwrapped transport failure", () => {
    expect(
      parseDaytonaExecResult({ exitCode: 124, result: "timed out" }),
    ).toEqual({
      exitCode: 124,
      stdout: "timed out",
      stderr: "",
    });
  });
});
