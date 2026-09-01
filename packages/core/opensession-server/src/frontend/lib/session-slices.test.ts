import { describe, expect, test } from "bun:test";
import {
  mergeSessionSlices,
  settledOverrides,
  type SessionSlices,
} from "./session-slices";
import type { UnifiedSession } from "./types";

function session(
  id: string,
  over: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    claudeSessionId: null,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Ada",
    title: id,
    lastActivity: "2026-08-09T10:00:00.000Z",
    createdAt: "2026-08-09T09:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    ...over,
  };
}

function slices(over: Partial<SessionSlices> = {}): SessionSlices {
  return {
    live: [],
    liveAt: 1000,
    archivedIndex: null,
    archivedIndexAt: 1000,
    locallyArchived: new Map(),
    locallyUnarchived: new Map(),
    ...over,
  };
}

describe("mergeSessionSlices", () => {
  test("keeps the live array's identity when there is nothing to merge", () => {
    // A poll that changed nothing must not hand the app a fresh array —
    // that re-renders the sidebar, the tab strip and the open viewer.
    const live = [session("a")];
    expect(mergeSessionSlices(slices({ live }))).toBe(live);
    expect(mergeSessionSlices(slices({ live, archivedIndex: [] }))).toBe(live);
  });

  test("adds archived sessions the live slice no longer carries", () => {
    const merged = mergeSessionSlices(
      slices({
        live: [session("a")],
        archivedIndex: [session("z", { archived: true })],
      }),
    );
    expect(merged.map((s) => s.id)).toEqual(["a", "z"]);
  });

  test("the live row wins when both slices carry an id", () => {
    // Mid-unarchive the server can briefly answer both. The live copy is
    // the full session; the index row is the poorer one.
    const merged = mergeSessionSlices(
      slices({
        live: [session("a", { title: "live" })],
        archivedIndex: [session("a", { title: "indexed", archived: true })],
      }),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("live");
  });

  test("holds a just-archived session the live slice has already dropped", () => {
    const archived = session("a", { archived: true });
    const merged = mergeSessionSlices(
      slices({
        live: [],
        archivedIndex: [],
        locallyArchived: new Map([["a", { session: archived, at: 2000 }]]),
      }),
    );
    expect(merged.map((s) => s.id)).toEqual(["a"]);
  });

  test("hides a just-unarchived session the index still lists", () => {
    const merged = mergeSessionSlices(
      slices({
        live: [],
        archivedIndex: [session("a", { archived: true })],
        locallyUnarchived: new Map([["a", 2000]]),
      }),
    );
    expect(merged).toEqual([]);
  });
});

describe("settledOverrides", () => {
  test("an archive settles once the index lists it", () => {
    const result = settledOverrides(
      slices({
        archivedIndex: [session("a", { archived: true })],
        archivedIndexAt: 1000,
        locallyArchived: new Map([["a", { session: session("a"), at: 3000 }]]),
      }),
    );
    expect(result.archived).toEqual(["a"]);
  });

  test("an archive is still held while the index predates it", () => {
    // The index we have was built before the change; its silence says
    // nothing yet.
    const result = settledOverrides(
      slices({
        archivedIndex: [],
        archivedIndexAt: 1000,
        locallyArchived: new Map([["a", { session: session("a"), at: 3000 }]]),
      }),
    );
    expect(result.archived).toEqual([]);
  });

  test("an archive the server disagrees with is dropped, not pinned", () => {
    // Rebuilt after the change and still no row: unarchived elsewhere, or
    // deleted. Holding it any longer would be inventing a session.
    const result = settledOverrides(
      slices({
        archivedIndex: [],
        archivedIndexAt: 4000,
        locallyArchived: new Map([["a", { session: session("a"), at: 3000 }]]),
      }),
    );
    expect(result.archived).toEqual(["a"]);
  });

  test("nothing settles before the first index lands", () => {
    const result = settledOverrides(
      slices({
        archivedIndex: null,
        archivedIndexAt: 9000,
        locallyArchived: new Map([["a", { session: session("a"), at: 3000 }]]),
      }),
    );
    expect(result.archived).toEqual([]);
  });

  test("an unarchive settles once the live slice carries it", () => {
    const result = settledOverrides(
      slices({
        live: [session("a")],
        liveAt: 1000,
        locallyUnarchived: new Map([["a", 3000]]),
      }),
    );
    expect(result.unarchived).toEqual(["a"]);
  });

  test("an unarchive is held until a poll that started after it", () => {
    expect(
      settledOverrides(
        slices({
          live: [],
          liveAt: 1000,
          locallyUnarchived: new Map([["a", 3000]]),
        }),
      ).unarchived,
    ).toEqual([]);
    expect(
      settledOverrides(
        slices({
          live: [],
          liveAt: 4000,
          locallyUnarchived: new Map([["a", 3000]]),
        }),
      ).unarchived,
    ).toEqual(["a"]);
  });
});
