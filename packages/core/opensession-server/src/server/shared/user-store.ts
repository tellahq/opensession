/**
 * One per-user flat-file store, spelled once. Pins, read marks, lanes,
 * snoozes, hides, settlements, tab colors, UI prefs and personal run preferences are the same
 * thing: one JSON file per person under `~/.opensession-<name>/`, holding a
 * single field. They used to be seven copies of that code, and the copies
 * disagreed about the two things that matter, so one person's pins and drafts
 * could land in differently-named files.
 *
 * The rules this owns, so no store can answer them differently:
 *
 * - THE FILENAME: `<sanitized>-<sha256 of the lowercased identity>.json`, the
 *   spelling drafts.ts already uses. Two display names that differ only in
 *   characters a filename can't hold ("a/b" and "a_b") can no longer share
 *   one file, and case variants of a name are one person, as in drafts.
 * - THE DIRECTORY, resolved per call and never pinned at module load: a test
 *   or a dev instance that repoints OPENSESSION_STATE_DIR must not keep
 *   reading and writing the live operator's state.
 * - READING THE LOSING SPELLINGS. Every one of these stores holds live state
 *   written under an older filename, so a read that finds no canonical file
 *   falls back to the legacy names before giving up: the plain sanitized slug
 *   (pins, reads, lanes, snoozes, hides, settlements, tab colors, UI prefs) and the
 *   identity verbatim (personal run preferences' `user-<slackId>`). The first write
 *   after this lands on the canonical name and wins from then on; the legacy
 *   file is left in place rather than deleted, so nothing is lost if the
 *   change is rolled back.
 *
 * WHO the identity is stays per store, because that is a real difference and
 * not an accident: most key on the self-selected display name, while personal
 * run preferences resolve the teammate first so they follow across surfaces.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./atomic-write";
import { stateDir } from "../paths";

/** Identity → the filename stem every store writes (mirrors drafts.ts). */
function canonicalName(identity: string): string {
  const normalized = identity.trim() || "Anonymous";
  const cleaned = normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const hash = createHash("sha256")
    .update(normalized.toLocaleLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `${cleaned || "Anonymous"}-${hash}`;
}

/** A name safe to read back verbatim: no separators, no traversal. */
const SAFE_VERBATIM = /^[A-Za-z0-9@._-]+$/;

/** Filename stems these stores wrote before canonicalName; read-only. */
function legacyNames(identity: string): string[] {
  const normalized = identity.trim() || "Anonymous";
  const slug =
    normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "Anonymous";
  const names = [slug];
  if (
    normalized !== slug &&
    SAFE_VERBATIM.test(normalized) &&
    !normalized.includes("..")
  ) {
    names.push(normalized);
  }
  return names;
}

export interface UserStore<T> {
  /** The store's directory, resolved per call. */
  dir(): string;
  /** This user's state, or the empty value when they have none. */
  get(user: string): T;
  /** Replace this user's state. Returns what was stored. */
  set(user: string, value: unknown): T;
}

/**
 * Every store whose filename keys on the SELF-SELECTED display name, so a
 * rename can carry them (renameUserState below). `drafts` is in the list even
 * though drafts.ts predates this module: it writes the same filename scheme,
 * which is where the scheme came from.
 *
 * Personal prompts and output styles are deliberately absent. They key on the
 * resolved teammate, so they already follow a person through a rename and
 * copying one would write a second file under a key nothing reads.
 *
 * A store missing from this list is not an error the type system can catch, so
 * user-store.test.ts asserts the list against the repo's own `userStore(`
 * call sites.
 */
export const NAME_KEYED_STORES = [
  "drafts",
  "hides",
  "lanes",
  "pins",
  "reads",
  "settlements",
  "snoozes",
  "tab-colors",
  "ui-prefs",
] as const;

/**
 * Move one person's per-user state from one display name to another.
 *
 * The display name is the filename, so a rename would otherwise orphan someone
 * quietly: their pins, read marks, lanes, snoozes, hides, tab colors, drafts
 * settlements and UI prefs would all still be on disk under a name nothing
 * looks up, and
 * the app would show them a factory-fresh sidebar. Nothing errors, which is
 * what makes it worth handling here rather than leaving to the caller.
 *
 * Copies rather than moves, and never overwrites: the old file stays as a
 * rollback, and a destination that already has state (renaming onto a name you
 * used before) keeps what is already there. Returns the stores it carried.
 */
export function renameUserState(from: string, to: string): string[] {
  const a = from.trim();
  const b = to.trim();
  // Only a rename that lands on the same FILE is a no-op. Case is not that
  // rename: canonicalName hashes the lowercased identity but keeps the
  // original case in the stem, so "Kent" and "kent" are two files that agree
  // about the person. Fixing your own capitalization has to carry state too.
  if (!a || !b || canonicalName(a) === canonicalName(b)) return [];
  const carried: string[] = [];
  for (const name of NAME_KEYED_STORES) {
    const root = stateDir(name);
    const target = `${root}/${canonicalName(b)}.json`;
    if (existsSync(target)) continue;
    const source = [canonicalName(a), ...legacyNames(a)]
      .map((stem) => `${root}/${stem}.json`)
      .find((file) => existsSync(file));
    if (!source) continue;
    try {
      const raw = JSON.parse(readFileSync(source, "utf8"));
      mkdirSync(root, { recursive: true });
      writeJsonAtomic(target, raw);
      carried.push(name);
    } catch {}
  }
  return carried;
}

export function userStore<T>(options: {
  /** State-dir base: "pins" → `~/.opensession-pins`. */
  name: string;
  /** The single top-level field in the file: `{ [field]: value }`. */
  field: string;
  /**
   * Validate and normalize both what is read and what is written. Called
   * with `undefined` for a missing file, so it also defines the empty value.
   */
  clean: (raw: unknown) => T;
  /**
   * Which person this is. `null` means "no one": reads answer empty and
   * writes are dropped. Defaults to the trimmed user name.
   */
  identity?: (user: string) => string | null;
  /** Extra top-level fields stamped on every write. */
  extra?: () => Record<string, unknown>;
}): UserStore<T> {
  const { name, field, clean, extra } = options;
  const identity = options.identity ?? ((user: string) => user ?? "");
  const dir = () => stateDir(name);

  return {
    dir,
    get(user) {
      const id = identity(user);
      if (id === null) return clean(undefined);
      const root = dir();
      // The first file that EXISTS answers, even when it holds an empty
      // value: a user who cleared their pins must not have the legacy
      // copy resurrect them.
      for (const stem of [canonicalName(id), ...legacyNames(id)]) {
        const file = `${root}/${stem}.json`;
        if (!existsSync(file)) continue;
        try {
          return clean(JSON.parse(readFileSync(file, "utf8"))?.[field]);
        } catch {
          return clean(undefined);
        }
      }
      return clean(undefined);
    },
    set(user, value) {
      const id = identity(user);
      if (id === null) return clean(undefined);
      const cleaned = clean(value);
      const root = dir();
      try {
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
        writeJsonAtomic(`${root}/${canonicalName(id)}.json`, {
          [field]: cleaned,
          ...extra?.(),
        });
      } catch {}
      return cleaned;
    },
  };
}
