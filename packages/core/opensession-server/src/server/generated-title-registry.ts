import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonAtomicAsync } from "./shared/atomic-write";

async function lockReady(stream: ReadableStream<Uint8Array>): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let line = "";
  try {
    while (line.length < "LOCKED\n".length) {
      const chunk = await reader.read();
      if (chunk.done) break;
      line += decoder.decode(chunk.value, { stream: true });
    }
    return line === "LOCKED\n";
  } finally {
    reader.releaseLock();
  }
}

/** A shell child holds a stable lock inode while the caller reads/merges/writes.
 * Closing stdin (including on gateway death) releases the OS lock. No source
 * helper is re-executed, so this works in compiled installs without Bun on PATH.
 * Never unlink the lock file: existing waiters must keep locking the same inode. */
export async function writeGeneratedTitleRegistry(
  path: string,
  id: string,
  title: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const command =
    process.platform === "darwin"
      ? ["/usr/bin/lockf", "-k", "-t", "10", lock]
      : ["flock", "-w", "10", lock];
  const child = Bun.spawn(
    [...command, "/bin/sh", "-c", "printf 'LOCKED\\n'; /bin/cat >/dev/null"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  try {
    if (!(await lockReady(child.stdout)))
      throw new Error("Title registry lock was not acquired");
    let registry: Record<string, string> = {};
    try {
      registry = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      // An unreadable or malformed registry must not be replaced with a partial map.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeJsonAtomicAsync(path, { ...registry, [id]: title });
  } finally {
    child.stdin.end();
    const [code, error] = await Promise.all([child.exited, stderr]);
    if (code !== 0)
      throw new Error(`Title registry lock failed (${code}): ${error.trim()}`);
  }
}
