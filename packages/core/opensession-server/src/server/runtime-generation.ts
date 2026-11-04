import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const RELEASE_MARKER = ".opensession-release";

/** Immutable release identity shared by the gateway, SessionKernel, and executor. */
export async function runtimeGeneration(root = process.cwd()): Promise<string> {
  try {
    const value = (
      await readFile(resolve(root, RELEASE_MARKER), "utf8")
    ).trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : "development";
  } catch {
    return "development";
  }
}

let current: Promise<string> | undefined;

/** This process's release identity, read once on first use. The release
 * worktree is immutable, so the value never changes while it runs. */
export function currentRuntimeGeneration(): Promise<string> {
  current ??= runtimeGeneration();
  return current;
}
