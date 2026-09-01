import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recoverableLocalHostSnapshotRecords } from "./run-session";
import type { ActiveRunRecord } from "./run-journal";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("shutdown snapshot recovery", () => {
  test("promotes only still-present local hosts into journal recovery", () => {
    const hostsDir = mkdtempSync(join(tmpdir(), "local-host-snapshot-"));
    roots.push(hostsDir);
    mkdirSync(join(hostsDir, "rh-live"));
    writeFileSync(join(hostsDir, "rh-live", "spec.json"), "{}\n");
    const record = (overrides: Partial<ActiveRunRecord>): ActiveRunRecord => ({
      runKey: crypto.randomUUID(),
      osSessionId: crypto.randomUUID(),
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
      ...overrides,
    });
    const live = record({ runKey: "rh-live", hostId: "rh-live" });

    expect(
      recoverableLocalHostSnapshotRecords(
        [
          live,
          record({ runKey: "rh-gone", hostId: "rh-gone" }),
          record({ runKey: "sandbox", hostId: "rh-live", sandboxId: "sbx" }),
          record({ runKey: "ordinary" }),
        ],
        hostsDir,
      ),
    ).toEqual([live]);
  });
});
