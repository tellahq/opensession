/**
 * Serialized, non-blocking writes of the sandbox config file (sandbox.json).
 *
 * Workspace settings (config.ts) and provider connections (connections.ts)
 * both rewrite this one file. Each update re-reads the file, applies its
 * change and replaces the file atomically, one at a time, so two concurrent
 * settings saves can never drop each other's keys.
 */
import { mkdir, readFile } from "fs/promises";
import { dirname } from "path";
import { stateDir } from "../paths";
import { writeJsonAtomicAsync } from "../shared/atomic-write";

/** Env-overridable so tests and the verify suite can use a scratch file. */
export function sandboxConfigFilePath(): string {
  return process.env.OPENSESSION_SANDBOX_CONFIG || stateDir("sandbox.json");
}

let tail: Promise<unknown> = Promise.resolve();

/** Re-read sandbox.json, let `mutate` change it in place, write it back.
 * Every other key (provider secrets, connections, operator settings) is kept.
 * Resolves with `mutate`'s result once the new file is in place. */
export function updateSandboxConfigFile<T>(
  mutate: (raw: Record<string, unknown>) => T,
): Promise<T> {
  const run = tail.then(async () => {
    const path = sandboxConfigFilePath();
    let raw: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        raw = parsed;
    } catch {}
    const result = mutate(raw);
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomicAsync(path, raw);
    return result;
  });
  tail = run.catch(() => {});
  return run;
}
