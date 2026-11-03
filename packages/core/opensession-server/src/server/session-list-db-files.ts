/**
 * Filesystem setup around the session-list SQLite file. Only the session-list
 * worker (and tests that open a file-backed index) import this, so its
 * synchronous calls never run on the gateway thread; SessionListStore itself
 * stays free of filesystem I/O because the gateway imports it.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SessionListStore } from "./session-list-sqlite";

/** Open the index at `path`: its directory is created first, and the
 * database, WAL and shared-memory files are left readable by the owner only. */
export function openSessionListStoreFile(path: string): SessionListStore {
  if (path === ":memory:") return new SessionListStore(path);
  mkdirSync(dirname(path), { recursive: true });
  const store = new SessionListStore(path);
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
  return store;
}
