import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entriesForWire,
  extractImageMarkers,
  extractImplicitMedia,
  extractVideoMarkers,
  parseJsonlLinesAsync,
  parseTranscript,
  parseTranscriptAsync,
  parseTranscriptFrom,
  parseTranscriptTail,
  parseTranscriptWindow,
  sanitizeTranscriptMediaEntry,
} from "./jsonl-parser";

let dir: string;
let fileCounter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jsonl-parser-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a transcript fixture to a unique temp file (unique paths also keep
 *  the module's mtime/size parse cache from ever colliding between tests). */
function writeFixture(lines: string[]): string {
  const path = join(dir, `transcript-${++fileCounter}.jsonl`);
  writeFileSync(path, lines.map((l) => l + "\n").join(""));
  return path;
}

function writeCodexFixture(lines: string[]): string {
  const path = join(dir, `rollout-${++fileCounter}-thread.jsonl`);
  writeFileSync(path, lines.map((l) => l + "\n").join(""));
  return path;
}

const TS = "2026-07-01T10:00:00.000Z";

function userLine(
  uuid: string,
  text: string,
  sourceMessageIds?: string[],
): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: TS,
    ...(sourceMessageIds?.length ? { sourceMessageIds } : {}),
    message: { role: "user", content: text },
  });
}

function assistantLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: TS,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function toolUseLine(uuid: string, toolUseId: string, command: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: TS,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolUseId, name: "Bash", input: { command } },
      ],
    },
  });
}

function toolResultLine(
  uuid: string,
  toolUseId: string,
  output: string,
): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: TS,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: output },
      ],
    },
  });
}

const BASIC_LINES = [
  userLine("u1", "Please list the files"),
  toolUseLine("a1", "toolu_001", "ls -la"),
  toolResultLine("u2", "toolu_001", "file-a.txt\nfile-b.txt"),
  assistantLine("a2", "There are two files."),
];

describe("entriesForWire", () => {
  const pinnedGoal =
    "[Pinned session goal — keep working toward it and note how this turn advanced it: Ship the stable sandbox flow.]";

  it("removes legacy pinned goals from stored user messages", () => {
    const [entry] = entriesForWire([
      {
        id: "legacy-user",
        type: "user",
        content: `What did Ramp report?\n\n${pinnedGoal}`,
        timestamp: TS,
      },
    ]);
    expect(entry.content).toBe("What did Ramp report?");
  });

  it("drops legacy goal-only user rows", () => {
    expect(
      entriesForWire([
        {
          id: "legacy-goal-only",
          type: "user",
          content: pinnedGoal,
          timestamp: TS,
        },
      ]),
    ).toEqual([]);
  });

  it("drops parser-only metadata after classifying an entry", () => {
    const [entry] = entriesForWire([
      {
        id: "recap",
        type: "system",
        content: "Work completed",
        timestamp: TS,
        requestId: "provider-request-id",
        noticeKind: "recap",
      },
    ]);

    expect(entry.notice?.kind).toBe("recap");
    expect("requestId" in entry).toBe(false);
    expect("noticeKind" in entry).toBe(false);
  });

  it("projects a background wait as a private turn boundary", () => {
    expect(
      entriesForWire([
        {
          id: "ordinary-context",
          type: "system",
          content: "private handoff",
          timestamp: TS,
          noticeKind: "context-injection",
          contextInjection: { source: "handoff", turnId: "turn-1" },
        },
        {
          id: "wait-context",
          type: "system",
          content: "private wait instructions",
          timestamp: TS,
          noticeKind: "context-injection",
          contextInjection: { source: "background-wait", turnId: "turn-2" },
          seq: 9,
          changeSeq: 12,
        },
      ]),
    ).toEqual([
      {
        id: "wait-context",
        type: "user",
        content: "",
        timestamp: TS,
        turnBoundary: true,
        seq: 9,
        changeSeq: 12,
      },
    ]);
  });
});

describe("parseTranscript", () => {
  it("parses basic user/assistant turns in order", () => {
    const path = writeFixture([
      userLine("u1", "Hello there"),
      assistantLine("a1", "Hi! How can I help?"),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(2);
    expect(entries[0].type).toBe("user");
    expect(entries[0].content).toBe("Hello there");
    expect(entries[1].type).toBe("assistant");
    expect(entries[1].content).toBe("Hi! How can I help?");
  });

  it("pairs tool_use with its tool_result via toolUseId", () => {
    const path = writeFixture(BASIC_LINES);
    const entries = parseTranscript(path);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    const use = entries[1];
    const result = entries[2];
    expect(use.toolName).toBe("Bash");
    expect(use.toolUseId).toBe("toolu_001");
    expect(result.toolUseId).toBe(use.toolUseId);
    expect(result.content).toContain("file-a.txt");
  });

  it("skips a corrupt/truncated line mid-file without throwing and parses the rest", () => {
    const path = writeFixture([
      userLine("u1", "first"),
      '{"type":"assistant","message":{"content"', // truncated JSON
      "not json at all",
      assistantLine("a1", "last"),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(2);
    expect(entries[0].content).toBe("first");
    expect(entries[1].content).toBe("last");
  });

  it("ignores non-message line types", () => {
    const path = writeFixture([
      JSON.stringify({ type: "summary", summary: "a summary line" }),
      userLine("u1", "hello"),
      JSON.stringify({ type: "system", content: "system noise" }),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("user");
  });

  it("drops harness-injected system-reminder user lines", () => {
    const path = writeFixture([
      userLine("u1", "<system-reminder>internal note</system-reminder>"),
      userLine("u2", "real question"),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("real question");
  });

  it("maps runner-notice user lines to system entries (both content shapes)", () => {
    const blockLine = JSON.stringify({
      type: "user",
      uuid: "n1",
      timestamp: TS,
      message: {
        role: "user",
        // Blocks shape — what transcriptLineRunnerNotice writes.
        content: [
          {
            type: "text",
            text: '<runner-notice>Claude usage limit hit on account "A"; switched to "B" and retrying.</runner-notice>',
          },
        ],
      },
    });
    const path = writeFixture([
      userLine("u1", "real question"),
      blockLine,
      userLine(
        "n2",
        "<runner-notice>Transient engine error — retrying once.</runner-notice>",
      ),
    ]);
    const entries = parseTranscript(path);
    expect(entries.map((e) => e.type)).toEqual(["user", "system", "system"]);
    expect(entries[1].content).toBe(
      'Claude usage limit hit on account "A"; switched to "B" and retrying.',
    );
    expect(entries[2].content).toBe("Transient engine error — retrying once.");
  });

  it("maps compaction-summary lines to system entries tagged for the classifier", () => {
    const path = writeFixture([
      userLine(
        "prt_sum1",
        "<compaction-summary>## Objective\nShip the sidebar refactor.</compaction-summary>",
      ),
    ]);
    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "sys-prt_sum1",
      type: "system",
      noticeKind: "compaction",
      content: "## Objective\nShip the sidebar refactor.",
    });
  });

  it("preserves structured answered-ask data beside the markdown fallback", () => {
    const ask = {
      version: 1,
      questions: [
        {
          header: "Demo choice",
          question: "Which version?",
          options: [{ label: "Compact" }, { label: "Detailed" }],
          answer: "Compact",
        },
      ],
    };
    const path = writeFixture([
      JSON.stringify({
        type: "user",
        uuid: "ask1",
        timestamp: TS,
        ask,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<ask-record>Answered: Compact\n**Demo choice: Which version?**\n\n- **A. Compact**\n- B. Detailed</ask-record>",
            },
          ],
        },
      }),
    ]);
    expect(parseTranscript(path)[0]).toMatchObject({
      id: "sys-ask1",
      type: "system",
      noticeKind: "ask",
      ask,
    });
  });

  it("maps recap lines to system entries with the recap flag", () => {
    const path = writeFixture([
      userLine(
        "rc1",
        "<recap>We shipped the recap feature and pushed to main. Next: open a session to see it.</recap>",
      ),
    ]);
    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "sys-rc1",
      type: "system",
      noticeKind: "recap",
      content:
        "We shipped the recap feature and pushed to main. Next: open a session to see it.",
    });
  });

  it("returns [] for an empty file", () => {
    const path = writeFixture([]);
    expect(parseTranscript(path)).toEqual([]);
  });

  it("returns [] for a missing file", () => {
    expect(parseTranscript(join(dir, "does-not-exist.jsonl"))).toEqual([]);
  });

  it("produces identical output through the yielding parser", async () => {
    const lines = [
      userLine("u1", "first"),
      toolUseLine("a1", "toolu_001", "ls"),
      "not json",
      toolResultLine("u2", "toolu_001", "done"),
      assistantLine("a2", "last"),
    ];
    const path = writeFixture(lines);

    expect(await parseJsonlLinesAsync(lines, 1)).toEqual(parseTranscript(path));
    expect(await parseTranscriptAsync(path)).toEqual(parseTranscript(path));
  });

  it("returns [] asynchronously for a missing file", async () => {
    expect(
      await parseTranscriptAsync(join(dir, "does-not-exist-async.jsonl")),
    ).toEqual([]);
  });
});

describe("parseTranscriptTail", () => {
  it("returns the whole transcript untruncated when it fits the window", () => {
    const path = writeFixture(BASIC_LINES);
    const { entries, truncated } = parseTranscriptTail(path);
    expect(truncated).toBe(false);
    expect(entries).toEqual(parseTranscript(path));
  });

  it("returns a suffix of the full parse when the file exceeds the window", () => {
    // Many turns with chunky content so a small byte window can't hold them all.
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(userLine(`u${i}`, `question ${i} ` + "x".repeat(400)));
      lines.push(assistantLine(`a${i}`, `answer ${i} ` + "y".repeat(400)));
    }
    const path = writeFixture(lines);
    const full = parseTranscript(path);
    const { entries, truncated } = parseTranscriptTail(path, 1024, 5);
    expect(truncated).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.length).toBeLessThan(full.length);
    // Invariant: tail entries are exactly the trailing slice of a full parse.
    expect(entries).toEqual(full.slice(full.length - entries.length));
  });

  it("handles an empty file", () => {
    const path = writeFixture([]);
    const res = parseTranscriptTail(path);
    expect(res.entries).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("handles a missing file", () => {
    const res = parseTranscriptTail(join(dir, "nope.jsonl"));
    expect(res.entries).toEqual([]);
    expect(res.truncated).toBe(false);
  });
});

describe("parseTranscriptWindow", () => {
  it("pages backwards from the tail's startOffset until the whole file is covered", () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(userLine(`u${i}`, `question ${i} ` + "x".repeat(400)));
      lines.push(assistantLine(`a${i}`, `answer ${i} ` + "y".repeat(400)));
    }
    const path = writeFixture(lines);
    const full = parseTranscript(path);
    const tail = parseTranscriptTail(path, 1024, 5);
    expect(tail.truncated).toBe(true);
    expect(tail.startOffset).toBeGreaterThan(0);

    // Walk pages until the window reports it reached the start of the file.
    let collected = [...tail.entries];
    let cursor = tail.startOffset;
    let truncated = true;
    let guard = 0;
    while (truncated && guard++ < 200) {
      const page = parseTranscriptWindow(path, cursor, 1024, 5);
      expect(page.startOffset).toBeLessThan(cursor);
      collected = [...page.entries, ...collected];
      cursor = page.startOffset;
      truncated = page.truncated;
    }
    // Pages + tail reassemble the exact full parse, in order, no dupes.
    expect(collected).toEqual(full);
    expect(cursor).toBe(0);
  });

  it("returns empty at offset 0 and for a missing file", () => {
    const path = writeFixture(BASIC_LINES);
    expect(parseTranscriptWindow(path, 0).entries).toEqual([]);
    expect(parseTranscriptWindow(join(dir, "nope.jsonl"), 100).entries).toEqual(
      [],
    );
  });

  it("keeps an entry floor through fat tool-result regions despite the soft cap", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(userLine(`h${i}`, `head ${i}`));
    // Fat region: each line ~200KB — a 256KB soft cap alone fits one entry.
    for (let i = 0; i < 12; i++)
      lines.push(assistantLine(`fat${i}`, "z".repeat(200 * 1024)));
    const path = writeFixture(lines);
    const end = statSync(path).size;
    const page = parseTranscriptWindow(path, end, 64 * 1024, 8, 256 * 1024);
    // Floor = ceil(minEntries/4): the window must keep growing past the soft
    // cap until the page is actually useful, not ship a 1-entry page.
    expect(page.entries.length).toBeGreaterThanOrEqual(2);
  });

  it("trims a growth overshoot back near the target page size, cursor exact", () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i++)
      lines.push(userLine(`t${i}`, `msg ${i} ` + "x".repeat(50)));
    const path = writeFixture(lines);
    const full = parseTranscript(path);
    const tail = parseTranscriptTail(path, 512, 4);
    expect(tail.truncated).toBe(true);
    let collected = [...tail.entries];
    let cursor = tail.startOffset;
    let truncated = true;
    let guard = 0;
    while (truncated && guard++ < 200) {
      // Tiny initial window: growth quadruples, so an untrimmed page would
      // overshoot to several times minEntries.
      const page = parseTranscriptWindow(path, cursor, 512, 10);
      expect(page.entries.length).toBeLessThanOrEqual(30);
      expect(page.startOffset).toBeLessThan(cursor);
      collected = [...page.entries, ...collected];
      cursor = page.startOffset;
      truncated = page.truncated;
    }
    // Trimmed pages + tail still reassemble the exact full parse — the
    // dropped-line byte accounting must keep the cursor gap-free.
    expect(collected).toEqual(full);
    expect(cursor).toBe(0);
  });

  it("tail startOffset is 0 for an untruncated file", () => {
    const path = writeFixture(BASIC_LINES);
    const res = parseTranscriptTail(path);
    expect(res.truncated).toBe(false);
    expect(res.startOffset).toBe(0);
  });
});

describe("parseTranscriptFrom", () => {
  it("returns everything from offset 0 with newOffset = file size", () => {
    const path = writeFixture(BASIC_LINES);
    const { entries, newOffset } = parseTranscriptFrom(path, 0);
    const full = parseTranscript(path);
    expect(entries.map((e) => e.id)).toEqual(full.map((e) => e.id));
    expect(newOffset).toBe(Bun.file(path).size);
  });

  it("returns only entries after a line-boundary byte offset (suffix of full parse)", () => {
    const path = writeFixture(BASIC_LINES);
    // Offset = end of the first two lines (each line is terminated by "\n").
    const offset =
      Buffer.byteLength(BASIC_LINES[0], "utf-8") +
      Buffer.byteLength(BASIC_LINES[1], "utf-8") +
      2;
    const { entries, newOffset } = parseTranscriptFrom(path, offset);
    const full = parseTranscript(path);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => `${e.type}:${e.content}`)).toEqual(
      full
        .slice(full.length - entries.length)
        .map((e) => `${e.type}:${e.content}`),
    );
    // The first two lines' entries (user + tool_use) must NOT be present.
    expect(entries.some((e) => e.type === "tool_use")).toBe(false);
    expect(entries[0].type).toBe("tool_result");
    expect(newOffset).toBe(Bun.file(path).size);
  });

  it("supports incremental consumption: resume from newOffset after append", () => {
    const path = writeFixture([BASIC_LINES[0], BASIC_LINES[1]]);
    const first = parseTranscriptFrom(path, 0);
    expect(first.entries.length).toBe(2);
    // Append two more lines, resume from the returned offset.
    const appended = [BASIC_LINES[2], BASIC_LINES[3]];
    writeFileSync(path, appended.map((l) => l + "\n").join(""), { flag: "a" });
    const second = parseTranscriptFrom(path, first.newOffset);
    expect(second.entries.map((e) => e.type)).toEqual([
      "tool_result",
      "assistant",
    ]);
    expect(second.newOffset).toBe(Bun.file(path).size);
  });

  it("returns no entries when the offset is at or past the end of file", () => {
    const path = writeFixture(BASIC_LINES);
    const size = Bun.file(path).size;
    const atEnd = parseTranscriptFrom(path, size);
    expect(atEnd.entries).toEqual([]);
    expect(atEnd.newOffset).toBe(size);
    const pastEnd = parseTranscriptFrom(path, size + 100);
    expect(pastEnd.entries).toEqual([]);
    expect(pastEnd.newOffset).toBe(size + 100);
  });

  it("handles an empty file", () => {
    const path = writeFixture([]);
    const res = parseTranscriptFrom(path, 0);
    expect(res.entries).toEqual([]);
    expect(res.newOffset).toBe(0);
  });

  it("handles a missing file (offset preserved)", () => {
    const res = parseTranscriptFrom(join(dir, "gone.jsonl"), 42);
    expect(res.entries).toEqual([]);
    expect(res.newOffset).toBe(42);
  });

  it("degrades gracefully when the offset lands mid-line", () => {
    const path = writeFixture(BASIC_LINES);
    // Point into the middle of the second line: the partial line can't parse
    // as JSON, but every complete later line must still come through.
    const offset = Buffer.byteLength(BASIC_LINES[0], "utf-8") + 1 + 10;
    const { entries } = parseTranscriptFrom(path, offset);
    const tail = entries.slice(-2).map((e) => e.type);
    expect(tail).toEqual(["tool_result", "assistant"]);
  });

  it("leaves a half-written trailing line for the next poll instead of skipping it", () => {
    const path = writeFixture([BASIC_LINES[0]]);
    // Simulate catching the writer mid-append: a complete line plus the first
    // half of the next one, no trailing newline yet.
    const nextLine = assistantLine("a9", "Half-written reply");
    writeFileSync(path, nextLine.slice(0, 25), { flag: "a" });
    const first = parseTranscriptFrom(path, 0);
    expect(first.entries.map((e) => e.id)).toEqual(["u1"]);
    // Offset must stop at the end of the complete line, not EOF.
    expect(first.newOffset).toBe(
      Buffer.byteLength(BASIC_LINES[0], "utf-8") + 1,
    );
    // Writer finishes the line; the next poll picks up the WHOLE entry.
    writeFileSync(path, nextLine.slice(25) + "\n", { flag: "a" });
    const second = parseTranscriptFrom(path, first.newOffset);
    expect(second.entries.map((e) => e.id)).toEqual(["a9"]);
    expect(second.newOffset).toBe(Bun.file(path).size);
  });
});

describe("Codex rollout parsing", () => {
  it("keeps Codex entry ids stable between full and incremental parses", () => {
    const lines = [
      JSON.stringify({
        timestamp: TS,
        type: "event_msg",
        payload: { type: "user_message", message: "Search for docs" },
      }),
      JSON.stringify({
        timestamp: "2026-07-01T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          action: { query: "Open Session Codex support" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-01T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Found the relevant notes.",
        },
      }),
    ];
    const path = writeCodexFixture(lines);

    const full = parseTranscript(path);
    const incremental = parseTranscriptFrom(path, 0).entries;

    expect(incremental.map((e) => e.id)).toEqual(full.map((e) => e.id));
    expect(full.map((e) => e.type)).toEqual(["user", "tool_use", "assistant"]);
    expect(full[1].toolName).toBe("WebSearch");
    expect(full[1].id).toStartWith("codex-web-");
  });

  it("parses Codex file_change items as file edit tool uses", () => {
    const path = writeCodexFixture([
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: {
          id: "fc_1",
          type: "file_change",
          status: "completed",
          changes: [
            { kind: "update", path: "src/frontend/components/TurnFooter.tsx" },
            { kind: "add", path: "src/server/new-file.ts" },
          ],
        },
      }),
    ]);

    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_use");
    expect(entries[0].toolName).toBe("FileChange");
    expect(entries[0].toolUseId).toBe("fc_1");
    expect(entries[0].toolInput).toEqual({
      changes: [
        { kind: "update", path: "src/frontend/components/TurnFooter.tsx" },
        { kind: "add", path: "src/server/new-file.ts" },
      ],
    });
  });

  it("still reads the pre-rename BACKSTAGE_VIDEO marker (old transcripts)", () => {
    const path = writeCodexFixture([
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: {
          type: "local_shell_call_output",
          call_id: "call_shell_0",
          output: "recorded\nBACKSTAGE_VIDEO: /tmp/legacy-demo.mp4\n",
        },
      }),
    ]);
    const entries = parseTranscript(path);
    expect(entries[0].videos).toHaveLength(1);
    expect(entries[0].videos![0]).toContain(
      encodeURIComponent("/tmp/legacy-demo.mp4"),
    );
  });

  it("extracts videos from Codex shell tool output markers", () => {
    const path = writeCodexFixture([
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: {
          type: "local_shell_call_output",
          call_id: "call_shell_1",
          output: "recorded\nOPENSESSION_VIDEO: /tmp/backstage-demo.mp4\n",
        },
      }),
    ]);

    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_result");
    expect(entries[0].id).toBe("tr-call_shell_1");
    expect(entries[0].toolUseId).toBe("call_shell_1");
    expect(entries[0].videos).toEqual([
      "/media?path=%2Ftmp%2Fbackstage-demo.mp4",
    ]);
  });

  it("extracts videos from Codex MCP tool output markers", () => {
    const path = writeCodexFixture([
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_mcp_1",
          output: {
            output: "ok\nOPENSESSION_VIDEO: /var/tmp/mcp-recording.webm\n",
          },
        },
      }),
    ]);

    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_result");
    expect(entries[0].id).toBe("tr-call_mcp_1");
    expect(entries[0].toolUseId).toBe("call_mcp_1");
    expect(entries[0].videos).toEqual([
      "/media?path=%2Fvar%2Ftmp%2Fmcp-recording.webm",
    ]);
  });

  it("extracts and hides video markers from Codex assistant messages", () => {
    const path = writeCodexFixture([
      JSON.stringify({
        timestamp: TS,
        type: "event_msg",
        payload: {
          type: "agent_message",
          message:
            "Captured the production flow.\n\nOPENSESSION_VIDEO: /tmp/codex-demo.mov",
        },
      }),
    ]);

    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("assistant");
    expect(entries[0].content).toBe("Captured the production flow.");
    expect(entries[0].videos).toEqual(["/media?path=%2Ftmp%2Fcodex-demo.mov"]);
  });
});

describe("assistant video markers", () => {
  it("extracts a session asset and hides the marker from assistant content", () => {
    const assetPath =
      "/home/ubuntu/.opensession-assets/bks-019f861d-ffe5-7000-8638-5f69fc798fac/capture/tella-production-login-recording.mov";
    const path = writeFixture([
      assistantLine(
        "a-video",
        `Captured the production flow.\n\nOPENSESSION_VIDEO: ${assetPath}`,
      ),
    ]);

    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("assistant");
    expect(entries[0].content).toBe("Captured the production flow.");
    expect(entries[0].videos).toEqual([
      `/media?path=${encodeURIComponent(assetPath)}`,
    ]);
  });
});

describe("extractVideoMarkers", () => {
  it("returns media URLs for absolute OPENSESSION_VIDEO markers", () => {
    expect(
      extractVideoMarkers(
        "before\nOPENSESSION_VIDEO: /tmp/capture-one.mp4\nOPENSESSION_VIDEO: /tmp/second.webm",
      ),
    ).toEqual([
      "/media?path=%2Ftmp%2Fcapture-one.mp4",
      "/media?path=%2Ftmp%2Fsecond.webm",
    ]);
  });
});

describe("markers wrapped in markdown", () => {
  it("reads a bolded image marker", () => {
    expect(
      extractImageMarkers(
        "**OPENSESSION_IMAGE: /tmp/scale-shots/cmp-final.png**",
      ),
    ).toEqual(["/media?path=%2Ftmp%2Fscale-shots%2Fcmp-final.png"]);
  });

  it("reads italic, backticked and bulleted markers", () => {
    expect(extractImageMarkers("*OPENSESSION_IMAGE: /tmp/a.png*")).toEqual([
      "/media?path=%2Ftmp%2Fa.png",
    ]);
    expect(extractImageMarkers("`OPENSESSION_IMAGE: /tmp/b.png`")).toEqual([
      "/media?path=%2Ftmp%2Fb.png",
    ]);
    expect(extractVideoMarkers("- OPENSESSION_VIDEO: /tmp/c.mp4")).toEqual([
      "/media?path=%2Ftmp%2Fc.mp4",
    ]);
  });

  it("keeps underscores that belong to the path", () => {
    expect(
      extractImageMarkers("__OPENSESSION_IMAGE: /tmp/my_final_shot.png__"),
    ).toEqual(["/media?path=%2Ftmp%2Fmy_final_shot.png"]);
  });

  it("strips the whole wrapped line from an assistant bubble", () => {
    const path = writeFixture([
      assistantLine(
        "a-wrapped",
        "Done.\n\n**OPENSESSION_IMAGE: /tmp/shot.png**\n\nTop is now.",
      ),
    ]);
    const [entry] = parseTranscript(path);
    expect(entry.images).toEqual(["/media?path=%2Ftmp%2Fshot.png"]);
    expect(entry.content).not.toContain("OPENSESSION_IMAGE");
    expect(entry.content).not.toContain("**");
    expect(entry.content).toContain("Top is now.");
  });

  it("renders an emphasised bare path mention", () => {
    const shot = join(dir, "emphasised.png");
    writeFileSync(shot, "x");
    expect(extractImplicitMedia(`Look at **${shot}** for the result.`)).toEqual(
      {
        images: [`/media?path=${encodeURIComponent(shot)}`],
        videos: [],
      },
    );
  });
});

describe("implicit media in code search output", () => {
  const grepOutput = `Found 3 matches
/workspace/src/video.rs:
  Line 12: let source = "https://example.com/screen.mp4";
  Line 13: let poster = "https://example.com/poster.png";`;

  it("does not turn URLs in grep source snippets into attachments", () => {
    expect(extractImplicitMedia(grepOutput)).toEqual({
      images: [],
      videos: [],
    });
  });

  it("still extracts a genuine remote media URL outside grep output", () => {
    expect(
      extractImplicitMedia("Rendered https://cdn.tella.tv/renders/demo.mp4"),
    ).toEqual({
      images: [],
      videos: ["https://cdn.tella.tv/renders/demo.mp4"],
    });
  });

  it("does not turn URLs in a file read's quoted source into attachments", () => {
    const readOutput = `<path>/repo/src/timeline.rs</path>
<type>file</type>
<content>
12290:     let poster = "https://cdn.tella.tv/fixtures/image.png";
12291:     let source = "http://media.invalid/delayed.mp4";
</content>`;
    expect(extractImplicitMedia(readOutput)).toEqual({
      images: [],
      videos: [],
    });
  });

  it("drops reserved documentation hosts wherever they appear", () => {
    // No envelope here at all — plain assistant prose.
    expect(
      extractImplicitMedia(
        "Try https://example.com/image.png or http://cdn.example.test/clip.mp4 or http://localhost/a.png",
      ),
    ).toEqual({ images: [], videos: [] });
  });

  it("repairs old stored rows while preserving explicitly featured media", () => {
    const featured = "/media?path=%2Ftmp%2Factual-demo.mp4";
    const repaired = sanitizeTranscriptMediaEntry({
      id: "tr-grep",
      type: "tool_result",
      content: grepOutput,
      timestamp: TS,
      images: ["https://example.com/poster.png"],
      videos: ["https://example.com/screen.mp4", featured],
      featuredMedia: [featured],
    });
    expect(repaired.images).toBeUndefined();
    expect(repaired.videos).toEqual([featured]);
    expect(repaired.featuredMedia).toEqual([featured]);
  });

  it("repairs a stored file-read row and reserved-host media in any entry", () => {
    const readRow = sanitizeTranscriptMediaEntry({
      id: "tr-read",
      type: "tool_result",
      content: `<path>/repo/src/test.res</path>\n<type>file</type>\n<content>\n1: let src = "https://cdn.tella.tv/image.png"\n</content>`,
      timestamp: TS,
      images: ["https://cdn.tella.tv/image.png"],
    });
    expect(readRow.images).toBeUndefined();

    // Assistant text gets implicit extraction too, so it needs the same repair.
    const prose = sanitizeTranscriptMediaEntry({
      id: "a1",
      type: "assistant",
      content: "the fixture is https://example.com/image.png",
      timestamp: TS,
      images: ["https://example.com/image.png"],
    });
    expect(prose.images).toBeUndefined();
  });

  it("leaves a clean entry untouched (same object)", () => {
    const entry = {
      id: "tr-ok",
      type: "tool_result" as const,
      content: "rendered the demo",
      timestamp: TS,
      videos: ["https://cdn.tella.tv/renders/demo.mp4"],
    };
    expect(sanitizeTranscriptMediaEntry(entry)).toBe(entry);
  });
});

describe("featuredMedia (which tool-result media the agent asked to show)", () => {
  /** A real file, because the implicit-mention path requires existsSync. */
  function writeMediaFile(name: string): string {
    const path = join(dir, name);
    writeFileSync(path, "x");
    return path;
  }

  it("features marker media and leaves an implicit path mention folded", () => {
    const shown = writeMediaFile("shown.png");
    const touched = writeMediaFile("touched.png");
    const path = writeFixture([
      toolResultLine(
        "u1",
        "toolu_1",
        `wrote ${touched}\nOPENSESSION_IMAGE: ${shown}\n`,
      ),
    ]);
    const [entry] = parseTranscript(path);
    // Both still attach — the change is prominence, not availability.
    expect(entry.images).toEqual(
      expect.arrayContaining([
        `/media?path=${encodeURIComponent(shown)}`,
        `/media?path=${encodeURIComponent(touched)}`,
      ]),
    );
    expect(entry.featuredMedia).toEqual([
      `/media?path=${encodeURIComponent(shown)}`,
    ]);
  });

  it("does not feature a Read's image block", () => {
    const path = writeFixture([
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read",
              content: [
                { type: "text", text: "Image read successfully." },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AAAA",
                  },
                },
              ],
            },
          ],
        },
      }),
    ]);
    const [entry] = parseTranscript(path);
    expect(entry.images).toEqual(["data:image/png;base64,AAAA"]);
    expect(entry.featuredMedia).toBeUndefined();
  });

  it("features a video marker alongside an image marker", () => {
    const png = writeMediaFile("both.png");
    const mp4 = writeMediaFile("both.mp4");
    const path = writeFixture([
      toolResultLine(
        "u1",
        "toolu_2",
        `OPENSESSION_IMAGE: ${png}\nOPENSESSION_VIDEO: ${mp4}\n`,
      ),
    ]);
    const [entry] = parseTranscript(path);
    expect(entry.featuredMedia).toEqual([
      `/media?path=${encodeURIComponent(png)}`,
      `/media?path=${encodeURIComponent(mp4)}`,
    ]);
  });

  it("leaves a tool result with no media unfeatured", () => {
    const path = writeFixture([toolResultLine("u1", "toolu_3", "all done")]);
    const [entry] = parseTranscript(path);
    expect(entry.featuredMedia).toBeUndefined();
  });
});

describe("steer-joined composite user turns", () => {
  it("splits co-released attributed messages into separate entries", () => {
    const path = writeFixture([
      userLine(
        "u1",
        "[Alex] we flagged autoRatio right?\n\n[Alex] Also, explain the changes",
      ),
    ]);
    const entries = parseTranscript(path).filter((e) => e.type === "user");
    expect(entries.length).toBe(2);
    expect(entries[0].content).toBe("[Alex] we flagged autoRatio right?");
    expect(entries[1].content).toBe("[Alex] Also, explain the changes");
    expect(entries[0].id).toBe("u1");
    expect(entries[1].id).toBe("u1-j2");
  });

  it("keeps each source delivery identity on its normalized part", () => {
    const path = writeFixture([
      userLine("batch-entry", "[Alex] first\n\n[Johnny] second", [
        "delivery-one",
        "delivery-two",
      ]),
    ]);
    const entries = parseTranscript(path).filter((e) => e.type === "user");
    expect(entries.map((entry) => entry.sourceMessageIds)).toEqual([
      ["delivery-one"],
      ["delivery-two"],
    ]);
  });

  it("keeps every source identity when normalization cannot split the batch", () => {
    const path = writeFixture([
      userLine("batch-entry", "first\n\nsecond", [
        "delivery-one",
        "delivery-two",
      ]),
    ]);
    const entries = parseTranscript(path).filter((e) => e.type === "user");
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceMessageIds).toEqual([
      "delivery-one",
      "delivery-two",
    ]);
  });

  it("splits parts from different senders", () => {
    const path = writeFixture([
      userLine("u1", "[Alex] first\n\n[Johnny] second"),
    ]);
    const entries = parseTranscript(path).filter((e) => e.type === "user");
    expect(entries.map((e) => e.content)).toEqual([
      "[Alex] first",
      "[Johnny] second",
    ]);
  });

  it("does not split a paste with bracketed lines when the turn is unattributed", () => {
    const path = writeFixture([
      userLine("u1", "look at these logs\n\n[ERROR] it broke\n\n[ERROR] again"),
    ]);
    const entries = parseTranscript(path).filter((e) => e.type === "user");
    expect(entries.length).toBe(1);
  });

  it("keeps a single attributed message intact (blank lines without a prefix)", () => {
    const path = writeFixture([
      userLine("u1", "[Alex] first paragraph\n\nsecond paragraph"),
    ]);
    const entries = parseTranscript(path).filter((e) => e.type === "user");
    expect(entries.length).toBe(1);
  });
});
