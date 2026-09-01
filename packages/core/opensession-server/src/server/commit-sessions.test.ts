import { describe, expect, it } from "bun:test";
import {
  firstMentions,
  readableThrough,
  readCommitTranscriptRows,
} from "./commit-sessions";

const SHA = "ad85e5d51c76de8fd66fea6f9f1c777f1d174910";
const at = Date.parse("2026-08-15T17:37:00Z");
const wanted = new Map([[SHA.slice(0, 7), { sha: SHA, at }]]);

const row = (
  session: string,
  offsetMs: number,
  data: string,
): { session: string; ts: number; data: string } => ({
  session,
  ts: at + offsetMs,
  data,
});

describe("commit transcript pagination", () => {
  it("continues through full 200-row actor pages", async () => {
    const entries = Array.from({ length: 450 }, (_, index) => ({
      id: `entry-${index + 1}`,
      seq: index + 1,
      changeSeq: index + 1,
      type: "assistant" as const,
      content: `row ${index + 1}`,
      timestamp: new Date(at + index).toISOString(),
    }));
    const limits: number[] = [];
    const rows = await readCommitTranscriptRows("session", 0, (async (
      _sessionId: string,
      cursor: number,
      limit = 200,
    ) => {
      limits.push(limit);
      const page = entries
        .filter((entry) => entry.seq > cursor)
        .slice(0, limit);
      return {
        entries: page,
        firstSeq: page[0]?.seq ?? 0,
        lastSeq: page.at(-1)?.seq ?? 0,
      };
    }) as typeof import("./actor-transcript").transcript.readSince);
    expect(rows).toHaveLength(450);
    expect(limits).toEqual([200, 200, 200]);
  });
});

describe("firstMentions", () => {
  it("credits the session that said the sha first", () => {
    // Everyone in a shared checkout sees the sha once they run `git log`. The
    // one that made it is the one that saw it the moment it landed.
    const found = firstMentions(
      [
        row("os-reader", 60_000, `commit ${SHA}\nAuthor: Michiel`),
        row("os-maker", 500, `[main ad85e5d5] Ask card\n 4 files changed`),
      ],
      wanted,
    );
    expect(found.get(SHA)?.session).toBe("os-maker");
  });

  it("ignores a mention far from the commit", () => {
    expect(firstMentions([row("os-later", 3_600_000, SHA)], wanted).size).toBe(
      0,
    );
  });

  it("does not read a uuid's hex as a sha it happens to start like", () => {
    // Split by its dashes, a uuid offers exactly the kind of bounded hex run a
    // short sha is, so a prefix match alone would credit the wrong session.
    const uuid = `${SHA.slice(0, 8)}9-0000-4000-8000-000000000000`;
    expect(firstMentions([row("os-noise", 0, uuid)], wanted).size).toBe(0);
  });

  it("reads an abbreviation and a full sha as the same commit", () => {
    for (const text of ["[main ad85e5d5] Ask card", SHA, "reverts `ad85e5d`"]) {
      expect(
        firstMentions([row("os-maker", 0, text)], wanted).get(SHA)?.session,
      ).toBe("os-maker");
    }
  });

  it("reads a sha that begins a line in the stored JSON", () => {
    // A transcript row is JSON text, so `git commit`'s newline is stored as the
    // two characters `\` and `n`, and that `n` is a word character. Written as
    // a real newline this passes either way, which is how it went unnoticed:
    // the same sha one line lower was simply never seen.
    const stored = String.raw`{"content":"main\nad85e5d5 Ask card\n 4 files"}`;
    expect(
      firstMentions([row("os-maker", 0, stored)], wanted).get(SHA)?.session,
    ).toBe("os-maker");
  });

  it("keeps the earliest mention when one session says it twice", () => {
    const found = firstMentions(
      [row("os-maker", 5_000, SHA), row("os-maker", 100, SHA)],
      wanted,
    );
    expect(found.get(SHA)?.ts).toBe(at + 100);
  });
});

describe("readableThrough", () => {
  const rows = [
    { seq: 1, ts: 1_000 },
    { seq: 2, ts: 2_000 },
    { seq: 3, ts: 3_000 },
  ];

  it("marks every row the commit list already covers", () => {
    expect(readableThrough(rows, 3_000)).toBe(3);
  });

  it("stops at a row written after the commit list was read", () => {
    // The row at 3s may name a commit made after `git log` ran, so this sweep
    // was never asked about it. Marking it read would be the last chance to.
    expect(readableThrough(rows, 2_500)).toBe(2);
  });

  it("marks nothing when the whole batch is newer than the list", () => {
    expect(readableThrough(rows, 500)).toBe(-1);
  });
});
