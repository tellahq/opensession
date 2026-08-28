import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_PROTECTED_PHYSICAL_BYTES } from "./ledger-accounting";
import { GenerationEmergencyReserve } from "./emergency-reserve";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("generation emergency reserve", () => {
  test("physically preallocates 64 MiB with exact generation ownership and mode", () => {
    const dir = directory("agent-host-reserve-");
    const reserve = new GenerationEmergencyReserve({ stateDirectory: dir });
    reserve.replenish();
    const stat = statSync(reserve.path);
    expect(stat.size).toBe(LEDGER_PROTECTED_PHYSICAL_BYTES);
    expect(Number(stat.blocks) * 512).toBeGreaterThanOrEqual(stat.size);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.uid).toBe(process.getuid!());
    expect(stat.gid).toBe(process.getgid!());
    const released = reserve.consume(12345);
    expect(released).toBeGreaterThanOrEqual(12345);
    reserve.replenish();
    expect(statSync(reserve.path).size).toBe(LEDGER_PROTECTED_PHYSICAL_BYTES);
    reserve.close();
  });

  test("keeps reserve blocks when another consumer reaches real ENOSPC where mounting is permitted", () => {
    if (process.platform !== "linux" || process.getuid?.() !== 0) return;
    const mountpoint = directory("agent-host-reserve-fs-");
    const mounted = spawnSync("mount", [
      "-t",
      "tmpfs",
      "-o",
      "size=80m,mode=700",
      "tmpfs",
      mountpoint,
    ]);
    if (mounted.status !== 0) return; // CI commonly lacks CAP_SYS_ADMIN.
    try {
      const reserve = new GenerationEmergencyReserve({
        stateDirectory: mountpoint,
      });
      reserve.replenish();
      const fd = openSync(
        join(mountpoint, "unrelated-consumer"),
        constants.O_CREAT | constants.O_WRONLY,
        0o600,
      );
      const chunk = new Uint8Array(1024 * 1024);
      let sawEnospc = false;
      try {
        for (;;) writeSync(fd, chunk);
      } catch (error) {
        sawEnospc = (error as NodeJS.ErrnoException).code === "ENOSPC";
      } finally {
        closeSync(fd);
      }
      expect(sawEnospc).toBe(true);
      const after = reserve.snapshot();
      expect(after.logicalBytes).toBe(LEDGER_PROTECTED_PHYSICAL_BYTES);
      expect(after.allocatedBytes).toBeGreaterThanOrEqual(after.logicalBytes);
      reserve.close();
    } finally {
      spawnSync("umount", [mountpoint]);
    }
  });
});
