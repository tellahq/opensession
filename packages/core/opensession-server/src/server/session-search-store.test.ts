/**
 * session-search-store tests — pure FTS5 store, no server imports (keep it
 * that way: pulling run-rpc into a test steals the live rpc socket).
 */
import { describe, expect, test } from "bun:test";
import {
  SessionSearchStore,
  ftsQuery,
  type SearchRecord,
} from "./session-search-store";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function rec(over: Partial<SearchRecord> & { id: string }): SearchRecord {
  return {
    source: "session",
    question: "",
    summary: "",
    resolution: "",
    files: "",
    ts: NOW - DAY,
    activityTs: NOW - DAY,
    distilled: "mech",
    ...over,
  };
}

describe("ftsQuery", () => {
  test("quotes terms and strips embedded quotes", () => {
    expect(ftsQuery(`restore "hangs" after manifest`, false)).toBe(
      `"restore" "hangs" "after" "manifest"`,
    );
  });
  test("OR mode joins with OR", () => {
    expect(ftsQuery("a b", true)).toBe(`"a" OR "b"`);
  });
  test("empty input → empty query", () => {
    expect(ftsQuery("  ", false)).toBe("");
  });
});

describe("SessionSearchStore", () => {
  test("upsert replaces by id and count tracks", () => {
    const s = new SessionSearchStore(":memory:");
    s.upsert(rec({ id: "session:a", question: "first version" }));
    s.upsert(rec({ id: "session:a", question: "second version" }));
    expect(s.count()).toBe(1);
    const hits = s.search("version", { now: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0].question).toBe("second version");
    s.close();
  });

  test("exact error-string tokens match despite punctuation", () => {
    const s = new SessionSearchStore(":memory:");
    s.upsert(
      rec({
        id: "session:err",
        question: "why does restore fail",
        resolution: 'fixed "Failed to execute statement" by retrying the turn',
      }),
    );
    const hits = s.search("Failed to execute statement", { now: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("session:err");
    s.close();
  });

  test("AND-miss falls back to OR", () => {
    const s = new SessionSearchStore(":memory:");
    s.upsert(rec({ id: "session:x", question: "transcript loading slow" }));
    // "zebra" appears nowhere; AND would find nothing, OR still hits.
    const hits = s.search("transcript zebra", { now: NOW });
    expect(hits.length).toBe(1);
    s.close();
  });

  test("recency decay outranks older equal-relevance record", () => {
    const s = new SessionSearchStore(":memory:");
    s.upsert(
      rec({
        id: "session:old",
        question: "worktree cleanup",
        ts: NOW - 300 * DAY,
      }),
    );
    s.upsert(
      rec({
        id: "session:new",
        question: "worktree cleanup",
        ts: NOW - 2 * DAY,
      }),
    );
    const hits = s.search("worktree cleanup", { now: NOW });
    expect(hits.map((h) => h.id)).toEqual(["session:new", "session:old"]);
    s.close();
  });

  test("repo filter and days filter", () => {
    const s = new SessionSearchStore(":memory:");
    s.upsert(
      rec({
        id: "session:bs",
        question: "fix diff panel",
        repo: "opensession",
      }),
    );
    s.upsert(
      rec({
        id: "session:tf",
        question: "fix diff panel",
        repo: "tella-fusion",
        ts: NOW - 40 * DAY,
      }),
    );
    expect(
      s
        .search("diff panel", { repo: "opensession", now: NOW })
        .map((h) => h.id),
    ).toEqual(["session:bs"]);
    expect(
      s
        .search("diff panel", { sinceTs: NOW - 10 * DAY, now: NOW })
        .map((h) => h.id),
    ).toEqual(["session:bs"]);
    s.close();
  });

  test("hostile query strings don't throw", () => {
    const s = new SessionSearchStore(":memory:");
    s.upsert(rec({ id: "session:a", question: "hello world" }));
    expect(() =>
      s.search('NEAR( "unclosed OR AND NOT *', { now: NOW }),
    ).not.toThrow();
    expect(() => s.search("-", { now: NOW })).not.toThrow();
    s.close();
  });
});
