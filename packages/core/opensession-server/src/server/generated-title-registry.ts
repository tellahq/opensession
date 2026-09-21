import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonAtomicAsync } from "./shared/atomic-write";

/** A stable lock inode covers the entire read/merge/rename in a child process.
 * The OS releases the lock on exit, including when a gateway dies mid-write.
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
    [...command, process.execPath, import.meta.path, path],
    {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  child.stdin.write(JSON.stringify({ id, title }));
  child.stdin.end();
  const [code, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`Title registry write failed (${code}): ${error.trim()}`);
}

// Only the lock-owning child executes this path. No model call runs under the lock.
if (import.meta.main) {
  const path = process.argv[2];
  const { id, title } = JSON.parse(await Bun.stdin.text());
  if (!path || typeof id !== "string" || typeof title !== "string")
    throw new Error("Invalid title registry update");
  let registry: Record<string, string> = {};
  try {
    registry = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    // An unreadable or malformed registry must not be replaced with a partial map.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonAtomicAsync(path, { ...registry, [id]: title });
}
