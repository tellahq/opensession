/**
 * A small file that remembers, per pi conversation, which Claude Agent SDK
 * session holds it.
 *
 * The pi Anthropic provider (pi-model-runtime.ts) keeps that mapping in
 * memory, and every turn of a session runs in a fresh process. Without this
 * file the next turn's process knows nothing of the last one's SDK session,
 * starts a new one and replays the whole conversation into it, which the
 * model provider bills as a prompt-cache write instead of a read.
 *
 * One file per session directory, a handful of entries keyed by the
 * provider's store key (the newest win). The file is advice, never
 * authority: a missing, unreadable or stale file only means the next turn
 * replays, exactly as before it existed, and a write that fails is logged
 * and dropped. Reads and writes are async and whole-file; writes go through
 * a rename so a reader never sees half of one.
 */

import { readFile } from "node:fs/promises";
import { writeFileAtomicAsync } from "./shared/atomic-write";

export const CLAUDE_SDK_SESSION_FILE = "claude-sdk-sessions.json";

/** A conversation's model, prompt or tools changing gives it a new key, and
 *  a compaction summary has one of its own; keep a few so switching back
 *  finds the earlier session. */
export const MAX_SDK_SESSION_FILE_ENTRIES = 6;

interface Timestamped {
  lastUsedAt: number;
}

async function readEntries(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    const entries = parsed?.version === 1 ? parsed.entries : undefined;
    return entries && typeof entries === "object" && !Array.isArray(entries)
      ? (entries as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Every stored entry by key, unvalidated. Empty when there is no usable
 *  file. Never throws. */
export async function readSdkSessionEntries(
  path: string,
): Promise<Record<string, unknown>> {
  // Let this process's own queued writes land first.
  await writes.get(path)?.catch(() => {});
  return readEntries(path);
}

const writes = new Map<string, Promise<void>>();

/**
 * Store (or with `null`, remove) the entry for `key`. Writes to one file run
 * one at a time in call order. Resolves once the file carries the change;
 * never rejects.
 */
export function writeSdkSessionEntry(
  path: string,
  key: string,
  value: Timestamped | null,
): Promise<void> {
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const entries = await readEntries(path);
      if (value === null) {
        if (!(key in entries)) return;
        delete entries[key];
      } else {
        entries[key] = value;
      }
      const newest = Object.entries(entries)
        .sort(
          (a, b) =>
            Number((b[1] as Timestamped | null)?.lastUsedAt ?? 0) -
            Number((a[1] as Timestamped | null)?.lastUsedAt ?? 0),
        )
        .slice(0, MAX_SDK_SESSION_FILE_ENTRIES);
      await writeFileAtomicAsync(
        path,
        JSON.stringify({ version: 1, entries: Object.fromEntries(newest) }),
        0o600,
      );
    } catch (error) {
      console.warn(
        `[claude-sdk-session-file] could not update ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  writes.set(path, next);
  void next.then(() => {
    if (writes.get(path) === next) writes.delete(path);
  });
  return next;
}
