import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore, TRANSCRIPT_DATA_MAX_BYTES } from "./transcript-store";
import type { TranscriptEntry } from "./types";

function withStore(run: (store: TranscriptStore, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "transcript-reliability-"));
  const path = join(dir, "transcripts.db");
  const store = new TranscriptStore(path);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function entry(id: string, content: string): TranscriptEntry {
  return {
    id,
    type: "assistant",
    content,
    timestamp: "2026-07-23T00:00:00.000Z",
  };
}

describe("transcript store durability", () => {
  test("migrates a seq-only database and preserves history", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-migrate-"));
    const path = join(dir, "transcripts.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, uuid TEXT NOT NULL,
        ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, full_ref INTEGER,
        PRIMARY KEY (session_id, seq)
      );
      CREATE UNIQUE INDEX idx_te_uuid ON transcript_events(session_id, uuid);
      CREATE TABLE transcript_blobs (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_tb_uuid ON transcript_blobs(session_id, uuid);
      CREATE TABLE transcript_sessions (
        session_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1,
        last_ts INTEGER, imported_at INTEGER, import_src TEXT, import_watermark INTEGER
      );
    `);
    old
      .query(
        "INSERT INTO transcript_sessions (session_id, next_seq) VALUES ('s', 2)",
      )
      .run();
    old
      .query(
        "INSERT INTO transcript_events VALUES ('s', 1, 'a', 1, 'assistant', ?, NULL)",
      )
      .run(JSON.stringify(entry("a", "old")));
    old.close();

    const store = new TranscriptStore(path);
    try {
      expect(store.readTail("s").entries[0]).toMatchObject({
        id: "a",
        seq: 1,
        changeSeq: 1,
      });
      store.appendTranscriptEvents("s", [entry("a", "new")]);
      expect(store.readChangesSince("s", 1).entries[0]).toMatchObject({
        content: "new",
        seq: 1,
        changeSeq: 2,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("change cursors survive close and reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-reopen-"));
    const path = join(dir, "transcripts.db");
    let store = new TranscriptStore(path);
    store.appendTranscriptEvents("s", [entry("a", "one")]);
    store.appendTranscriptEvents("s", [entry("a", "two")]);
    store.close();
    store = new TranscriptStore(path);
    try {
      expect(store.getLastChangeSeq("s")).toBe(2);
      expect(store.readChangesSince("s", 1).entries[0]).toMatchObject({
        content: "two",
        changeSeq: 2,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("authoritative replacement removes stale ids and preserves change monotonicity", () => {
    withStore((store) => {
      store.appendTranscriptEvents("s", [
        entry("old", "old"),
        entry("keep", "v1"),
      ]);
      const before = store.getLastChangeSeq("s");
      store.replaceTranscriptEvents("s", [entry("keep", "v2")]);
      expect(store.readTail("s").entries).toEqual([
        expect.objectContaining({
          id: "keep",
          content: "v2",
          seq: 1,
          changeSeq: before + 2,
        }),
      ]);
      expect(store.getLastChangeSeq("s")).toBe(before + 2);
      expect(store.getLastResetChangeSeq("s")).toBe(before + 1);
    });
  });

  test("empty replacement records a durable reset mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-empty-reset-"));
    const path = join(dir, "transcripts.db");
    let store = new TranscriptStore(path);
    store.appendTranscriptEvents("s", [entry("old", "old")]);
    const before = store.getLastChangeSeq("s");
    store.replaceTranscriptEvents("s", []);
    store.close();
    store = new TranscriptStore(path);
    try {
      expect(store.readTail("s").entries).toEqual([]);
      expect(store.getLastResetChangeSeq("s")).toBe(before + 1);
      expect(store.getLastChangeSeq("s")).toBe(before + 1);
      store.appendTranscriptEvents("s", [entry("new", "new")]);
      expect(store.readTail("s").entries[0].changeSeq).toBe(before + 2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multibyte content is bounded by bytes and hydrates losslessly", () => {
    withStore((store, path) => {
      const original = "🙂".repeat(40_000);
      store.appendTranscriptEvents("s", [entry("emoji", original)]);
      const raw = new Database(path, { readonly: true });
      try {
        const row = raw
          .query("SELECT data FROM transcript_events WHERE session_id = 's'")
          .get() as { data: string };
        expect(Buffer.byteLength(row.data)).toBeLessThanOrEqual(
          TRANSCRIPT_DATA_MAX_BYTES,
        );
        expect(() => JSON.parse(row.data)).not.toThrow();
      } finally {
        raw.close();
      }
      expect(store.getFullEntry("s", "emoji")?.content).toBe(original);
    });
  });
});

describe("deterministic mutation fuzz", () => {
  for (const seed of [1, 7, 42, 20260723]) {
    test(`last-write-wins, dense seqs, and complete change replay (seed ${seed})`, () => {
      withStore((store) => {
        let state = seed >>> 0;
        const random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state;
        };
        const expected = new Map<string, string>();
        const firstSeen: string[] = [];
        let cursor = 0;
        for (let i = 0; i < 500; i++) {
          const id = `id-${random() % 80}`;
          const content = `${seed}:${i}:${random()}`;
          if (!expected.has(id)) firstSeen.push(id);
          expected.set(id, content);
          store.appendTranscriptEvents("fuzz", [entry(id, content)]);

          if (i % 37 === 0) {
            const changes = store.readChangesSince("fuzz", cursor, 1000);
            for (const change of changes.entries) {
              expect(change.changeSeq).toBeGreaterThan(cursor);
              cursor = change.changeSeq;
            }
          }
        }
        const all = store.readTail("fuzz", 1000).entries;
        expect(all.map((e) => e.id)).toEqual(firstSeen);
        expect(all.map((e) => e.seq)).toEqual(
          Array.from({ length: firstSeen.length }, (_, i) => i + 1),
        );
        for (const row of all) expect(row.content).toBe(expected.get(row.id)!);
        expect(store.getLastChangeSeq("fuzz")).toBe(500);
      });
    });
  }
});
