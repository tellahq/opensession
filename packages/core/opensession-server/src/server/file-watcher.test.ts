import { afterAll, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pollTranscriptFile,
  startWatching,
  stopAllWatchesForClient,
  transcriptRev,
  type FilePollDeps,
  type WatchState,
} from "./file-watcher";
import { parseTranscriptFrom } from "./jsonl-parser";
import type { TranscriptEntry } from "./types";

const dir = mkdtempSync(join(tmpdir(), "file-watcher-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function wsStub() {
  return {
    sent: [] as string[],
    send(msg: string) {
      this.sent.push(msg);
    },
  };
}

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-07-01T10:00:00.000Z",
    message: { role: "user", content: text },
  });
}

function pollHarness(path: string) {
  const stat = statSync(path);
  const ws = wsStub();
  const notified: TranscriptEntry[][] = [];
  const fed: Array<{ entries: TranscriptEntry[]; reset: boolean }> = [];
  const state: WatchState = {
    path,
    sessionId: "bks-poll",
    lastMtime: stat.mtimeMs,
    lastByteOffset: stat.size,
    lastSize: stat.size,
    lastDev: stat.dev,
    lastIno: stat.ino,
    viewers: new Set([ws]),
    interval: null,
  };
  const deps: FilePollDeps = {
    parseFrom: parseTranscriptFrom,
    notify: (_sessionId, entries) => notified.push(entries),
    feed: (_sessionId, entries, reset = false) => fed.push({ entries, reset }),
  };
  return { state, deps, ws, notified, fed };
}

describe("startWatching", () => {
  it("replays the requested backlog when joining an existing path watch", () => {
    const path = join(dir, "existing-watch.jsonl");
    writeFileSync(path, `${userLine("u-opening", "Opening prompt")}\n`);

    const first = wsStub();
    const second = wsStub();

    try {
      startWatching(path, first, Bun.file(path).size, "bks-test");
      startWatching(path, second, 0, "bks-test");

      expect(second.sent).toHaveLength(1);
      const msg = JSON.parse(second.sent[0]);
      expect(msg.type).toBe("transcript_append");
      expect(msg.sessionId).toBe("bks-test");
      expect(msg.entries.map((e: { content: string }) => e.content)).toEqual([
        "Opening prompt",
      ]);
      // The replay carries the reconnect-resume cursor: where it ends in the
      // file, and which file that was (echoed back as sinceOffset/sinceRev).
      expect(msg.endOffset).toBe(Bun.file(path).size);
      expect(msg.rev).toBe(transcriptRev(path));
    } finally {
      stopAllWatchesForClient(first);
      stopAllWatchesForClient(second);
    }
  });

  it("transcriptRev tells mirror files apart (engine-rotation safety)", () => {
    // An offset into the old engine session's mirror must never be applied to
    // the new one — the rev is what the watch handler compares.
    expect(transcriptRev("/x/ses_one.jsonl")).not.toBe(
      transcriptRev("/x/ses_two.jsonl"),
    );
    expect(transcriptRev("/x/ses_one.jsonl")).toBe(
      transcriptRev("/x/ses_one.jsonl"),
    );
  });
});

describe("pollTranscriptFile", () => {
  it("retries the exact range after a transient read failure", () => {
    const path = join(dir, "retry-read.jsonl");
    writeFileSync(path, "");
    const harness = pollHarness(path);
    appendFileSync(path, `${userLine("retry", "Read me twice")}\n`);
    let attempts = 0;
    const deps: FilePollDeps = {
      ...harness.deps,
      parseFrom(file, offset) {
        attempts++;
        if (attempts === 1)
          return { entries: [], newOffset: offset, ok: false };
        return parseTranscriptFrom(file, offset);
      },
    };

    pollTranscriptFile(harness.state, deps);
    expect(harness.state.lastByteOffset).toBe(0);
    expect(harness.ws.sent).toHaveLength(0);
    pollTranscriptFile(harness.state, deps);
    expect(attempts).toBe(2);
    expect(JSON.parse(harness.ws.sent[0]).entries[0].content).toBe(
      "Read me twice",
    );
    expect(harness.notified).toHaveLength(1);
    expect(harness.fed).toHaveLength(1);
    expect(harness.fed[0].reset).toBe(false);
  });

  it("does not consume a partial final line", () => {
    const path = join(dir, "partial-line.jsonl");
    writeFileSync(path, "");
    const harness = pollHarness(path);
    appendFileSync(path, userLine("partial", "Complete later"));

    pollTranscriptFile(harness.state, harness.deps);
    expect(harness.state.lastByteOffset).toBe(0);
    expect(harness.ws.sent).toHaveLength(0);
    appendFileSync(path, "\n");
    pollTranscriptFile(harness.state, harness.deps);
    expect(JSON.parse(harness.ws.sent[0]).entries[0].content).toBe(
      "Complete later",
    );
  });

  it("resets to byte zero and sends init after in-place truncation", () => {
    const path = join(dir, "truncate.jsonl");
    writeFileSync(
      path,
      `${userLine("old-long-id", "old content is longer")}\n`,
    );
    const harness = pollHarness(path);
    writeFileSync(path, `${userLine("new", "new")}\n`);

    pollTranscriptFile(harness.state, harness.deps);
    const frame = JSON.parse(harness.ws.sent[0]);
    expect(frame.type).toBe("transcript_init");
    expect(
      frame.entries.map((entry: TranscriptEntry) => entry.content),
    ).toEqual(["new"]);
    expect(harness.fed[0].reset).toBe(true);
  });

  it("detects atomic replacement even when the replacement is not larger", () => {
    const path = join(dir, "replace.jsonl");
    const replacement = join(dir, "replace.next.jsonl");
    writeFileSync(path, `${userLine("old", "old")}\n`);
    const harness = pollHarness(path);
    const oldRev = transcriptRev(path);
    writeFileSync(replacement, `${userLine("new", "new")}\n`);
    renameSync(replacement, path);

    pollTranscriptFile(harness.state, harness.deps);
    const frame = JSON.parse(harness.ws.sent[0]);
    expect(frame.type).toBe("transcript_init");
    expect(frame.entries[0].content).toBe("new");
    expect(frame.rev).not.toBe(oldRev);
    expect(harness.fed[0].reset).toBe(true);
  });

  it("retries a partial replacement, then resets once its first line completes", () => {
    const path = join(dir, "partial-replace.jsonl");
    const replacement = join(dir, "partial-replace.next.jsonl");
    writeFileSync(path, `${userLine("old", "old")}\n`);
    const harness = pollHarness(path);
    writeFileSync(replacement, userLine("new", "new"));
    renameSync(replacement, path);

    pollTranscriptFile(harness.state, harness.deps);
    expect(harness.ws.sent).toHaveLength(0);
    expect(harness.fed).toHaveLength(0);
    appendFileSync(path, "\n");
    pollTranscriptFile(harness.state, harness.deps);
    expect(JSON.parse(harness.ws.sent[0]).type).toBe("transcript_init");
    expect(harness.fed[0].reset).toBe(true);
  });

  it("treats an empty replacement as an authoritative empty init", () => {
    const path = join(dir, "empty-replace.jsonl");
    const replacement = join(dir, "empty-replace.next.jsonl");
    writeFileSync(path, `${userLine("old", "old")}\n`);
    const harness = pollHarness(path);
    writeFileSync(replacement, "");
    renameSync(replacement, path);

    pollTranscriptFile(harness.state, harness.deps);
    const frame = JSON.parse(harness.ws.sent[0]);
    expect(frame.type).toBe("transcript_init");
    expect(frame.entries).toEqual([]);
    expect(harness.fed[0]).toEqual({ entries: [], reset: true });
  });
});
