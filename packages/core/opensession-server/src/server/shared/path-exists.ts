import { access } from "node:fs/promises";

/** Whether `path` names an existing file or directory: the non-blocking
 * counterpart of `existsSync` for code on the gateway thread. Prefer reading
 * the file and catching ENOENT when the content is wanted anyway. */
export function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
