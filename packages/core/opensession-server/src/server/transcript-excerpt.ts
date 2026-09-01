/**
 * transcript-excerpt — expand a search hit back into the REAL transcript.
 *
 * The session index (session-index.ts) holds a distilled view of a past
 * session: one question/summary/resolution record, LLM-written. That view is
 * disposable — it can be re-derived, and it is lossy by construction. The
 * transcript is the truth. Until now `search_history` could only hand back the
 * distilled record plus a session id, and the only way to "read more" was
 * get_session's transcript TAIL — the end of the session, which is almost never
 * where the thing you searched for happened.
 *
 * This module closes that gap: given a session and the terms that matched, find
 * WHERE in the transcript they occur and return windows of real entries around
 * those positions, seq-anchored so the caller can page outward.
 *
 * Reads prefer the transcript store (transcript-store.ts): its rows are bounded
 * (32KB) and cheap to scan, and only the entries we actually return get
 * hydrated back to full content via getFullEntry. Sessions the store never
 * imported (plain-*, pre-v2 leftovers) fall back to the merged legacy read.
 */

import { isContextInjection } from "@tellahq/opensession-protocol/notices";
import type { TranscriptEntry } from "./types";
import { transcript } from "./actor-transcript";
import { TRANSCRIPT_ACTOR_MAX_READ_LIMIT } from "./session-kernel/transcript-protocol";

/** A transcript entry with the display order it holds in its session. */
export type ExcerptEntry = TranscriptEntry & { seq: number };

export interface ExcerptWindow {
  firstSeq: number;
  lastSeq: number;
  /** Seq of the entry that matched, when this window came from a query. */
  matchSeq?: number;
  /** How many distinct query terms that entry carried. */
  score?: number;
  entries: ExcerptEntry[];
}

export interface TranscriptExcerpt {
  sessionId: string;
  /** Entries scanned (capped — see MAX_SCAN). */
  total: number;
  /** Highest seq in the session, so a caller knows where it is. */
  lastSeq: number;
  /** How many entries matched the query overall (not just those returned). */
  matched: number;
  windows: ExcerptWindow[];
  source: "store" | "legacy" | "none";
  /** Set when the scan hit MAX_SCAN and older entries were not searched. */
  truncated?: boolean;
}

/** The slice of TranscriptStore this module needs (injectable for tests). */
export interface ExcerptStore {
  getLastSeq(sessionId: string): number | Promise<number>;
  readSince(
    sessionId: string,
    sinceSeq: number,
    limit?: number,
  ):
    | { entries: (TranscriptEntry & { seq?: number })[] }
    | Promise<{ entries: (TranscriptEntry & { seq?: number })[] }>;
  getFullEntry(
    sessionId: string,
    uuid: string,
  ): TranscriptEntry | null | Promise<TranscriptEntry | null>;
}

export interface ExcerptDeps {
  store?: ExcerptStore | null;
  /** Legacy fallback for sessions the store never imported. */
  legacy?: (sessionId: string) => Promise<TranscriptEntry[]>;
}

export interface ExcerptOpts {
  /** Terms to locate inside the transcript. Omit to get the tail. */
  query?: string;
  /** Page instead of search: centre a single window on this seq. */
  aroundSeq?: number;
  /** Entries per window (default 12, max 60). */
  limit?: number;
  /** How many distinct match windows to return (default 3, max 8). */
  windows?: number;
}

/** Newest N entries we will scan for matches. Long sessions run to thousands
 *  of entries; scanning bounded store rows is cheap but not free, and the
 *  interesting region of a searched session is nearly always in the recent
 *  part of it. */
const MAX_SCAN = 4000;
const PAGE = TRANSCRIPT_ACTOR_MAX_READ_LIMIT;

export function excerptTerms(query: string): string[] {
  return (query || "")
    .toLowerCase()
    .split(/[^a-z0-9_./:@-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .slice(0, 12);
}

/** Everything about an entry a query could reasonably match against: its text,
 *  the tool that produced it, and the tool's input (a bash command, an edited
 *  path). Clipped — a 30KB result blob adds noise, not signal. */
function searchable(e: TranscriptEntry): string {
  const bits = [e.content || "", e.toolName || ""];
  if (e.toolInput) {
    try {
      bits.push(JSON.stringify(e.toolInput).slice(0, 2000));
    } catch {}
  }
  return bits.join("\n").toLowerCase();
}

function scoreEntry(e: TranscriptEntry, terms: string[]): number {
  if (!terms.length) return 0;
  const hay = searchable(e);
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  if (!hits) return 0;
  // All terms in one entry beats the same terms scattered across several.
  return hits === terms.length ? hits + 1 : hits;
}

/** Best non-overlapping match positions, strongest first. Two hits inside one
 *  window would render the same lines twice, so a taken match suppresses its
 *  neighbours. */
function pickMatches(
  scored: { seq: number; score: number; idx: number }[],
  want: number,
  spread: number,
): { seq: number; score: number; idx: number }[] {
  const picked: { seq: number; score: number; idx: number }[] = [];
  for (const cand of scored) {
    if (picked.length >= want) break;
    if (picked.some((p) => Math.abs(p.idx - cand.idx) < spread)) continue;
    picked.push(cand);
  }
  return picked;
}

/** Live wiring. The store singleton is lazy (importing transcript-store never
 *  opens the DB); session-cache/sessions are pulled in only when a session
 *  actually needs the legacy path, keeping this module cheap to import. */
function defaultDeps(): ExcerptDeps {
  return {
    store: transcript as ExcerptStore,
    legacy: async (sessionId: string) => {
      try {
        const [{ findSession }, { mergedSessionTranscriptAsync }] =
          await Promise.all([import("./session-cache"), import("./sessions")]);
        const session = findSession(sessionId);
        if (!session) return [];
        return await mergedSessionTranscriptAsync(session);
      } catch {
        return [];
      }
    },
  };
}

/** Load the newest MAX_SCAN entries, store-first. Store rows are bounded, so
 *  matching happens on possibly-clipped text; the windows we return are
 *  hydrated back to full content afterwards. */
async function loadEntries(
  sessionId: string,
  deps: ExcerptDeps,
): Promise<{
  entries: ExcerptEntry[];
  source: "store" | "legacy" | "none";
  lastSeq: number;
  truncated: boolean;
}> {
  const store = deps.store;
  if (store) {
    try {
      const lastSeq = await store.getLastSeq(sessionId);
      if (lastSeq > 0) {
        const from = Math.max(0, lastSeq - MAX_SCAN);
        const out: ExcerptEntry[] = [];
        let cursor = from;
        while (cursor < lastSeq) {
          const page = await store.readSince(sessionId, cursor, PAGE);
          if (!page.entries.length) break;
          for (const e of page.entries) {
            const seq = e.seq ?? out.length + from + 1;
            // The harness's own injection records (context-log.ts) are
            // not conversation: an excerpt exists to show what was said,
            // and a recap built over one must not summarize plumbing.
            if (!isContextInjection(e)) out.push({ ...e, seq });
            cursor = Math.max(cursor, seq);
          }
          if (page.entries.length < PAGE) break;
        }
        if (out.length)
          return {
            entries: out,
            source: "store",
            lastSeq,
            truncated: from > 0,
          };
      }
    } catch {
      // An authoritative actor read failure is not evidence that the session
      // is legacy. Falling through would hydrate its entire transcript through
      // mergedSessionTranscriptAsync and defeat this scan's hard row budget.
      return { entries: [], source: "none", lastSeq: 0, truncated: true };
    }
  }
  const legacy = deps.legacy ? await deps.legacy(sessionId) : [];
  if (!legacy.length)
    return { entries: [], source: "none", lastSeq: 0, truncated: false };
  // Legacy entries carry no owned display order; index position is the only
  // stable handle, and it is what aroundSeq will page against.
  const start = Math.max(0, legacy.length - MAX_SCAN);
  const entries = legacy
    .slice(start)
    .map((e, i) => ({ ...e, seq: e.seq ?? start + i + 1 }) as ExcerptEntry)
    .filter((e) => !isContextInjection(e));
  return {
    entries,
    source: "legacy",
    lastSeq: entries[entries.length - 1]?.seq ?? 0,
    truncated: start > 0,
  };
}

async function hydrate(
  sessionId: string,
  entries: ExcerptEntry[],
  deps: ExcerptDeps,
): Promise<ExcerptEntry[]> {
  const store = deps.store;
  if (!store) return entries;
  return Promise.all(
    entries.map(async (e) => {
      try {
        const full = await store.getFullEntry(sessionId, e.id);
        return full ? ({ ...full, seq: e.seq } as ExcerptEntry) : e;
      } catch {
        return e;
      }
    }),
  );
}

/**
 * Windows of real transcript entries for a session: around the query's best
 * matches, around an explicit seq (paging), or the tail when neither is given.
 */
export async function transcriptExcerpt(
  sessionId: string,
  opts: ExcerptOpts = {},
  deps: ExcerptDeps = defaultDeps(),
): Promise<TranscriptExcerpt> {
  const limit = Math.min(Math.max(opts.limit ?? 12, 2), 60);
  const wantWindows = Math.min(Math.max(opts.windows ?? 3, 1), 8);
  const loaded = await loadEntries(sessionId, deps);
  const base: TranscriptExcerpt = {
    sessionId,
    total: loaded.entries.length,
    lastSeq: loaded.lastSeq,
    matched: 0,
    windows: [],
    source: loaded.source,
    ...(loaded.truncated ? { truncated: true } : {}),
  };
  if (!loaded.entries.length) return base;

  const cut = async (
    from: number,
    to: number,
    extra: Partial<ExcerptWindow> = {},
  ): Promise<ExcerptWindow> => {
    const slice = loaded.entries.slice(Math.max(0, from), to);
    const hydrated = await hydrate(sessionId, slice, deps);
    return {
      firstSeq: hydrated[0]?.seq ?? 0,
      lastSeq: hydrated[hydrated.length - 1]?.seq ?? 0,
      entries: hydrated,
      ...extra,
    };
  };

  // Paging: a window centred on a seq the caller already saw.
  if (typeof opts.aroundSeq === "number") {
    let idx = loaded.entries.findIndex((e) => e.seq >= opts.aroundSeq!);
    if (idx < 0) idx = loaded.entries.length - 1;
    const half = Math.floor(limit / 2);
    base.windows = [
      await cut(idx - half, idx - half + limit, {
        matchSeq: loaded.entries[idx]?.seq,
      }),
    ];
    return base;
  }

  const terms = excerptTerms(opts.query || "");
  if (!terms.length) {
    base.windows = [
      await cut(loaded.entries.length - limit, loaded.entries.length),
    ];
    return base;
  }

  const scored = loaded.entries
    .map((e, idx) => ({ seq: e.seq, idx, score: scoreEntry(e, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.idx - a.idx);
  base.matched = scored.length;
  if (!scored.length) {
    // Honest miss: the record matched but the words aren't in the transcript
    // (the distilled record is the LLM's paraphrase). Show the tail so the
    // call still returns something real rather than nothing.
    base.windows = [
      await cut(loaded.entries.length - limit, loaded.entries.length),
    ];
    return base;
  }

  const picked = pickMatches(scored, wantWindows, limit).sort(
    (a, b) => a.idx - b.idx,
  );
  const lead = Math.max(1, Math.floor(limit / 3));
  base.windows = await Promise.all(
    picked.map((p) =>
      cut(p.idx - lead, p.idx - lead + limit, {
        matchSeq: p.seq,
        score: p.score,
      }),
    ),
  );
  return base;
}

function roleLabel(e: TranscriptEntry): string {
  switch (e.type) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool_use":
      return `tool:${e.toolName || "?"}`;
    case "tool_result":
      return e.isError ? "tool_result ✗" : "tool_result";
    default:
      return e.type;
  }
}

/** One-line-per-entry rendering of a tool call's input: the bash command, the
 *  edited path — the part that says what actually happened. */
function toolInputLine(e: TranscriptEntry): string {
  const input = e.toolInput as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return "";
  for (const key of [
    "command",
    "filePath",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
  ]) {
    const v = input[key];
    if (typeof v === "string" && v.trim())
      return ` ${key}=${v.replace(/\s+/g, " ").slice(0, 300)}`;
  }
  return "";
}

/**
 * Render an excerpt for a model: seq-tagged entries so it can page with
 * around_seq, tool inputs kept (they carry the commands), content clipped per
 * entry and per call.
 */
export function formatExcerpt(
  ex: TranscriptExcerpt,
  opts: { perEntry?: number; budget?: number } = {},
): string {
  const perEntry = opts.perEntry ?? 900;
  const budget = opts.budget ?? 14_000;
  if (!ex.windows.length || !ex.windows.some((w) => w.entries.length))
    return `No transcript entries available for \`${ex.sessionId}\` (nothing imported for this session).`;

  const out: string[] = [];
  let used = 0;
  let stopped = false;
  for (const w of ex.windows) {
    if (stopped) break;
    const head =
      w.matchSeq !== undefined
        ? `— seq ${w.firstSeq}–${w.lastSeq} (match at ${w.matchSeq}) —`
        : `— seq ${w.firstSeq}–${w.lastSeq} —`;
    out.push(head);
    used += head.length;
    for (const e of w.entries) {
      const body = (e.content || "")
        .replace(/[ \t]+/g, " ")
        .trim()
        .slice(0, perEntry);
      const line = `[${e.seq}] ${roleLabel(e)}:${toolInputLine(e)}${body ? ` ${body}` : ""}`;
      if (used + line.length > budget) {
        out.push(
          "… (excerpt budget reached — narrow the query or lower `limit`)",
        );
        stopped = true;
        break;
      }
      out.push(line);
      used += line.length + 1;
    }
    out.push("");
  }
  const foot: string[] = [];
  if (ex.matched)
    foot.push(
      `${ex.matched} matching entr${ex.matched === 1 ? "y" : "ies"} in this session.`,
    );
  if (ex.lastSeq) foot.push(`session runs to seq ${ex.lastSeq}.`);
  if (ex.truncated)
    foot.push("older entries beyond the scan window were not searched.");
  foot.push("Page with `around_seq` to read before/after any seq shown.");
  out.push(foot.join(" "));
  return out.join("\n").trim();
}
