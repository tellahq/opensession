import { describe, expect, test } from "bun:test";
import { FALLBACK_REPO, sessionRepoOr } from "../lib/session-repo";
import type { UnifiedSession } from "../lib/types";
import { sessionSearchIndex, sortByRecentActivity } from "./SessionSearch";

// The palette's own derivations, kept verbatim from before they were hoisted
// out of the results memo. Precomputing them is only worth having if the text
// and the order come out identical, so the old code is the oracle rather than
// a description of it.
function oldHaystack(s: UnifiedSession): string {
  return [
    s.title,
    s.branch,
    s.startedBy,
    s.automation,
    sessionRepoOr(s, FALLBACK_REPO),
    s.linearIssue?.identifier,
    s.linearIssue?.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function oldSort(rows: UnifiedSession[]): UnifiedSession[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    );
}

function session(s: Partial<UnifiedSession> & { id: string }): UnifiedSession {
  const base = {
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: null,
    title: "",
    lastActivity: "",
    createdAt: "",
    isRunning: false,
  } satisfies Omit<UnifiedSession, "id">;
  return Object.assign(base, s);
}

// Deliberately awkward: two sessions share a timestamp (the tie a stable sort
// has to leave in pool order), one has an unparseable date and one has none at
// all, both of which make the comparator return NaN.
const POOL: UnifiedSession[] = [
  session({
    id: "a",
    title: "Fix the Composer",
    branch: "fix-composer",
    startedBy: "Michiel",
    repo: "opensession",
    lastActivity: "2026-08-16T10:00:00.000Z",
  }),
  session({
    id: "b",
    title: "Nightly sweep",
    automation: "Dreaming",
    repo: "tella-fusion",
    lastActivity: "2026-08-17T09:30:00.000Z",
  }),
  session({
    id: "c",
    title: "Tie one",
    lastActivity: "2026-08-17T09:30:00.000Z",
  }),
  session({
    id: "d",
    title: "Linked",
    startedBy: "Kent",
    linearIssue: { identifier: "TEL-123", title: "Sidebar drift" },
    lastActivity: "2026-08-15T08:00:00.000Z",
  }),
  session({ id: "e", title: "Unparseable", lastActivity: "not a date" }),
  session({ id: "f", title: "No activity at all" }),
];

describe("sessionSearchIndex", () => {
  test("holds the same haystack the palette derived per keystroke", () => {
    const index = sessionSearchIndex(POOL);
    for (const s of POOL) {
      expect(index.hay.get(s)).toBe(oldHaystack(s));
    }
  });

  test("covers every session in the pool", () => {
    const index = sessionSearchIndex(POOL);
    expect(index.hay.size).toBe(POOL.length);
    expect(index.activityAt.size).toBe(POOL.length);
  });
});

describe("sortByRecentActivity", () => {
  test("orders identically to the Date-allocating comparator", () => {
    const index = sessionSearchIndex(POOL);
    expect(sortByRecentActivity(POOL.slice(), index).map((s) => s.id)).toEqual(
      oldSort(POOL).map((s) => s.id),
    );
  });

  test("leaves a tie in pool order", () => {
    // "b" and "c" carry the same timestamp; "b" comes first in the pool.
    const index = sessionSearchIndex(POOL);
    const ids = sortByRecentActivity(POOL.slice(), index).map((s) => s.id);
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  test("orders a reversed pool the same way the old comparator does", () => {
    const reversed = POOL.slice().reverse();
    const index = sessionSearchIndex(reversed);
    expect(
      sortByRecentActivity(reversed.slice(), index).map((s) => s.id),
    ).toEqual(oldSort(reversed).map((s) => s.id));
  });

  test("falls back to deriving a key for a session the index never saw", () => {
    // A pool and an index momentarily out of step must still order by date,
    // not treat the unseen row as epoch and sink it to the bottom.
    const index = sessionSearchIndex(POOL.slice(1));
    const rows = POOL.slice();
    expect(sortByRecentActivity(rows, index).map((s) => s.id)).toEqual(
      oldSort(POOL).map((s) => s.id),
    );
  });

  test("sorts in place and returns the same array", () => {
    const index = sessionSearchIndex(POOL);
    const rows = POOL.slice();
    expect(sortByRecentActivity(rows, index)).toBe(rows);
  });
});
