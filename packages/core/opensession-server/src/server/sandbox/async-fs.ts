/**
 * Small async filesystem helpers for gateway-imported sandbox code, which must
 * never block the event loop with the synchronous `fs` APIs.
 */
import { readFile, stat } from "fs/promises";

/** True when `path` exists (file, directory or anything else). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** File contents as UTF-8, or null when it is missing or unreadable. */
export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
