import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "./transcript-store";
import {
  startTranscriptWatch,
  TRANSCRIPT_RESUME_MAX_BYTES,
  TRANSCRIPT_RESUME_MAX_ENTRIES,
} from "./transcript-watch";
import {
  clampV2InitEntries,
  transcriptHistoryFrame,
  TRANSCRIPT_HISTORY_MAX_ENTRIES,
  transcriptHistoryLimit,
} from "./transcript-wire";
import { prepareEntriesForWire } from "./jsonl-parser";
import {
  appendSessionFeed,
  resumeSessionFeed,
  FEED_RESUME_MAX_BYTES,
  FEED_RESUME_MAX_FRAMES,
} from "./session-feed";
import { broadcastToSession, sessionWatchers } from "./ws-hub";
import { SessionListStore } from "./session-list-sqlite";
import { sessionListRow } from "./routes/sessions";
import type { TranscriptEntry, UnifiedSession } from "./types";

// Pre-compression UTF-8 JSON, not JS string length or heap usage.
const WIRE_BUDGETS = {
  toolHeavyOpenBytes: 1024 * 1024,
  toolHeavyOpenRows: 1400,
  historyPageBytes: 512 * 1024,
  streamBatchBytes: 2048,
  sidebar500Bytes: 384 * 1024,
  sidebarUpdateBytes: 1024,
} as const;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const timestamp = "2026-09-01T00:00:00.000Z";
function row(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return { id, type, content, timestamp, ...extra };
}
function setup(entries: TranscriptEntry[]) {
  const dir = mkdtempSync(join(tmpdir(), "wire-budgets-"));
  const store = new TranscriptStore(join(dir, "transcripts.db"));
  const sessionId = "wire-fixture";
  store.appendTranscriptEvents(sessionId, entries);
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, sessionId };
}
async function open(state: ReturnType<typeof setup>, sinceChangeSeq?: number) {
  const sent: string[] = [];
  const handle = await startTranscriptWatch({
    ...state,
    socket: {
      send: (payload) => {
        sent.push(payload);
      },
    },
    subscribe: () => () => {},
    isCurrent: () => true,
    prepareEntries: (entries) =>
      prepareEntriesForWire(entries) as typeof entries,
    clampSnapshot: clampV2InitEntries,
    sinceChangeSeq,
  });
  cleanups.push(() => handle.unsubscribe());
  return sent;
}
function longSession() {
  const entries: TranscriptEntry[] = [];
  const output = "build output ✓\n".repeat(5000);
  const edit = "export const example = 1;\n".repeat(3000);
  const image = "data:image/png;base64," + "A".repeat(100_000);
  for (let turn = 0; turn < 200; turn++) {
    const prefix = `turn-${turn}`;
    entries.push(
      row(`${prefix}-user`, "user", "Please update example.ts"),
      row(`${prefix}-note`, "assistant", "Inspecting the file. ".repeat(250)),
      row(`${prefix}-call`, "tool_use", "Using Edit", {
        toolName: "Edit",
        toolUseId: prefix,
        toolInput: {
          file_path: "example.ts",
          old_string: edit,
          new_string: edit + "// done",
        },
      }),
      row(`${prefix}-result`, "tool_result", output, { toolUseId: prefix }),
      row(`${prefix}-image`, "user", "Screenshot", { images: [image] }),
      row(
        `${prefix}-answer`,
        "assistant",
        "Updated example.ts and verified the build.",
      ),
    );
  }
  return entries;
}

describe("encoded session wire budgets", () => {
  test("history request limits cannot expand pages", () => {
    expect(transcriptHistoryLimit()).toBe(40);
    expect(transcriptHistoryLimit(100_000)).toBe(
      TRANSCRIPT_HISTORY_MAX_ENTRIES,
    );
    expect(transcriptHistoryLimit(-10)).toBe(1);
    expect(transcriptHistoryLimit(Number.NaN)).toBe(40);
  });

  test("tool-heavy cold open and history preserve hydration, not raw bodies", async () => {
    const fixture = longSession();
    const state = setup(fixture);
    const sent = await open(state);
    expect(sent).toHaveLength(1);
    console.info(
      "wire budget: cold open",
      Buffer.byteLength(sent[0]!),
      "bytes",
    );
    const init = JSON.parse(sent[0]!);
    expect(Buffer.byteLength(sent[0]!)).toBeLessThanOrEqual(
      WIRE_BUDGETS.toolHeavyOpenBytes,
    );
    expect(init.entries.length).toBeLessThanOrEqual(
      WIRE_BUDGETS.toolHeavyOpenRows,
    );
    expect(init.truncated).toBe(true);
    expect(
      init.entries.filter((entry: TranscriptEntry) => entry.type === "user")
        .length,
    ).toBeGreaterThanOrEqual(50);
    const page = state.store.readBefore(
      state.sessionId,
      init.firstSeq,
      TRANSCRIPT_HISTORY_MAX_ENTRIES,
    );
    const history = transcriptHistoryFrame(state.sessionId, {
      ...page,
      entries: prepareEntriesForWire(page.entries) as typeof page.entries,
    });
    console.info("wire budget: history", bytes(history), "bytes");
    expect(history.entries).toHaveLength(TRANSCRIPT_HISTORY_MAX_ENTRIES);
    expect(bytes(history)).toBeLessThanOrEqual(WIRE_BUDGETS.historyPageBytes);
    for (const entry of [
      ...init.entries,
      ...history.entries,
    ] as TranscriptEntry[]) {
      if (entry.type === "tool_result")
        expect(entry.content.length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(entry)).not.toContain("data:image/png;base64,");
      expect(JSON.stringify(entry)).not.toContain("export const example = 1;");
    }
    expect(
      state.store.getFullEntry(state.sessionId, "turn-0-result")?.content,
    ).toBe(fixture[3]!.content);
    expect(
      state.store.getFullEntry(state.sessionId, "turn-0-call")?.toolInput,
    ).toEqual(fixture[2]!.toolInput);
  });

  test("durable resume uses deltas for small gaps and snapshots at row or byte overflow", async () => {
    const small = setup([
      row("a", "assistant", "before"),
      row("b", "assistant", "after"),
    ]);
    const delta = await open(small, 1);
    expect(JSON.parse(delta[0]!).type).toBe("transcript_append");
    expect(JSON.parse(delta[0]!).entries).toHaveLength(1);
    expect(Buffer.byteLength(delta[0]!)).toBeLessThanOrEqual(
      TRANSCRIPT_RESUME_MAX_BYTES,
    );
    const countOverflow = setup(
      Array.from({ length: TRANSCRIPT_RESUME_MAX_ENTRIES + 1 }, (_, i) =>
        row(`row-${i}`, "assistant", "small"),
      ),
    );
    expect(JSON.parse((await open(countOverflow, 0))[0]!).type).toBe(
      "transcript_init",
    );
    const byteOverflow = setup(
      Array.from({ length: 40 }, (_, i) =>
        row(`large-${i}`, "tool_result", "界".repeat(9_000)),
      ),
    );
    expect(
      bytes(byteOverflow.store.readTail(byteOverflow.sessionId, 40).entries),
    ).toBeGreaterThan(TRANSCRIPT_RESUME_MAX_BYTES);
    expect(JSON.parse((await open(byteOverflow, 0))[0]!).type).toBe(
      "transcript_init",
    );
  });

  test("live token batches stay incremental; feed resume caps frames and UTF-8 bytes", () => {
    const sessionId = "wire-live";
    const start = appendSessionFeed(sessionId, {
      type: "stream_start",
      sessionId,
    });
    for (let i = 0; i < FEED_RESUME_MAX_FRAMES; i++) {
      const frame = appendSessionFeed(sessionId, {
        type: "stream_text",
        sessionId,
        text: "token ✓ ".repeat(16),
      });
      expect(bytes(frame)).toBeLessThanOrEqual(WIRE_BUDGETS.streamBatchBytes);
      expect(frame.event).not.toHaveProperty("entries");
    }
    const replay = resumeSessionFeed(sessionId, start.feedSeq, start.feedEpoch);
    expect(replay.frames).toHaveLength(FEED_RESUME_MAX_FRAMES);
    expect(replay.snapshot.active).toBeNull();
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "next",
    });
    const fallback = resumeSessionFeed(
      sessionId,
      start.feedSeq,
      start.feedEpoch,
    );
    expect(fallback.frames).toHaveLength(0);
    expect(fallback.snapshot.active?.text).toEndWith("next");
    const bigId = "wire-live-bytes";
    const bigStart = appendSessionFeed(bigId, {
      type: "stream_start",
      sessionId: bigId,
    });
    for (let i = 0; i < 12; i++)
      appendSessionFeed(bigId, {
        type: "stream_text",
        sessionId: bigId,
        text: "界".repeat(30_000),
      });
    expect(12 * bytes("界".repeat(30_000))).toBeGreaterThan(
      FEED_RESUME_MAX_BYTES,
    );
    expect(
      resumeSessionFeed(bigId, bigStart.feedSeq, bigStart.feedEpoch).frames,
    ).toHaveLength(0);
    appendSessionFeed(sessionId, { type: "stream_done", sessionId });
    appendSessionFeed(bigId, { type: "stream_done", sessionId: bigId });
  });

  test("live tools omit bulk output, edit bodies and base64 for both socket protocols", () => {
    const sessionId = "wire-tool-live";
    const sent: string[] = [];
    sessionWatchers.set(
      sessionId,
      new Set([
        {
          data: {
            watchingSessionId: sessionId,
            user: null,
            supportsFeed: false,
          },
          send: (payload: string) => {
            sent.push(payload);
          },
        },
        {
          data: {
            watchingSessionId: sessionId,
            user: null,
            supportsFeed: true,
          },
          send: (payload: string) => {
            sent.push(payload);
          },
        },
      ]),
    );
    cleanups.push(() => sessionWatchers.delete(sessionId));
    const fixture = longSession();
    for (const entry of [fixture[2]!, fixture[3]!]) {
      broadcastToSession(sessionId, {
        type:
          entry.type === "tool_use" ? "stream_tool_use" : "stream_tool_result",
        sessionId,
        entry: {
          ...entry,
          images: ["data:image/png;base64," + "A".repeat(100_000)],
        },
      });
    }
    expect(sent).toHaveLength(4);
    for (const payload of sent) {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(
        WIRE_BUDGETS.streamBatchBytes,
      );
      expect(payload).not.toContain("export const example = 1;");
      expect(payload).not.toContain("data:image/png;base64,");
      const parsed = JSON.parse(payload);
      const entry = (parsed.event ?? parsed).entry;
      if (entry.type === "tool_result") {
        expect(entry.contentClamped).toBe(true);
        expect(entry.contentLength).toBe(fixture[3]!.content.length);
      }
    }
  });

  test("sidebar projection excludes archives and updates carry one compact row", () => {
    const store = new SessionListStore(":memory:");
    cleanups.push(() => store.close());
    const sessions: UnifiedSession[] = Array.from(
      { length: 1500 },
      (_, i) =>
        ({
          id: `session-${i}`,
          source: "opensession",
          title: `Update example ${i}`,
          createdBy: "Example",
          startedBy: "Example",
          branch: "feature",
          worktreeDir: null,
          transcriptPath: "/example/transcript.jsonl",
          createdAt: timestamp,
          lastActivity: timestamp,
          isRunning: false,
          archived: i >= 500,
          presetNote: "engine context".repeat(5000),
          mcpServers: ["example"],
        }) as UnifiedSession,
    );
    store.upsertMany(sessions);
    const listed = store.listSidebar().map(sessionListRow);
    console.info("wire budget: 500 sidebar rows", bytes(listed), "bytes");
    expect(listed).toHaveLength(500);
    expect(listed.every((row) => !row.archived)).toBe(true);
    expect(bytes(listed)).toBeLessThanOrEqual(WIRE_BUDGETS.sidebar500Bytes);
    expect(store.list("only")).toHaveLength(1000);
    const update = {
      type: "session_row",
      row: sessionListRow({ ...sessions[0]!, isRunning: true }),
    };
    expect(bytes(update)).toBeLessThanOrEqual(WIRE_BUDGETS.sidebarUpdateBytes);
    expect(update.row).not.toHaveProperty("presetNote");
    expect(update.row).not.toHaveProperty("transcriptPath");
  });
});
