import { describe, expect, it } from "bun:test";
import {
  excerptTerms,
  formatExcerpt,
  transcriptExcerpt,
  type ExcerptDeps,
  type ExcerptStore,
} from "./transcript-excerpt";
import type { TranscriptEntry } from "./types";

type Row = TranscriptEntry & { seq: number };

function entry(seq: number, over: Partial<TranscriptEntry> = {}): Row {
  return {
    id: `e${seq}`,
    type: "assistant",
    content: `entry ${seq}`,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    seq,
    ...over,
  } as Row;
}

/** Store double: readSince pages by seq exactly like TranscriptStore, and
 *  getFullEntry hydrates only the ids handed to it. */
function fakeStore(
  rows: Row[],
  full = new Map<string, TranscriptEntry>(),
): ExcerptStore {
  return {
    getLastSeq: () => rows.reduce((m, r) => Math.max(m, r.seq), 0),
    readSince: (_id, since, limit = 500) =>
      ({ entries: rows.filter((r) => r.seq > since).slice(0, limit) }) as never,
    getFullEntry: (_id, uuid) => full.get(uuid) ?? null,
  };
}

function deps(
  store: ExcerptStore | null,
  legacy: TranscriptEntry[] = [],
): ExcerptDeps {
  return { store, legacy: async () => legacy };
}

describe("excerptTerms", () => {
  it("keeps code-ish tokens and drops noise", () => {
    expect(
      excerptTerms("why did getSessionDiff fail on src/server/x.ts?"),
    ).toEqual([
      "why",
      "did",
      "getsessiondiff",
      "fail",
      "on",
      "src/server/x.ts",
    ]);
  });
});

describe("transcriptExcerpt", () => {
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => entry(i + 1)),
    entry(41, { content: "the culprit was a stale pi shard db" }),
    ...Array.from({ length: 40 }, (_, i) => entry(i + 42)),
  ];

  it("centres the window on the match, not on the tail", async () => {
    const ex = await transcriptExcerpt(
      "bks-1",
      { query: "stale shard", limit: 9, windows: 1 },
      deps(fakeStore(rows)),
    );
    expect(ex.source).toBe("store");
    expect(ex.windows).toHaveLength(1);
    expect(ex.windows[0]!.matchSeq).toBe(41);
    // Match sits inside the window, with lead-in context before it.
    expect(ex.windows[0]!.firstSeq).toBeLessThan(41);
    expect(ex.windows[0]!.lastSeq).toBeGreaterThan(41);
    expect(ex.windows[0]!.entries.some((e) => e.seq === 41)).toBe(true);
    // ...and it is emphatically not the end of the session.
    expect(ex.windows[0]!.lastSeq).toBeLessThan(ex.lastSeq);
  });

  it("returns separate windows for matches far apart, and never overlaps them", async () => {
    const spread = [
      entry(1, { content: "first mention of widget" }),
      ...Array.from({ length: 30 }, (_, i) => entry(i + 2)),
      entry(32, { content: "second mention of widget" }),
      ...Array.from({ length: 10 }, (_, i) => entry(i + 33)),
    ];
    const ex = await transcriptExcerpt(
      "bks-1",
      { query: "widget", limit: 6, windows: 4 },
      deps(fakeStore(spread)),
    );
    expect(ex.matched).toBe(2);
    expect(ex.windows).toHaveLength(2);
    expect(ex.windows[0]!.lastSeq).toBeLessThan(ex.windows[1]!.firstSeq);
  });

  it("ranks an entry carrying every term above one carrying some", async () => {
    const mixed = [
      entry(1, { content: "cache warning appeared" }),
      entry(2, { content: "unrelated" }),
      entry(3, { content: "the cache warning fired on restart" }),
    ];
    const ex = await transcriptExcerpt(
      "bks-1",
      { query: "cache restart", limit: 2, windows: 1 },
      deps(fakeStore(mixed)),
    );
    expect(ex.windows[0]!.matchSeq).toBe(3);
  });

  it("matches tool inputs, so a command is findable by what it ran", async () => {
    const withTool = [
      entry(1),
      entry(2, {
        type: "tool_use",
        content: "Using bash",
        toolName: "bash",
        toolUseId: "t2",
        toolInput: { command: "bun test src/server/handoff-evidence.test.ts" },
      }),
      entry(3),
    ];
    const ex = await transcriptExcerpt(
      "bks-1",
      { query: "handoff-evidence.test.ts", limit: 3, windows: 1 },
      deps(fakeStore(withTool)),
    );
    expect(ex.matched).toBe(1);
    expect(ex.windows[0]!.matchSeq).toBe(2);
  });

  it("pages around an explicit seq without searching", async () => {
    const ex = await transcriptExcerpt(
      "bks-1",
      { aroundSeq: 20, limit: 6 },
      deps(fakeStore(rows)),
    );
    expect(ex.matched).toBe(0);
    expect(ex.windows[0]!.firstSeq).toBeLessThanOrEqual(20);
    expect(ex.windows[0]!.lastSeq).toBeGreaterThanOrEqual(20);
    expect(ex.windows[0]!.entries).toHaveLength(6);
  });

  it("falls back to the tail with no query", async () => {
    const ex = await transcriptExcerpt(
      "bks-1",
      { limit: 5 },
      deps(fakeStore(rows)),
    );
    expect(ex.windows[0]!.lastSeq).toBe(81);
    expect(ex.windows[0]!.entries).toHaveLength(5);
  });

  it("shows the tail (and says nothing matched) when the terms aren't in the transcript", async () => {
    const ex = await transcriptExcerpt(
      "bks-1",
      { query: "zzzznotpresent", limit: 4 },
      deps(fakeStore(rows)),
    );
    expect(ex.matched).toBe(0);
    expect(ex.windows[0]!.lastSeq).toBe(81);
  });

  it("hydrates returned entries to full content (store rows are bounded)", async () => {
    const stripped = [entry(1, { content: "clipped…", contentClamped: true })];
    const full = new Map<string, TranscriptEntry>([
      [
        "e1",
        {
          ...stripped[0]!,
          content: "the whole thing, unclipped",
          contentClamped: false,
        },
      ],
    ]);
    const ex = await transcriptExcerpt(
      "bks-1",
      { limit: 2 },
      deps(fakeStore(stripped, full)),
    );
    expect(ex.windows[0]!.entries[0]!.content).toBe(
      "the whole thing, unclipped",
    );
    // Hydration must not lose the display order the window is anchored on.
    expect(ex.windows[0]!.entries[0]!.seq).toBe(1);
  });

  it("pages actor scans within the 200-row wire limit", async () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      entry(i + 1, { content: i === 10 ? "older bounded needle" : `row ${i}` }),
    );
    const limits: number[] = [];
    const store = fakeStore(many);
    const readSince = store.readSince;
    store.readSince = (sessionId, sinceSeq, limit) => {
      limits.push(limit ?? 0);
      return readSince(sessionId, sinceSeq, limit);
    };
    const ex = await transcriptExcerpt(
      "bks-many",
      { query: "bounded needle", windows: 1 },
      deps(store),
    );
    expect(ex.source).toBe("store");
    expect(ex.windows[0]?.matchSeq).toBe(11);
    expect(limits.length).toBeGreaterThan(1);
    expect(limits.every((limit) => limit <= 200)).toBe(true);
  });

  it("does not replace a failed actor scan with an unbounded legacy read", async () => {
    let legacyReads = 0;
    const store: ExcerptStore = {
      getLastSeq: () => 500,
      readSince: () => {
        throw new Error("actor unavailable");
      },
      getFullEntry: () => null,
    };
    const ex = await transcriptExcerpt(
      "bks-failed",
      { query: "needle" },
      {
        store,
        legacy: async () => {
          legacyReads++;
          return [entry(1, { content: "needle" })];
        },
      },
    );
    expect(ex).toMatchObject({ source: "none", truncated: true, windows: [] });
    expect(legacyReads).toBe(0);
  });

  it("falls back to the legacy transcript when the store has nothing", async () => {
    const legacy = [
      {
        id: "l1",
        type: "user",
        content: "old session question",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "l2",
        type: "assistant",
        content: "old answer",
        timestamp: "2026-01-01T00:01:00Z",
      },
    ] as TranscriptEntry[];
    const ex = await transcriptExcerpt(
      "plain-1",
      { query: "old answer" },
      deps(fakeStore([]), legacy),
    );
    expect(ex.source).toBe("legacy");
    // Legacy entries carry no owned seq — position becomes the handle.
    expect(ex.windows[0]!.entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("reports nothing rather than inventing a window for an unknown session", async () => {
    const ex = await transcriptExcerpt("bks-nope", {}, deps(fakeStore([]), []));
    expect(ex.source).toBe("none");
    expect(ex.windows).toHaveLength(0);
    expect(formatExcerpt(ex)).toContain("No transcript entries");
  });
});

describe("formatExcerpt", () => {
  it("tags every line with its seq and surfaces tool inputs and errors", async () => {
    const rows = [
      entry(1, { type: "user", content: "please fix the build" }),
      entry(2, {
        type: "tool_use",
        toolName: "bash",
        toolUseId: "t2",
        content: "Using bash",
        toolInput: { command: "bun run build" },
      }),
      entry(3, {
        type: "tool_result",
        toolUseId: "t2",
        content: "boom",
        isError: true,
      }),
    ];
    const out = formatExcerpt(
      await transcriptExcerpt("bks-1", { limit: 5 }, deps(fakeStore(rows))),
    );
    expect(out).toContain("[1] user:");
    expect(out).toContain("command=bun run build");
    expect(out).toContain("tool_result ✗");
    expect(out).toContain("around_seq");
  });

  it("stops at the budget instead of dumping the session", async () => {
    const big = Array.from({ length: 30 }, (_, i) =>
      entry(i + 1, { content: "x".repeat(500) }),
    );
    const out = formatExcerpt(
      await transcriptExcerpt("bks-1", { limit: 30 }, deps(fakeStore(big))),
      { budget: 1200 },
    );
    expect(out).toContain("excerpt budget reached");
    expect(out.length).toBeLessThan(2500);
  });
});
