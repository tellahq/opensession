import { access } from "node:fs/promises";

/** The asynchronous counterpart of `existsSync`: true when `path` exists
 *  (F_OK), false on any error. Prefer reading the file and catching ENOENT
 *  when the next step reads it anyway. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
