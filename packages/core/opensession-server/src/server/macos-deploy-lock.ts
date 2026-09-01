import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const WAIT_MS = 15 * 60_000;
const ORPHAN_GRACE_MS = 5_000;

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/**
 * Coordinate restart-free frontend promotions with detached launchd deploys.
 * macOS does not ship flock, so the owner directory is the atomic lock and the
 * token prevents one waiter from releasing another process's lock.
 */
export async function acquireMacDeployLock(
  state: string,
  waitMs = WAIT_MS,
  pollMs = 1000,
): Promise<() => void> {
  const lock = join(state, ".macos-deploy-lock");
  const owner = join(lock, "owner.json");
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const token = crypto.randomUUID();
      writeFileSync(
        owner,
        `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return () => {
        try {
          const current = JSON.parse(readFileSync(owner, "utf8"));
          if (current.token === token) rmSync(lock, { recursive: true });
        } catch {}
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    try {
      const age = Date.now() - statSync(owner).mtimeMs;
      const current = JSON.parse(readFileSync(owner, "utf8"));
      if (!processIsAlive(Number(current.pid)) && age > ORPHAN_GRACE_MS) {
        rmSync(lock, { recursive: true });
        continue;
      }
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > ORPHAN_GRACE_MS) {
          rmSync(lock, { recursive: true });
          continue;
        }
      } catch {}
    }

    if (Date.now() >= deadline)
      throw new Error("timed out waiting for the active macOS deploy");
    await Bun.sleep(pollMs);
  }
}
