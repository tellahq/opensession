/**
 * Per-user unsent composer drafts: the text you typed into a session's
 * composer and haven't sent yet. Each user gets one JSON file
 * `~/.opensession-drafts/<user>.json` of shape
 * `{ drafts: { [sessionId]: { text, updatedAt } } }`, so a draft typed on the
 * phone is still there in the browser, and survives the app being killed.
 * Mirrors the flat-file pattern in reads.ts and pins.ts.
 *
 * Two deliberate differences from those stores:
 *
 * - Writes are PER SESSION (`upsertDraft`), never a whole-map replace. A
 *   client that PUT its whole map before hydrating would wipe drafts made on
 *   another device, which is the exact way the read marks were lost once.
 * - A write carries the client's `updatedAt` and an OLDER one is refused, so a
 *   phone that wakes up an hour later can't restore the text you have since
 *   rewritten in the browser. Deletions (empty text) always win: they mean the
 *   message was sent or cleared, which is never something to resurrect.
 *
 * Attachments are not stored. Staged images stay on the device that staged
 * them; only text travels.
 *
 * Privacy: unlike read marks, this is a person's unsent writing. The route
 * derives the user from the verified sign-in identity when web sign-in is
 * active and ignores a mismatched `user` param (see routes/prefs.ts). On a
 * signed-out local instance there is no identity to check, so anyone who can
 * reach the server can read them, the same footing as every other store here.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";

/** Resolved per call, not at load, so a test can repoint the state root. */
function draftsDir(): string {
  return stateDir("drafts");
}

/** Bound live writing and deletion tombstones independently. */
const LIVE_CAP = 200;
const TOMBSTONE_CAP = 2_000;
/** A composer, not a document store. Longer drafts stay device-local. */
export const MAX_DRAFT_LENGTH = 32_000;

export interface StoredDraft {
  text: string;
  /** ISO time of the keystroke this text came from (client clock). */
  updatedAt: string;
}

export type DraftMap = Record<string, StoredDraft>;

/** Map a free-form user name to a safe, collision-resistant filename. */
function sanitizeUser(user: string): string {
  const normalized = (user || "").trim() || "Anonymous";
  const cleaned = normalized
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 40);
  const hash = createHash("sha256")
    .update(normalized.toLocaleLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `${cleaned || "Anonymous"}-${hash}`;
}

function fileFor(user: string): string {
  return `${draftsDir()}/${sanitizeUser(user)}.json`;
}

function legacyFileFor(user: string): string {
  const cleaned = (user || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64);
  return `${draftsDir()}/${cleaned || "Anonymous"}.json`;
}

/** Read the persisted map, including empty-text deletion tombstones. */
function cleanStored(input: unknown): DraftMap {
  const out: DraftMap = {};
  if (!input || typeof input !== "object") return out;
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (!id || typeof id !== "string") continue;
    const entry = value as Partial<StoredDraft> | null;
    const text = typeof entry?.text === "string" ? entry.text : "";
    const updatedAt =
      typeof entry?.updatedAt === "string" ? entry.updatedAt : "";
    if (!updatedAt) continue;
    out[id] = { text: text.slice(0, MAX_DRAFT_LENGTH), updatedAt };
  }
  return out;
}

function visibleDrafts(drafts: DraftMap): DraftMap {
  const result: DraftMap = {};
  for (const [id, draft] of Object.entries(drafts)) {
    if (draft.text.trim()) result[id] = draft;
  }
  return result;
}

/** Drop the oldest entries once over cap. Mutates and returns `map`. */
function enforceCap(map: DraftMap): DraftMap {
  const trim = (ids: string[], cap: number) =>
    ids
      .map((id) => ({ id, at: Date.parse(map[id]!.updatedAt) || 0 }))
      .sort((a, b) => a.at - b.at)
      .slice(0, Math.max(0, ids.length - cap));
  const live = Object.keys(map).filter((id) => map[id]!.text.trim());
  const tombstones = Object.keys(map).filter((id) => !map[id]!.text.trim());
  for (const { id } of [
    ...trim(live, LIVE_CAP),
    ...trim(tombstones, TOMBSTONE_CAP),
  ]) {
    delete map[id];
  }
  return map;
}

/** A user's unsent drafts: session id → { text, updatedAt }. */
export function getDrafts(user: string): DraftMap {
  let stored = read(fileFor(user));
  if (!Object.keys(stored).length) stored = read(legacyFileFor(user));
  return visibleDrafts(stored);
}

function read(file: string): DraftMap {
  try {
    if (!existsSync(file)) return {};
    return cleanStored(JSON.parse(readFileSync(file, "utf8"))?.drafts);
  } catch {
    return {};
  }
}

function writeFile(file: string, drafts: DraftMap): DraftMap {
  try {
    if (!existsSync(draftsDir())) mkdirSync(draftsDir(), { recursive: true });
    writeJsonAtomic(file, { drafts });
  } catch {}
  return drafts;
}

function write(user: string, drafts: DraftMap): DraftMap {
  return writeFile(fileFor(user), drafts);
}

export interface UpsertResult {
  /** What the store holds for this session after the write (null = none). */
  draft: StoredDraft | null;
  /** False when the write was refused for being older than the stored copy.
   *  The caller's copy is then the stale one, and `draft` is what won. */
  applied: boolean;
}

/**
 * Store one session's draft. Empty (or whitespace-only) text deletes it, and a
 * delete always applies. A write whose `updatedAt` predates the stored one is
 * refused, so a client that wakes up with old text can't undo newer typing.
 */
export function upsertDraft(
  user: string,
  sessionId: string,
  text: string,
  updatedAt: string,
): UpsertResult {
  const target = fileFor(user);
  let drafts = read(target);
  if (!Object.keys(drafts).length) drafts = read(legacyFileFor(user));
  const current = drafts[sessionId] ?? null;

  const incoming = Date.parse(updatedAt);
  const stored = current ? Date.parse(current.updatedAt) : 0;
  if (!text.trim()) {
    if (
      current?.text &&
      Number.isFinite(incoming) &&
      Number.isFinite(stored) &&
      incoming < stored
    ) {
      return { draft: current, applied: false };
    }
    // Keep an empty-text tombstone so an earlier non-empty request that
    // arrives after this delete cannot resurrect the sent draft.
    drafts[sessionId] = { text: "", updatedAt };
    write(user, enforceCap(drafts));
    return { draft: null, applied: true };
  }

  // Only refuse when both stamps parsed and the incoming one is strictly
  // older. An unparseable stamp shouldn't freeze a session's draft forever.
  if (
    current &&
    Number.isFinite(incoming) &&
    Number.isFinite(stored) &&
    (incoming < stored || (!current.text && incoming <= stored))
  ) {
    return { draft: current.text ? current : null, applied: false };
  }

  const next: StoredDraft = { text, updatedAt };
  drafts[sessionId] = next;
  write(user, enforceCap(drafts));
  return { draft: next, applied: true };
}

/** Drop these sessions' drafts for every user, when a session is deleted. */
export function purgeDraftsForSessions(ids: string[]): void {
  if (!ids.length || !existsSync(draftsDir())) return;
  try {
    for (const name of readdirSync(draftsDir())) {
      if (!name.endsWith(".json")) continue;
      const file = `${draftsDir()}/${name}`;
      const drafts = read(file);
      let changed = false;
      for (const id of ids) {
        if (drafts[id]) {
          delete drafts[id];
          changed = true;
        }
      }
      if (changed) writeFile(file, drafts);
    }
  } catch {}
}

/** Test seam for proving two colliding display names stay isolated. */
export function __draftFileForTest(user: string): string {
  return fileFor(user);
}
