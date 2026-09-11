/**
 * Spoken references in the Desk voice transcript.
 *
 * A voice call mirrors what was said into the Desk session as plain text, and
 * speech has no `#`: a PR comes out as "six four seven four", and a session
 * the Desk just started is only ever named by title (the voice prompt forbids
 * reading ids aloud, on purpose). The web renderer links `repo#6474` and a
 * bare `bks-<uuidv7>` (frontend/lib/markdown.ts), so the transcript row has
 * to carry those spellings for a chip to appear.
 *
 * The references themselves are not guessed from the speech: every tool call
 * a call runs feeds a per-call ledger (PRs by repo and number, sessions by id
 * and title), and an assistant row is rewritten only where a spoken number
 * matches exactly one PR the call actually saw. Nothing else is touched, so
 * a number that matches nothing, or matches PRs in two repos, stays as it
 * was said.
 *
 * Pure module: no I/O, no timers, no imports with live effects.
 */

import { UUIDV7 } from "../frontend/lib/session-url";

export interface PrRef {
  repo: string;
  number: number;
}

export interface SessionRef {
  id: string;
  title?: string;
}

export interface KnownRepo {
  id: string;
  /** GitHub `owner/name`, when the repo lives there. */
  ghRepo?: string;
}

/** Most references a ledger keeps; the oldest go first. A call rarely sees
 * more than a few dozen, so this only guards against a runaway tool. */
export const LEDGER_MAX_REFS = 200;
/** Only a title this long is distinctive enough to match against a row. */
export const SESSION_TITLE_MIN_LENGTH = 8;
const PR_NUMBER_MAX_DIGITS = 5;

const SESSION_ID = new RegExp(`\\b(?:os|bks)-${UUIDV7}\\b`, "gi");
/** `#123`, `PR 123`, `PR #123`, `PRs 123`. */
const PR_NUMBER_ON_LINE = new RegExp(
  `(?:#|\\b[Pp][Rr]s?\\s*#?)(\\d{1,${PR_NUMBER_MAX_DIGITS}})(?!\\w)`,
  "g",
);
const GITHUB_PULL_URL =
  /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,5})(?!\d)/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prKey(ref: PrRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** Keeps a Map at `max` entries by dropping its oldest insertions. */
function trim<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

/** Every string reachable inside a tool result, in document order. */
function* strings(value: unknown, depth = 0): Generator<string> {
  if (depth > 12) return;
  if (typeof value === "string") yield value;
  else if (Array.isArray(value))
    for (const item of value) yield* strings(item, depth + 1);
  else if (value && typeof value === "object")
    for (const item of Object.values(value as Record<string, unknown>))
      yield* strings(item, depth + 1);
}

/** Every object inside a tool result whose `id` is a session id, with its
 * sibling `title` when it has one: list_current_work, inspect_session, the
 * sessions MCP tools and start_session all shape their rows that way. */
function* sessionObjects(
  value: unknown,
  depth = 0,
): Generator<{ id: string; title?: string }> {
  if (depth > 12 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* sessionObjects(item, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && isSessionId(record.id))
    yield {
      id: record.id,
      ...(typeof record.title === "string" && record.title.trim()
        ? { title: record.title.trim() }
        : {}),
    };
  for (const item of Object.values(record))
    yield* sessionObjects(item, depth + 1);
}

function isSessionId(s: string): boolean {
  SESSION_ID.lastIndex = 0;
  const m = SESSION_ID.exec(s);
  return !!m && m[0].length === s.length;
}

/** The known repos a line of text names, by id or by GitHub `owner/name`,
 * as whole words (`opensession` inside `opensession-server` does not count). */
function reposNamedOn(line: string, repos: KnownRepo[]): KnownRepo[] {
  const named: KnownRepo[] = [];
  for (const repo of repos) {
    const names = [repo.id, repo.ghRepo].filter((n): n is string => !!n);
    const hit = names.some((name) =>
      new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, "i").test(line),
    );
    if (hit) named.push(repo);
  }
  return named;
}

export class VoiceReferenceLedger {
  private prs = new Map<string, PrRef>();
  private sessions = new Map<string, SessionRef>();
  /** Sessions this call started or steered, awaiting their trailer. */
  private pending = new Set<string>();

  /** Records every reference a tool call surfaced, success or error. */
  collect(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    repos: KnownRepo[],
  ): void {
    if (name === "start_session" || name === "steer_session") {
      const id =
        name === "start_session"
          ? (result as { id?: unknown } | null)?.id
          : args.session_id;
      const ok =
        !!result &&
        typeof result === "object" &&
        typeof (result as { error?: unknown }).error !== "string" &&
        (result as { status?: unknown }).status !== "error";
      if (typeof id === "string" && isSessionId(id) && ok) {
        this.addSession({ id });
        this.pending.add(id);
      }
    }
    for (const session of sessionObjects(result)) this.addSession(session);
    for (const record of prRefsFromSessionRows(result)) this.addPr(record);
    for (const text of strings(result)) {
      for (const line of text.split("\n")) {
        for (const m of line.matchAll(GITHUB_PULL_URL)) {
          const gh = `${m[1]}/${m[2]}`.toLowerCase();
          const repo = repos.find((r) => r.ghRepo?.toLowerCase() === gh);
          if (repo) this.addPr({ repo: repo.id, number: Number(m[3]) });
        }
        const named = reposNamedOn(line, repos);
        if (named.length === 1)
          for (const m of line.matchAll(PR_NUMBER_ON_LINE))
            this.addPr({ repo: named[0].id, number: Number(m[1]) });
        for (const m of line.matchAll(SESSION_ID))
          this.addSession({ id: m[0] });
      }
    }
  }

  /** The PR refs a spoken number could mean; one is a link, more is not. */
  prRefsFor(number: number): PrRef[] {
    return [...this.prs.values()].filter((ref) => ref.number === number);
  }

  /** Sessions with a title worth matching against a row. */
  titledSessions(): Array<SessionRef & { title: string }> {
    return [...this.sessions.values()].filter(
      (ref): ref is SessionRef & { title: string } =>
        !!ref.title && ref.title.length >= SESSION_TITLE_MIN_LENGTH,
    );
  }

  /** Sessions started or steered since the last take. Consumed once. */
  takePending(): string[] {
    const ids = [...this.pending];
    this.pending.clear();
    return ids;
  }

  private addPr(ref: PrRef): void {
    if (!Number.isInteger(ref.number) || ref.number <= 0) return;
    const key = prKey(ref);
    this.prs.delete(key);
    this.prs.set(key, ref);
    trim(this.prs, LEDGER_MAX_REFS);
  }

  private addSession(ref: SessionRef): void {
    const id = ref.id.toLowerCase();
    const existing = this.sessions.get(id);
    this.sessions.delete(id);
    this.sessions.set(id, {
      id,
      ...(ref.title || existing?.title
        ? { title: ref.title || existing?.title }
        : {}),
    });
    trim(this.sessions, LEDGER_MAX_REFS);
  }
}

/** `{repo, prNumber}` rows, as list_current_work / inspect_session return. */
function* prRefsFromSessionRows(value: unknown, depth = 0): Generator<PrRef> {
  if (depth > 12 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* prRefsFromSessionRows(item, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.repo === "string" && typeof record.prNumber === "number")
    yield { repo: record.repo, number: record.prNumber };
  for (const item of Object.values(record))
    yield* prRefsFromSessionRows(item, depth + 1);
}

// ---------------------------------------------------------------------------
// Spoken numbers. The voice transcript spells a PR number as words in one of
// a few shapes: digit by digit ("six four seven four", "six, four, seven,
// four"), in pairs ("sixty-four seventy-four"), or in full ("six thousand
// four hundred seventy-four"); typed text and some transcripts carry digits.
// A run of number words is cut into chunks wherever a word cannot continue
// the number before it, and the chunks' digits are concatenated, so all four
// spellings above come out as 6474.

const UNITS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

type NumberToken =
  | { kind: "unit" | "teen" | "tens" | "hundred" | "thousand"; value: number }
  | { kind: "digits"; value: number; text: string };

function numberToken(word: string): NumberToken | null {
  const w = word.toLowerCase();
  if (w in UNITS) return { kind: "unit", value: UNITS[w] };
  if (w in TEENS) return { kind: "teen", value: TEENS[w] };
  if (w in TENS) return { kind: "tens", value: TENS[w] };
  if (w === "hundred") return { kind: "hundred", value: 100 };
  if (w === "thousand") return { kind: "thousand", value: 1000 };
  return null;
}

/** The digit string a run of number tokens spells, or null when the run is
 * not a well-formed number (e.g. "hundred thousand hundred"). */
export function spokenDigits(tokens: NumberToken[]): string | null {
  const chunks: string[] = [];
  let total = 0;
  let part = 0;
  let last: NumberToken["kind"] | null = null;
  const close = () => {
    if (last !== null) chunks.push(String(total + part));
    total = 0;
    part = 0;
    last = null;
  };
  const afterScale = () => last === "hundred" || last === "thousand";
  for (const token of tokens) {
    switch (token.kind) {
      case "digits":
        close();
        chunks.push(token.text);
        break;
      case "unit":
        if (last === "tens" && token.value !== 0) part += token.value;
        else if (afterScale() && token.value !== 0) part += token.value;
        else {
          close();
          part = token.value;
        }
        last = "unit";
        break;
      case "teen":
        if (afterScale()) part += token.value;
        else {
          close();
          part = token.value;
        }
        last = "teen";
        break;
      case "tens":
        if (afterScale()) part += token.value;
        else {
          close();
          part = token.value;
        }
        last = "tens";
        break;
      case "hundred":
        if (last === null || afterScale() || part <= 0 || part >= 100)
          return null;
        part *= 100;
        last = "hundred";
        break;
      case "thousand":
        if (last === null || last === "thousand" || part <= 0) return null;
        total += part * 1000;
        part = 0;
        last = "thousand";
        break;
    }
  }
  close();
  return chunks.join("");
}

interface SpokenNumber {
  start: number;
  end: number;
  value: number;
}

const WORD_OR_DIGITS = /[A-Za-z]+|\d+/g;

/**
 * Every spoken or typed number in `text` that could be a PR number, with the
 * span of text it occupies. Number words separated by spaces, hyphens or
 * commas form one run; the run is cut at commas, unless every comma-separated
 * piece is a lone digit word ("six, four, seven, four"), which is one number.
 */
export function spokenNumbers(text: string): SpokenNumber[] {
  interface Piece {
    start: number;
    end: number;
    tokens: NumberToken[];
  }
  const runs: Piece[][] = [];
  let run: Piece[] = [];
  let piece: Piece | null = null;
  let lastEnd = -1;
  const closePiece = () => {
    if (piece) run.push(piece);
    piece = null;
  };
  const closeRun = () => {
    closePiece();
    if (run.length) runs.push(run);
    run = [];
  };
  for (const m of text.matchAll(WORD_OR_DIGITS)) {
    let start = m.index;
    const end = start + m[0].length;
    let token: NumberToken | null = null;
    if (/^\d+$/.test(m[0])) {
      // A bare `#6474` is a PR number with no repo, which the repo-less Desk
      // cannot link; its `#` joins the span so it becomes `repo#6474` too.
      // Already qualified (`repo#6474`), glued to an id (`bks-91ec…`), a
      // path or a decimal (`1.5`) is not a number that was said.
      if (text[start - 1] === "#" && !/[\w/.-]/.test(text[start - 2] ?? ""))
        start -= 1;
      const before = text[start - 1] ?? "";
      const after = text.slice(end, end + 2);
      if (
        !/[\w#/.-]/.test(before) &&
        !/^[\w-]/.test(after) &&
        !/^\.\d/.test(after) &&
        m[0].length <= PR_NUMBER_MAX_DIGITS
      )
        token = { kind: "digits", value: Number(m[0]), text: m[0] };
    } else token = numberToken(m[0]);
    if (!token) {
      closeRun();
      lastEnd = end;
      continue;
    }
    const between = lastEnd < 0 ? "" : text.slice(lastEnd, start);
    // Only whitespace, a hyphen, or one comma may sit between two number
    // words of the same run.
    const joins = /^(?:\s*|\s*-\s*|\s*,\s*)$/.test(between);
    if (!piece || !joins) closeRun();
    else if (between.includes(",")) closePiece();
    if (!piece) piece = { start, end, tokens: [] };
    piece.tokens.push(token);
    piece.end = end;
    lastEnd = end;
  }
  closeRun();

  const out: SpokenNumber[] = [];
  const emit = (start: number, end: number, digits: string | null) => {
    if (
      !digits ||
      digits.length < 2 ||
      digits.length > PR_NUMBER_MAX_DIGITS ||
      digits.startsWith("0")
    )
      return;
    out.push({ start, end, value: Number(digits) });
  };
  for (const pieces of runs) {
    const loneDigits =
      pieces.length > 1 &&
      pieces.every((p) => p.tokens.length === 1 && p.tokens[0].kind === "unit");
    if (loneDigits) {
      emit(
        pieces[0].start,
        pieces[pieces.length - 1].end,
        spokenDigits(pieces.flatMap((p) => p.tokens)),
      );
      continue;
    }
    for (const p of pieces) emit(p.start, p.end, spokenDigits(p.tokens));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rewriting an assistant row.

/**
 * An assistant row with its spoken PR numbers written as `repo#N` wherever
 * the ledger knows exactly one PR by that number, and a trailer naming the
 * sessions the row is about: the ones the call just started or steered (once,
 * on the first row after the tool result), and any listed session whose
 * title the row says. User rows are never rewritten; the caller keeps them.
 */
export function linkSpokenReferences(
  text: string,
  ledger: VoiceReferenceLedger,
): string {
  let out = text;
  const numbers = spokenNumbers(text);
  for (let i = numbers.length - 1; i >= 0; i--) {
    const n = numbers[i];
    const refs = ledger.prRefsFor(n.value);
    if (refs.length !== 1) continue;
    out = `${out.slice(0, n.start)}${prKey(refs[0])}${out.slice(n.end)}`;
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const mention = (id: string) => {
    const key = id.toLowerCase();
    if (seen.has(key) || out.toLowerCase().includes(key)) return;
    seen.add(key);
    ids.push(key);
  };
  for (const id of ledger.takePending()) mention(id);
  const lower = out.toLowerCase();
  for (const ref of ledger.titledSessions())
    if (lower.includes(ref.title.toLowerCase())) mention(ref.id);
  if (ids.length)
    out += `\n\n${ids.length === 1 ? "Session" : "Sessions"}: ${ids.join(", ")}`;
  return out;
}
