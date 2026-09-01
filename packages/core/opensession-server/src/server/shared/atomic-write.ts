/**
 * Crash-safe JSON persistence: write to a temp file in the same directory,
 * then rename over the target. Rename is atomic on the same filesystem, so a
 * crash/OOM mid-write leaves either the old file or the new one — never a
 * truncated half-JSON that readers silently swallow as `{}`/null.
 *
 * Use this for every state file under ~/.opensession-* (queues, journals,
 * sessions, automations, goals…). Append-only JSONL logs (audit, ledgers)
 * don't need it — a torn line there loses one record, not the file.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

export function writeFileAtomic(
  path: string,
  data: string,
  mode?: number,
): void {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(tmp, "wx", mode);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    try {
      rmSync(tmp);
    } catch {}
    throw error;
  }
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  pretty = true,
  mode?: number,
): void {
  writeFileAtomic(
    path,
    JSON.stringify(value, null, pretty ? 2 : undefined),
    mode,
  );
}
