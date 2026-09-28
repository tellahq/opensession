import { describe, expect, test } from "bun:test";
import {
  assertAutomationEgressRestricted,
  daytonaDesktopUrl,
  daytonaCreateResources,
  daytonaCreateSource,
  daytonaDriver,
  daytonaSnapshotIsRecent,
  daytonaSnapshotIsRecoverable,
  parseDaytonaExecResult,
} from "./daytona";
import { startUploadFixture } from "./daytona-upload-fixture";

describe("Daytona create source", () => {
  test("cold repos without settings receive enough memory and disk for the runner", () => {
    const resources = daytonaCreateResources({} as any);
    expect(resources).toEqual({ cpu: 2, memory: 4, disk: 10 });
    expect(daytonaCreateSource(undefined, resources)).toEqual({
      image: "daytonaio/sandbox:0.8.0",
      resources: { cpu: 2, memory: 4, disk: 10 },
    });
  });

  test("keeps explicit provider sizing and snapshot precedence", () => {
    const resources = daytonaCreateResources({
      cpus: 4,
      memory: "8192m",
    } as any);
    expect(resources).toEqual({ cpu: 4, memory: 8, disk: 10 });
    expect(daytonaCreateSource("operator-snapshot", resources)).toEqual({
      snapshot: "operator-snapshot",
    });
  });

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
  test("preserves the OOM-killed compiler exit even with empty output", () => {
    expect(
      parseDaytonaExecResult({
        exitCode: 0,
        result: "__OS_STDERR_7f3a____OS_EXIT_91c2__137",
      }),
    ).toEqual({ exitCode: 137, stdout: "", stderr: "" });
  });

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

describe("Daytona egress policy probe", () => {
  const driverFor = (samples: string[]) => {
    const seen: string[] = [];
    return {
      seen,
      driver: {
        exec: async () => {
          seen.push("probe");
          const stdout = samples.length > 1 ? samples.shift()! : samples[0]!;
          return { exitCode: 0, stdout, stderr: "" };
        },
      } as any,
    };
  };
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  test("waits for Daytona to apply the allowlist instead of judging the first sample", async () => {
    const { driver, seen } = driverFor([
      "allowed=200 blocked=200",
      "allowed=000 blocked=000",
      "allowed=200 blocked=000",
    ]);
    await assertAutomationEgressRestricted(
      driver,
      "wss://ingress.example.test",
      "https://www.iana.org/",
      { intervalMs: 1_000, settleMs: 10_000, ...clock() },
    );
    expect(seen).toHaveLength(3);
  });

  test("reports an unenforced policy only after the settle window", async () => {
    const { driver, seen } = driverFor(["allowed=200 blocked=200"]);
    await expect(
      assertAutomationEgressRestricted(
        driver,
        "https://example.com",
        "https://www.iana.org/",
        { intervalMs: 1_000, settleMs: 3_000, ...clock() },
      ),
    ).rejects.toThrow(/not enforced by this Daytona org/);
    expect(seen).toHaveLength(4);
  });

  test("reports a blocked dial-back once the policy has settled", async () => {
    const { driver } = driverFor(["allowed=000 blocked=000"]);
    await expect(
      assertAutomationEgressRestricted(
        driver,
        "https://example.com",
        "https://www.iana.org/",
        { intervalMs: 1_000, settleMs: 2_000, ...clock() },
      ),
    ).rejects.toThrow(/blocks the dial-back URL/);
  });
});

describe("Daytona desktop", () => {
  test("opens noVNC on the signed preview host with autoconnect", () => {
    expect(
      daytonaDesktopUrl("https://6080-4kvyxv1qzdawyntz.daytonaproxy01.net"),
    ).toBe(
      "https://6080-4kvyxv1qzdawyntz.daytonaproxy01.net/vnc.html?autoconnect=1&resize=scale",
    );
  });
});

describe("Daytona file writes", () => {
  test("writeFile uses the signed upload URL, not the form-data SDK upload", async () => {
    const fixture = startUploadFixture();
    try {
      // SAFETY: replaces the SDK upload methods with tripwires for this test.
      const sandbox = fixture.sandbox as any;
      sandbox.fs.uploadFile = sandbox.fs.uploadFiles = () => {
        throw new Error("fs.uploadFile needs form-data at runtime");
      };
      await daytonaDriver(sandbox).writeFile(
        "/tmp/opensession-upload",
        "uploaded",
      );
      expect(fixture.uploads).toHaveLength(1);
      expect(fixture.uploads[0]).toMatchObject({
        path: "/tmp/opensession-upload",
        signatureValid: true,
      });
      expect(Buffer.from(fixture.uploads[0]!.bytes).toString()).toBe(
        "uploaded",
      );
    } finally {
      fixture.close();
    }
  });
});
