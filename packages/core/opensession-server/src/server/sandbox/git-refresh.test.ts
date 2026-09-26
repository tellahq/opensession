import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GIT_REFRESH_INDEX,
  GIT_RESTORE_STABLE_CONFIG,
} from "./adapters/bootstrap";

const sh = (cwd: string, script: string) => {
  const run = Bun.spawnSync(["bash", "-c", script], { cwd });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
};

// A snapshot restore moves every file to a new inode. Without a refresh,
// `reset --hard` rewrote every unchanged file, and ReScript then rebuilt
// every module because each source looked newer than its output.
test("a hard reset after a restore leaves unchanged files untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "git-refresh-"));
  try {
    const original = join(root, "original");
    sh(
      root,
      "git init -q original && cd original && git config user.email a@example.test && git config user.name a",
    );
    for (let i = 0; i < 20; i++)
      writeFileSync(join(original, `m${i}.res`), `${i}\n`);
    sh(
      original,
      "git add . && git commit -qm init && touch -d 2026-01-01 m*.res && git update-index -q --refresh",
    );
    const stamp = statSync(join(original, "m0.res")).mtimeMs;
    for (const [name, prepare] of [
      ["refreshed", GIT_REFRESH_INDEX],
      ["minimal", GIT_RESTORE_STABLE_CONFIG],
    ] as const) {
      // cp -a keeps mtimes but gives new inodes and ctimes, like a restore.
      sh(root, `cp -a original ${name}`);
      sh(join(root, name), `${prepare} && git reset --hard -q HEAD`);
      expect(statSync(join(root, name, "m0.res")).mtimeMs).toBe(stamp);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
