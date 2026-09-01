/**
 * Which session shipped a commit.
 *
 * A repo that ships without pull requests (Open Session's own, self-hosting
 * from one shared checkout) has no PR for a feed row to hang a session off, so
 * clicking what the team shipped could only ever leave for GitHub. The
 * interesting half of a commit here is the session that wrote it.
 *
 * Git records no session, so this reads the one place the link exists: the
 * transcript. The session that made a commit is the first to say its sha, in
 * the same second it lands, because `git commit` prints it back as a tool
 * result ("[main ad85e5d5] Ask card: ..."). Every other session in the shared
 * checkout says that sha too, the moment it next runs `git log` — which is
 * why first, and not any, is the rule.
 *
 * Each session's transcript is read once, from a stored per-session cursor, so
 * a sweep costs only what has been written since the last one, and the links
 * are kept on disk so a restart does not re-read the store.
 *
 * Reading a transcript once is what makes the sweep cheap, and it is also the
 * thing that can lose a link for good: a row read before anyone asked about
 * the commit it names is never read again. Two things had been walking past
 * rows that way, and both are guarded below: the escapes in the stored text,
 * and how far the cursor is allowed to move.
 */

import { existsSync, readFileSync } from "fs";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { transcript } from "./actor-transcript";

export interface CommitRef {
  sha: string;
  /** ISO committer date. */
  committedAt: string;
}

/** A mention this far from the commit is someone reading history, not the
 *  session that wrote it. Wide enough to survive a slow tool call, far short
 *  of the next session's `git log`. */
const MENTION_WINDOW_MS = 15 * 60_000;
/** A session idle longer than this cannot have written a commit we are still
 *  looking for, so its transcript is not read again. */
const ACTIVE_DAYS = 3;
/** How long a link, and a session's read cursor, are kept. */
const KEEP_DAYS = 60;
/** Sessions read between yields. The sweep can walk hundreds of megabytes on
 *  its first run, and it must not hold the loop while it does. */
const YIELD_EVERY = 20;
const TRANSCRIPT_PAGE_SIZE = 200;

/** Hex runs that could be a sha. Bounded by word edges, so the hex inside a
 *  longer token is not one; 7 is git's shortest abbreviation here. */
const HEX_RUN = /\b[0-9a-f]{7,40}\b/g;

/** A transcript row is stored as JSON text, so a newline in what `git commit`
 *  printed arrives as the two characters `\` and `n`. That `n` is a word
 *  character, and it closes the word edge the scan opens on, so a sha at the
 *  start of a line was invisible while the same sha mid-line was not: which
 *  one you got fell to where git happened to wrap. Turning each escape back
 *  into a space restores the edge, and a space can only split a run, never
 *  join two. */
const JSON_ESCAPE = /\\./g;

interface StoredIndex {
  /** Bumped when the scan changes, so a stale index is re-read rather than
   *  believed: a row the old rule walked past is not read again otherwise. */
  v: 2;
  /** Full sha → the session that first said it. */
  links: Record<string, { session: string; ts: number; at: number }>;
  /** Session id → the last transcript seq read. */
  cursors: Record<string, { seq: number; at: number }>;
}

function emptyIndex(): StoredIndex {
  return { v: 2, links: {}, cursors: {} };
}

function indexFile(): string {
  return stateDir("commit-sessions.json");
}

/** The index lives in memory once read: this process is its only writer, so
 *  the file is a restart's copy of it rather than the authority. */
let cached: StoredIndex | null = null;

function load(): StoredIndex {
  if (cached) return cached;
  try {
    const file = indexFile();
    if (!existsSync(file)) return (cached = emptyIndex());
    const data = JSON.parse(readFileSync(file, "utf8")) as StoredIndex;
    if (data?.v !== 2 || !data.links || !data.cursors)
      return (cached = emptyIndex());
    return (cached = data);
  } catch {
    return (cached = emptyIndex());
  }
}

function save(index: StoredIndex): void {
  const floor = Date.now() - KEEP_DAYS * 86_400_000;
  for (const [sha, link] of Object.entries(index.links))
    if (link.at < floor) delete index.links[sha];
  for (const [id, cursor] of Object.entries(index.cursors))
    if (cursor.at < floor) delete index.cursors[id];
  try {
    writeJsonAtomic(indexFile(), index, false);
  } catch {
    // An index that cannot be written is a slower feed, not a failure.
  }
}

/**
 * The first session to name each wanted sha.
 *
 * Pure, and exported for the test: the rule is the whole feature, and it is
 * worth reading on its own.
 */
export function firstMentions(
  rows: Iterable<{ session: string; ts: number; data: string }>,
  wanted: Map<string, { sha: string; at: number }>,
  windowMs: number = MENTION_WINDOW_MS,
): Map<string, { session: string; ts: number }> {
  const best = new Map<string, { session: string; ts: number }>();
  for (const row of rows) {
    const runs = row.data.replace(JSON_ESCAPE, " ").match(HEX_RUN);
    if (!runs) continue;
    for (const run of runs) {
      const commit = wanted.get(run.slice(0, 7));
      // A run that merely starts like a sha is not that sha: a uuid's own
      // segments are hex too, and a transcript is full of them.
      if (!commit || !commit.sha.startsWith(run)) continue;
      if (Math.abs(row.ts - commit.at) > windowMs) continue;
      const prev = best.get(commit.sha);
      if (!prev || row.ts < prev.ts)
        best.set(commit.sha, { session: row.session, ts: row.ts });
    }
  }
  return best;
}

/**
 * How far a session's mark may move: the last row the commit list could
 * already account for.
 *
 * Pure, and exported for the test, for the same reason `firstMentions` is.
 * Reading a row is cheap and repeatable; moving the mark past it is the one
 * irreversible thing a sweep does, so what bounds it is worth reading alone.
 * Returns -1 when every row is too new to be marked yet.
 */
export function readableThrough(
  rows: Array<{ seq: number; ts: number }>,
  commitsReadAt: number,
): number {
  let read = -1;
  for (const row of rows) {
    if (row.ts > commitsReadAt) break;
    read = row.seq;
  }
  return read;
}

export async function readCommitTranscriptRows(
  sessionId: string,
  cursor: number,
  readSince: typeof transcript.readSince = transcript.readSince,
): Promise<Array<{ seq: number; ts: number; data: string }>> {
  const rows: Array<{ seq: number; ts: number; data: string }> = [];
  let pageCursor = cursor;
  for (;;) {
    const page = await readSince(sessionId, pageCursor, TRANSCRIPT_PAGE_SIZE);
    for (const entry of page.entries) {
      rows.push({
        seq: entry.seq,
        ts: Date.parse(entry.timestamp || "") || 0,
        data: JSON.stringify(entry),
      });
    }
    if (page.entries.length < TRANSCRIPT_PAGE_SIZE) break;
    pageCursor = page.entries.at(-1)!.seq;
  }
  return rows;
}

let sweeping: Promise<void> | null = null;

/**
 * Read what each recently active session has written since the last sweep,
 * and record who first named each commit.
 */
async function sweep(
  index: StoredIndex,
  wanted: Map<string, { sha: string; at: number }>,
  /** When the commit list was read. A row written after that may name a commit
   *  this sweep was never told to look for, so the mark stops there and the row
   *  is offered again once the list has caught up. Without it, a commit made
   *  inside the commit cache's own minute of staleness was read past and lost.
   *  A row written before it can only name commits the list already holds. */
  commitsReadAt: number,
): Promise<void> {
  const since = Date.now() - ACTIVE_DAYS * 86_400_000;
  const sessions: string[] = [];
  let after = "";
  for (;;) {
    const ids = await transcript.sessionIds(200, after);
    for (const id of ids) {
      const summary = await transcript.summary(id);
      if ((summary?.lastTs ?? 0) >= since) sessions.push(id);
    }
    if (ids.length < 200) break;
    after = ids.at(-1)!;
  }

  let walked = 0;
  for (const session of sessions) {
    const cursor = index.cursors[session]?.seq ?? 0;
    const rows = await readCommitTranscriptRows(session, cursor);

    if (rows.length) {
      const found = firstMentions(
        rows.map((row) => ({ session, ts: row.ts, data: row.data })),
        wanted,
      );
      for (const [sha, hit] of found) {
        const prev = index.links[sha];
        if (!prev || hit.ts < prev.ts)
          index.links[sha] = {
            session: hit.session,
            ts: hit.ts,
            at: wanted.get(sha.slice(0, 7))?.at ?? hit.ts,
          };
      }
      // Rows are still read whole: a mention found beyond the mark counts,
      // and the next sweep finding it again is harmless, since the earliest
      // one wins. Only the mark is held back.
      const read = readableThrough(rows, commitsReadAt);
      if (read >= 0) index.cursors[session] = { seq: read, at: Date.now() };
    } else if (!index.cursors[session]) {
      index.cursors[session] = { seq: cursor, at: Date.now() };
    }
    if (++walked % YIELD_EVERY === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Sha → session id, for the commits given. Sweeps first, so a commit made a
 * moment ago links as soon as the feed asks about it.
 */
export async function commitSessions(
  commits: CommitRef[],
  commitsReadAt: number = Date.now(),
): Promise<Map<string, string>> {
  const wanted = new Map<string, { sha: string; at: number }>();
  for (const commit of commits) {
    const at = new Date(commit.committedAt).getTime();
    if (Number.isFinite(at))
      wanted.set(commit.sha.slice(0, 7), { sha: commit.sha, at });
  }
  const index = load();
  if (wanted.size) {
    // One sweep at a time: two feed loads at once would read the same rows
    // twice and race the cursors they write.
    sweeping ??= sweep(index, wanted, commitsReadAt)
      .catch(() => {})
      .finally(() => {
        save(index);
        sweeping = null;
      });
    await sweeping;
  }
  const out = new Map<string, string>();
  for (const commit of commits) {
    const link = index.links[commit.sha];
    if (link) out.set(commit.sha, link.session);
  }
  return out;
}
