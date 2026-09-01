/**
 * Transcript v2 store tests (docs/transcripts.md §1, §1a, §2, §3).
 *
 * Runs against a TEMP-DIR DB only — never transcriptStore() (the lazy
 * singleton over the live transcripts.db; invariant 8: one writer). Import
 * graph is deliberately tiny (transcript-store → paths → rename-compat/
 * profile; transcript-bus → nothing) so `bun test` can never transitively
 * reach run-rpc.ts and steal the live rpc socket.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TranscriptStore,
  TRANSCRIPT_DATA_MAX_BYTES,
  setAppendHook,
  type SeqEntry,
} from "./transcript-store";
import { subscribeTranscript, type TranscriptBusEvent } from "./transcript-bus";
import type { TranscriptEntry } from "./types";

const dir = mkdtempSync(join(tmpdir(), "transcript-store-test-"));
const dbPath = join(dir, "transcripts.db");
const store = new TranscriptStore(dbPath);

afterAll(() => {
  setAppendHook(null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function entry(
  id: string,
  content: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id,
    type: "assistant",
    content,
    timestamp: new Date(1700000000000 + n++ * 1000).toISOString(),
    ...extra,
  } as TranscriptEntry;
}

/** Drain microtasks (bus fan-out) before asserting. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("append + read roundtrip", () => {
  const sid = "bks-roundtrip";

  test("appends assign dense 1-based seqs and read back in order", async () => {
    const entries = [1, 2, 3, 4, 5].map((i) => entry(`e${i}`, `msg ${i}`));
    const res = await store.appendTranscriptEvents(sid, entries);
    expect(res).toEqual({ firstSeq: 1, lastSeq: 5, inserted: 5, updated: 0 });
    expect(store.getLastSeq(sid)).toBe(5);

    const tail = store.readTail(sid, 50);
    expect(tail.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(tail.entries.map((e) => e.content)).toEqual([
      "msg 1",
      "msg 2",
      "msg 3",
      "msg 4",
      "msg 5",
    ]);
    expect(tail.firstSeq).toBe(1);
    expect(tail.lastSeq).toBe(5);
  });

  test("readTail limit returns the LAST n entries", async () => {
    const tail = store.readTail(sid, 3);
    expect(tail.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(tail.firstSeq).toBe(3);
    expect(tail.lastSeq).toBe(5);
  });

  test("empty session reads as empty page, lastSeq 0", async () => {
    const t = store.readTail("bks-nonexistent");
    expect(t.entries).toEqual([]);
    expect(t.firstSeq).toBe(0);
    expect(t.lastSeq).toBe(0);
    expect(store.getLastSeq("bks-nonexistent")).toBe(0);
  });

  test("entries without an id are skipped, not thrown", async () => {
    const bad = {
      type: "system",
      content: "no id",
      timestamp: "",
    } as unknown as TranscriptEntry;
    expect(await store.appendTranscriptEvents("bks-badid", [bad])).toBeNull();
    expect(store.getLastSeq("bks-badid")).toBe(0);
  });
});

describe("stored media sanitation", () => {
  test("removes implicit attachments from old grep result rows on every read path", async () => {
    const sid = "bks-grep-media";
    const result = entry(
      "grep-result",
      'Found 1 match\n/workspace/src/video.rs:\n  Line 12: "https://example.com/demo.mp4"',
      {
        type: "tool_result",
        videos: ["https://example.com/demo.mp4"],
      },
    );
    await store.appendTranscriptEvents(sid, [result]);

    expect(store.readTail(sid).entries[0].videos).toBeUndefined();
    expect(store.readSince(sid, 0).entries[0].videos).toBeUndefined();
    expect(store.getFullEntry(sid, result.id)?.videos).toBeUndefined();
  });
});

describe("uuid dedup + upsert", () => {
  const sid = "bks-dedup";

  test("re-append of the same entry mints no new seq", async () => {
    await store.appendTranscriptEvents(sid, [
      entry("a", "one"),
      entry("b", "two"),
    ]);
    expect(store.getLastSeq(sid)).toBe(2);

    const res = await store.appendTranscriptEvents(sid, [entry("a", "one")]);
    expect(res).toEqual({ firstSeq: 1, lastSeq: 1, inserted: 0, updated: 1 });
    expect(store.getLastSeq(sid)).toBe(2);
  });

  test("upsert updates data in place and keeps the original seq", async () => {
    const res = await store.appendTranscriptEvents(sid, [
      entry("a", "one REWRITTEN by stream"),
    ]);
    expect(res!.updated).toBe(1);
    expect(res!.firstSeq).toBe(1);

    const tail = store.readTail(sid);
    expect(tail.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(tail.entries[0].content).toBe("one REWRITTEN by stream");
    expect(tail.entries[1].content).toBe("two");
  });

  test("mixed batch: upsert keeps seq, new row gets next seq", async () => {
    const res = await store.appendTranscriptEvents(sid, [
      entry("b", "two v2"),
      entry("c", "three"),
    ]);
    expect(res).toEqual({ firstSeq: 2, lastSeq: 3, inserted: 1, updated: 1 });
    expect(store.readTail(sid).entries.map((e) => [e.seq, e.content])).toEqual([
      [1, "one REWRITTEN by stream"],
      [2, "two v2"],
      [3, "three"],
    ]);
  });
});

describe("big-entry bounding", () => {
  const sid = "bks-big";
  const bigContent = "x".repeat(100_000);
  const dataUrl = "data:image/png;base64," + "A".repeat(80_000);

  test("oversized entry is stripped in data, full in blob", async () => {
    const big = entry("big-1", bigContent, {
      type: "tool_use",
      toolName: "Bash",
      toolInput: { command: "echo hi", giant: "y".repeat(50_000) },
      images: [dataUrl, "https://cdn.tella.tv/pic.png"],
    });
    const res = await store.appendTranscriptEvents(sid, [big]);
    expect(res!.inserted).toBe(1);

    // Raw row is hard-bounded and carries a full_ref.
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw
        .query(
          "SELECT data, full_ref FROM transcript_events WHERE session_id = ? AND uuid = ?",
        )
        .get(sid, "big-1") as { data: string; full_ref: number | null };
      expect(Buffer.byteLength(row.data)).toBeLessThanOrEqual(
        TRANSCRIPT_DATA_MAX_BYTES,
      );
      expect(row.full_ref).not.toBeNull();
    } finally {
      raw.close();
    }

    // Stripped wire form: clamp markers, toolInput summary, os-blob marker.
    const wire = store.readTail(sid).entries[0];
    expect(wire.contentClamped).toBe(true);
    expect(wire.contentLength).toBe(100_000);
    expect(wire.content.length).toBeLessThan(100_000);
    expect(bigContent.startsWith(wire.content)).toBe(true);
    expect(wire.toolInput).toEqual({
      toolName: "Bash",
      byteSize: expect.any(Number),
      keys: ["command", "giant"],
    });
    expect(wire.images![0]).toBe("os-blob:big-1/0");
    expect(wire.images![1]).toBe("https://cdn.tella.tv/pic.png"); // http srcs untouched

    // getFullEntry resolves the unstripped original.
    const full = store.getFullEntry(sid, "big-1")!;
    expect(full.content).toBe(bigContent);
    expect(full.images![0]).toBe(dataUrl);
    expect((full.toolInput as { giant: string }).giant.length).toBe(50_000);
    expect(full.contentClamped).toBeUndefined();
  });

  test("small entry: no blob, getFullEntry serves from the row", async () => {
    await store.appendTranscriptEvents(sid, [entry("small-1", "tiny")]);
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw
        .query(
          "SELECT full_ref FROM transcript_events WHERE session_id = ? AND uuid = ?",
        )
        .get(sid, "small-1") as { full_ref: number | null };
      expect(row.full_ref).toBeNull();
    } finally {
      raw.close();
    }
    expect(store.getFullEntry(sid, "small-1")!.content).toBe("tiny");
    expect(store.getFullEntry(sid, "does-not-exist")).toBeNull();
  });

  test("upsert that shrinks below the bound drops the stale blob", async () => {
    await store.appendTranscriptEvents(sid, [
      entry("big-1", "now small", { type: "tool_use", toolName: "Bash" }),
    ]);
    const raw = new Database(dbPath, { readonly: true });
    try {
      const blob = raw
        .query(
          "SELECT id FROM transcript_blobs WHERE session_id = ? AND uuid = ?",
        )
        .get(sid, "big-1");
      expect(blob).toBeNull();
      const row = raw
        .query(
          "SELECT seq, full_ref FROM transcript_events WHERE session_id = ? AND uuid = ?",
        )
        .get(sid, "big-1") as { seq: number; full_ref: number | null };
      expect(row.seq).toBe(1); // still the original seq
      expect(row.full_ref).toBeNull();
    } finally {
      raw.close();
    }
    expect(store.getFullEntry(sid, "big-1")!.content).toBe("now small");
  });
});

describe("paging: readSince / readBefore", () => {
  const sid = "bks-paging";

  test("setup + readSince returns strictly-after entries ascending", async () => {
    await store.appendTranscriptEvents(
      sid,
      [1, 2, 3, 4, 5, 6].map((i) => entry(`p${i}`, `p ${i}`)),
    );
    const since = store.readSince(sid, 2, 3);
    expect(since.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(since.firstSeq).toBe(3);
    expect(since.lastSeq).toBe(5);
    expect(store.readSince(sid, 6, 10).entries).toEqual([]);
  });

  test("readBefore returns the LAST n entries below the cursor, ascending", async () => {
    const before = store.readBefore(sid, 5, 2);
    expect(before.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(before.firstSeq).toBe(3);
    expect(before.lastSeq).toBe(4);
    // Walking further back hits the start.
    const first = store.readBefore(sid, 3, 10);
    expect(first.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.readBefore(sid, 1, 10).entries).toEqual([]);
  });
});

describe("message-aware tail windows", () => {
  test("bounds engine handoffs without hydrating full blobs", async () => {
    const sid = "bks-handoff-window";
    await store.appendTranscriptEvents(sid, [
      entry("handoff-old-user", "old question", { type: "user" }),
      ...Array.from({ length: 520 }, (_, i) =>
        entry(`handoff-tool-${i}`, `step ${i}`, { type: "tool_use" }),
      ),
      entry("handoff-recent-user", "recent question", { type: "user" }),
      entry(
        "handoff-large-assistant",
        "x".repeat(TRANSCRIPT_DATA_MAX_BYTES * 2),
      ),
    ]);

    const page = store.readHandoffTail(sid);
    expect(page.entries.length).toBeLessThanOrEqual(512);
    expect(page.entries.some((row) => row.id === "handoff-old-user")).toBe(
      false,
    );
    expect(page.entries.some((row) => row.id === "handoff-recent-user")).toBe(
      true,
    );
    const assistant = page.entries.find(
      (row) => row.id === "handoff-large-assistant",
    )!;
    expect(assistant.content.length).toBeLessThan(
      TRANSCRIPT_DATA_MAX_BYTES * 2,
    );
    expect(assistant.contentClamped).toBe(true);
  });

  test("extends past the entry floor until it reaches conversation", async () => {
    const sid = "bks-tail-window-messages";
    await store.appendTranscriptEvents(sid, [
      entry("tw-u", "question", { type: "user" }),
      entry("tw-a", "answer"),
      ...Array.from({ length: 10 }, (_, i) =>
        entry(`tw-tool-${i}`, `step ${i}`, { type: "tool_use" }),
      ),
    ]);

    const page = store.readTailWindow(sid, {
      minEntries: 4,
      minMessages: 2,
      maxEntries: 20,
      maxEstimatedBytes: 100_000,
    });

    expect(page.entries).toHaveLength(12);
    expect(page.entries[0]).toMatchObject({ id: "tw-u", seq: 1 });
    expect(page.entries.at(-1)).toMatchObject({ id: "tw-tool-9", seq: 12 });
  });

  test("assistant rows alone do not satisfy a required user boundary", async () => {
    const sid = "bks-tail-window-user";
    await store.appendTranscriptEvents(sid, [
      entry("tu-u", "question", { type: "user" }),
      entry("tu-a0", "starting"),
      entry("tu-a1", "still working"),
      entry("tu-a2", "nearly done"),
      ...Array.from({ length: 6 }, (_, i) =>
        entry(`tu-tool-${i}`, `step ${i}`, { type: "tool_use" }),
      ),
    ]);

    const page = store.readTailWindow(sid, {
      minEntries: 2,
      minMessages: 2,
      minUserMessagesWithToolWork: 1,
      maxEntries: 20,
      maxEstimatedBytes: 100_000,
    });

    expect(page.entries[0]).toMatchObject({ id: "tu-u", type: "user" });
  });

  test("the estimated byte ceiling bounds extension past the entry floor", async () => {
    const sid = "bks-tail-window-bytes";
    await store.appendTranscriptEvents(sid, [
      entry("tb-u", "old question", { type: "user" }),
      entry("tb-a", "old answer"),
      ...Array.from({ length: 8 }, (_, i) =>
        entry(`tb-tool-${i}`, `step ${i}`, { type: "tool_use" }),
      ),
    ]);

    const page = store.readTailWindow(sid, {
      minEntries: 3,
      minMessages: 2,
      minUserMessagesWithToolWork: 1,
      maxEntries: 20,
      maxEstimatedBytes: 40,
      weigh: () => 10,
    });

    expect(page.entries.map((row) => row.id)).toEqual([
      "tb-tool-4",
      "tb-tool-5",
      "tb-tool-6",
      "tb-tool-7",
    ]);
  });

  test("the row ceiling bounds a message-poor tail", async () => {
    const sid = "bks-tail-window-rows";
    await store.appendTranscriptEvents(sid, [
      entry("tr-u", "old question", { type: "user" }),
      ...Array.from({ length: 10 }, (_, i) =>
        entry(`tr-tool-${i}`, `step ${i}`, { type: "tool_use" }),
      ),
    ]);

    const page = store.readTailWindow(sid, {
      minEntries: 2,
      minMessages: 2,
      minUserMessagesWithToolWork: 1,
      maxEntries: 5,
      maxEstimatedBytes: 100_000,
    });

    expect(page.entries).toHaveLength(5);
    expect(page.firstSeq).toBe(7);
    expect(page.lastSeq).toBe(11);
  });

  test("measures stored rows in UTF-8 bytes", async () => {
    const sid = "bks-tail-window-utf8";
    await store.appendTranscriptEvents(sid, [entry("utf8", "😀".repeat(20))]);
    let measured = 0;

    store.readTailWindow(sid, {
      minEntries: 1,
      minMessages: 2,
      maxEntries: 2,
      maxEstimatedBytes: 100_000,
      weigh: (_kind, bytes) => {
        measured = bytes;
        return bytes;
      },
    });

    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw
        .query(
          "SELECT length(CAST(data AS BLOB)) AS bytes FROM transcript_events WHERE session_id = ?",
        )
        .get(sid) as { bytes: number };
      expect(measured).toBe(row.bytes);
      expect(measured).toBeGreaterThan(20);
    } finally {
      raw.close();
    }
  });
});

describe("import-first gate + legacy import", () => {
  test("import then live-append: history seqs precede live seqs", async () => {
    const sid = "bks-import-order";
    const history = [1, 2, 3].map((i) => entry(`h${i}`, `hist ${i}`));
    const res = await store.importLegacyTranscript(
      sid,
      history,
      "mirror",
      4096,
    );
    expect(res).toEqual({ inserted: 3, updated: 0 });
    expect(store.hasImported(sid)).toBe(true);
    expect(store.needsImport(sid)).toBe(false);
    expect(store.getImportInfo(sid)).toEqual({
      importedAt: expect.any(Number),
      src: "mirror",
      watermark: 4096,
    });

    await store.appendTranscriptEvents(sid, [entry("live1", "live 1")]);
    expect(store.readTail(sid).entries.map((e) => [e.seq, e.id])).toEqual([
      [1, "h1"],
      [2, "h2"],
      [3, "h3"],
      [4, "live1"],
    ]);
  });

  test("re-import is idempotent (uuid upserts, seqs kept)", async () => {
    const sid = "bks-import-order";
    const res = await store.importLegacyTranscript(
      sid,
      [entry("h2", "hist 2 edited"), entry("h5", "hist 5 new")],
      "merged",
      8192,
    );
    expect(res).toEqual({ inserted: 1, updated: 1 });
    const tail = store.readTail(sid);
    expect(tail.entries.find((e) => e.id === "h2")!.seq).toBe(2);
    expect(tail.entries.find((e) => e.id === "h5")!.seq).toBe(5);
    expect(store.getImportInfo(sid)!.src).toBe("merged");
    expect(store.getImportInfo(sid)!.watermark).toBe(8192);
  });

  test("chunked import handles > 500 rows in one call", async () => {
    const sid = "bks-import-chunks";
    const many = Array.from({ length: 1203 }, (_, i) =>
      entry(`m${i}`, `m ${i}`),
    );
    const res = await store.importLegacyTranscript(sid, many, "mirror", null);
    expect(res.inserted).toBe(1203);
    expect(store.getLastSeq(sid)).toBe(1203);
  });

  test("appendTranscriptEvents runs ensureImported before assigning live seqs", async () => {
    const sid = "bks-gate";
    let calls = 0;
    const ensureImported = (s: string) => {
      calls++;
      (store as any).importLegacyTranscriptOwned(
        s,
        [entry("g1", "old 1"), entry("g2", "old 2")],
        "mirror",
        100,
      );
    };
    await store.appendTranscriptEvents(sid, [entry("g-live", "live")], {
      ensureImported,
    });
    expect(calls).toBe(1);
    expect(store.readTail(sid).entries.map((e) => [e.seq, e.id])).toEqual([
      [1, "g1"],
      [2, "g2"],
      [3, "g-live"],
    ]);
    // Gate is one-time: hook is not called again.
    await store.appendTranscriptEvents(sid, [entry("g-live2", "live 2")], {
      ensureImported,
    });
    expect(calls).toBe(1);
  });

  test("fresh session with no hook gets marked live-only", async () => {
    const sid = "bks-liveonly";
    await store.appendTranscriptEvents(sid, [entry("l1", "hello")]);
    expect(store.hasImported(sid)).toBe(true);
    expect(store.getImportInfo(sid)!.src).toBe("live-only");
  });

  test("a throwing ensureImported aborts the append (import-first invariant)", async () => {
    const sid = "bks-gate-throw";
    await expect(
      store.appendTranscriptEvents(sid, [entry("t1", "live")], {
        ensureImported: () => {
          throw new Error("legacy parse exploded");
        },
      }),
    ).rejects.toThrow("legacy parse exploded");
    expect(store.getLastSeq(sid)).toBe(0);
    expect(store.needsImport(sid)).toBe(true);
  });
});

describe("bus + append hook", () => {
  test("append publishes affected entries with seqs via microtask fan-out", async () => {
    const sid = "bks-bus";
    const got: TranscriptBusEvent[] = [];
    const bad: string[] = [];
    const unsub1 = subscribeTranscript(sid, () => {
      bad.push("throw");
      throw new Error("subscriber boom");
    });
    const unsub2 = subscribeTranscript(sid, (ev) => got.push(ev));
    try {
      const res = await store.appendTranscriptEvents(sid, [
        entry("bus1", "hello"),
        entry("bus2", "world"),
      ]);
      expect(res!.lastSeq).toBe(2);
      // The async projection boundary yields after post-commit fan-out.
      expect(got.length).toBe(1);
      expect(got[0].firstSeq).toBe(1);
      expect(got[0].lastSeq).toBe(2);
      expect(got[0].entries.map((e: SeqEntry) => [e.seq, e.content])).toEqual([
        [1, "hello"],
        [2, "world"],
      ]);
      expect(bad).toEqual(["throw"]); // throwing sibling ran and was isolated
    } finally {
      unsub1();
      unsub2();
    }
  });

  test("upsert republishes with the ORIGINAL seq", async () => {
    const sid = "bks-bus";
    const got: TranscriptBusEvent[] = [];
    const unsub = subscribeTranscript(sid, (ev) => got.push(ev));
    try {
      await store.appendTranscriptEvents(sid, [entry("bus1", "hello v2")]);
      await tick();
      expect(got.length).toBe(1);
      expect(got[0].firstSeq).toBe(1);
      expect(got[0].lastSeq).toBe(1);
      expect(got[0].entries[0].content).toBe("hello v2");
    } finally {
      unsub();
    }
  });

  test("append hook fires post-commit; a rejected hook never breaks appends", async () => {
    const sid = "bks-hook";
    const seen: [string, number][] = [];
    setAppendHook(async (sessionId, entries) => {
      seen.push([sessionId, entries.length]);
      throw new Error("hook boom");
    });
    try {
      const res = await store.appendTranscriptEvents(sid, [
        entry("hk1", "user msg", { type: "user" }),
      ]);
      expect(res!.inserted).toBe(1);
      await Promise.resolve();
      expect(seen).toEqual([[sid, 1]]);
    } finally {
      setAppendHook(null);
    }
  });
});

describe("deleteSessionTranscript", () => {
  test("removes events, blobs and session row; import gate re-arms", async () => {
    const sid = "bks-delete";
    await store.appendTranscriptEvents(sid, [
      entry("d1", "x".repeat(100_000)), // forces a blob
      entry("d2", "small"),
    ]);
    expect(store.getLastSeq(sid)).toBe(2);

    await store.deleteSessionTranscript(sid);
    expect(store.getLastSeq(sid)).toBe(0);
    expect(store.readTail(sid).entries).toEqual([]);
    expect(store.getFullEntry(sid, "d1")).toBeNull();
    expect(store.needsImport(sid)).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    try {
      expect(
        raw
          .query(
            "SELECT COUNT(*) AS n FROM transcript_blobs WHERE session_id = ?",
          )
          .get(sid),
      ).toEqual({ n: 0 });
      expect(
        raw
          .query(
            "SELECT COUNT(*) AS n FROM transcript_events WHERE session_id = ?",
          )
          .get(sid),
      ).toEqual({ n: 0 });
    } finally {
      raw.close();
    }

    // A later append starts a fresh dense sequence.
    await store.appendTranscriptEvents(sid, [entry("d3", "fresh start")]);
    expect(store.readTail(sid).entries.map((e) => e.seq)).toEqual([1]);
  });
});

describe("transcript outline and random-access ranges", () => {
  test("indexes display roles without shipping content", async () => {
    const sid = "bks-outline";
    await store.appendTranscriptEvents(sid, [
      entry("context", "private context", {
        type: "system",
        contextInjection: { source: "repos" },
      }),
      entry("wait", "private wait context", {
        type: "system",
        noticeKind: "context-injection",
        contextInjection: { source: "background-wait", turnId: "wait-turn" },
      }),
      entry("human", "Please investigate", { type: "user" }),
      entry("tool", "Using Read", {
        type: "tool_use",
        toolUseId: "call-1",
        toolName: "Read",
      }),
      entry("result", "large result", {
        type: "tool_result",
        toolUseId: "call-1",
      }),
      entry("answer", "Done"),
      entry("handoff", "[GitHub] <!--os:review-handoff-->\nReview PR #42", {
        type: "user",
      }),
    ]);

    const outline = store.readTranscriptIndex(sid);
    expect(outline.entries.map((row) => row.role)).toEqual([
      "hidden",
      "user",
      "user",
      "tool_use",
      "tool_result",
      "assistant",
      "review_handoff",
    ]);
    expect(outline.entries[6]).toMatchObject({ reviewPrNumber: 42 });
    expect(outline.entries[1]).toMatchObject({
      id: "wait",
      seq: 2,
      contentLength: 0,
    });
    expect(outline.entries[2]).toMatchObject({
      id: "human",
      seq: 3,
      contentLength: "Please investigate".length,
    });
    expect(JSON.stringify(outline)).not.toContain("large result");
    expect(outline.firstSeq).toBe(1);
    expect(outline.lastSeq).toBe(7);
  });

  test("updates an old outline row in place when its role changes", async () => {
    const sid = "bks-outline-upsert";
    await store.appendTranscriptEvents(sid, [entry("same", "draft")]);
    const before = store.readTranscriptIndex(sid).entries[0];
    await store.appendTranscriptEvents(sid, [
      entry("same", "now a person", { type: "user" }),
    ]);
    const after = store.readTranscriptIndex(sid).entries[0];
    expect(after.seq).toBe(before.seq);
    expect(after.changeSeq).toBeGreaterThan(before.changeSeq);
    expect(after.role).toBe("user");
  });

  test("hydrates an inclusive span in bounded chunks", async () => {
    const sid = "bks-range";
    await store.appendTranscriptEvents(
      sid,
      Array.from({ length: 5 }, (_, index) =>
        entry(`range-${index + 1}`, `row ${index + 1}`),
      ),
    );
    const first = store.readRange(sid, 2, 5, 1, 2);
    expect(first.entries.map((row) => row.seq)).toEqual([2, 3]);
    expect(first.coveredThroughSeq).toBe(3);
    expect(first.complete).toBe(false);
    const second = store.readRange(sid, 2, 5, first.coveredThroughSeq, 2);
    expect(second.entries.map((row) => row.seq)).toEqual([4, 5]);
    expect(second.coveredThroughSeq).toBe(5);
    expect(second.complete).toBe(true);
  });

  test("paginates a range larger than the wire cap", async () => {
    const sid = "bks-range-large";
    await store.appendTranscriptEvents(
      sid,
      Array.from({ length: 501 }, (_, index) =>
        entry(`large-range-${index + 1}`, `row ${index + 1}`),
      ),
    );
    const first = store.readRange(sid, 1, 501, 0, 500);
    expect(first.entries).toHaveLength(500);
    expect(first.coveredThroughSeq).toBe(500);
    expect(first.complete).toBe(false);
    const last = store.readRange(sid, 1, 501, 500, 500);
    expect(last.entries.map((row) => row.seq)).toEqual([501]);
    expect(last.complete).toBe(true);
  });

  test("backfills existing canonical rows in bounded async batches", async () => {
    const sid = "bks-outline-backfill";
    await store.appendTranscriptEvents(
      sid,
      Array.from({ length: 250 }, (_, index) =>
        entry(`backfill-${index}`, "hello", { type: "user" }),
      ),
    );
    const raw = new Database(dbPath);
    raw.run("DELETE FROM transcript_outline WHERE session_id = ?", [sid]);
    raw.close();
    let yielded = false;
    setTimeout(() => {
      yielded = true;
    }, 0);
    await store.ensureTranscriptOutline(sid);
    const outline = store.readTranscriptIndex(sid);
    expect(outline.entries).toHaveLength(250);
    expect(outline.entries[0]).toMatchObject({
      id: "backfill-0",
      role: "user",
    });
    expect(yielded).toBe(true);
  });

  test("backfill preserves oversized row roles and original lengths", async () => {
    const sid = "bks-outline-full-blob";
    const content =
      "[GitHub] <!--os:review-handoff-->\nReview PR #42\n" +
      "x".repeat(100_000);
    await store.appendTranscriptEvents(sid, [
      entry("large-handoff", content, { type: "user" }),
    ]);
    const written = store.readTranscriptIndex(sid).entries[0];
    const raw = new Database(dbPath);
    raw.run("DELETE FROM transcript_outline WHERE session_id = ?", [sid]);
    raw.close();
    await store.ensureTranscriptOutline(sid);
    expect(store.readTranscriptIndex(sid).entries[0]).toEqual(written);
    expect(written).toMatchObject({
      role: "review_handoff",
      reviewPrNumber: 42,
      contentLength: content.length,
    });
  });
});
