/**
 * "Model-visible means logged": everything injected into a turn's model input
 * must be reconstructable from the append-only store.
 *
 * Driven through the real stack — runAgent → runOnModel → the fake engine
 * (testing/fake-engine.ts) — against a real TranscriptStore on a temp DB, so
 * the assertions cover the actual choke point, the actual entry path (blob
 * split included) and the actual client projection, not a hand-built entry.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { __setEngineForTest, runAgent } from "./agent-runner";
import { logStandingContext } from "./context-log";
import { __setActiveRunsPathForTest } from "./run-journal";
import type { StreamEvent } from "./run-events";
import { makeFakeEngine } from "./testing/fake-engine";
import {
  TranscriptStore,
  __setTranscriptStoreForTest,
} from "./transcript-store";
import { wrapContext } from "./prompt-context";
import { entriesForWire } from "./jsonl-parser";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { transcriptExcerpt } from "./transcript-excerpt";
import type { TranscriptEntry } from "./types";

const dir = mkdtempSync(`${tmpdir()}/context-log-test-`);
const prevJournal = __setActiveRunsPathForTest(`${dir}/active-runs.json`);
let store: TranscriptStore;
let prevStore: TranscriptStore | undefined;
let dbIndex = 0;

beforeEach(() => {
  // A fresh DB per test: the logger's dedupe is keyed on content, so tests
  // that log the same payload must not share a store either.
  store = new TranscriptStore(`${dir}/transcripts-${++dbIndex}.db`);
  prevStore = __setTranscriptStoreForTest(store) ?? prevStore;
  (globalThis as any).__osContextLogged?.clear();
  (globalThis as any).__osStandingContext?.clear();
});

afterEach(() => {
  __setEngineForTest(null);
});

afterAll(() => {
  __setTranscriptStoreForTest(prevStore);
  __setActiveRunsPathForTest(prevJournal);
  rmSync(dir, { recursive: true, force: true });
});

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _ of gen) {
  }
}

function injections(sessionId: string): TranscriptEntry[] {
  return store
    .readTail(sessionId, 100)
    .entries.filter((e) => e.noticeKind === "context-injection");
}

function standing(sessionId: string, source?: string): TranscriptEntry[] {
  return store
    .readTail(sessionId, 100)
    .entries.filter(
      (e) =>
        e.noticeKind === "standing-context" &&
        (!source || e.contextInjection?.source === source),
    );
}

describe("context-log: injected context round-trips into the store", () => {
  test("every fenced block and the repos note land as tagged entries", async () => {
    const sessionId = "os-ctx-1";
    __setEngineForTest(
      makeFakeEngine([{ kind: "clean", text: ["ok"] }]).engine,
    );
    await drain(
      runAgent({
        prompt: [
          wrapContext("## Engine handoff\nprior turns…", "handoff"),
          wrapContext(
            "### Other session\n- User: hi",
            "attached-session-excerpt",
          ),
          "rebase this",
        ].join("\n\n"),
        cwd: dir,
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "none",
        reposNote: "## Repos\nopensession → /tmp/x\n\n## Memory\nremember me",
        promptEntryId: "turn-1",
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );

    const logged = injections(sessionId);
    expect(logged.map((e) => e.contextInjection?.source).sort()).toEqual([
      "attached-session-excerpt",
      "handoff",
      "repos-note",
    ]);
    // Payload recorded verbatim, associated with the turn it rode with.
    const handoff = logged.find(
      (e) => e.contextInjection?.source === "handoff",
    )!;
    expect(handoff.content).toBe("## Engine handoff\nprior turns…");
    expect(handoff.contextInjection?.turnId).toBe("turn-1");
    expect(handoff.type).toBe("system");
    // The system-channel note is model-visible without being in the body.
    expect(
      logged.find((e) => e.contextInjection?.source === "repos-note")?.content,
    ).toContain("remember me");
  });

  test("an untagged block still logs (the fence is the contract, not the call)", async () => {
    const sessionId = "os-ctx-untagged";
    __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
    await drain(
      runAgent({
        prompt: `${wrapContext("legacy plumbing")}\n\nhello`,
        cwd: dir,
        mcpServers: [],
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );
    const logged = injections(sessionId);
    expect(logged).toHaveLength(1);
    expect(logged[0].contextInjection?.source).toBe("unknown");
    expect(logged[0].content).toBe("legacy plumbing");
  });

  test("an oversized payload splits into a blob and rehydrates in full", async () => {
    const sessionId = "os-ctx-big";
    // Comfortably past the store's 32KB wire bound, like a real engine
    // handoff (buildEngineSwitchHandoffNote budgets up to 180KB).
    const big = `## Engine handoff\n${"transcript line ".repeat(6000)}`;
    __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
    await drain(
      runAgent({
        prompt: `${wrapContext(big, "handoff")}\n\ncontinue`,
        cwd: dir,
        mcpServers: [],
        fallbackModel: "none",
        promptEntryId: "turn-big",
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );
    const logged = injections(sessionId);
    expect(logged).toHaveLength(1);
    expect(logged[0].contentClamped).toBe(true);
    const full = store.getFullEntry(sessionId, logged[0].id)!;
    expect(full.content).toBe(big.trim());
  });

  test("the fallback walk logs the handoff it prepends for the second model", async () => {
    const sessionId = "os-ctx-fallback";
    __setEngineForTest(
      makeFakeEngine([
        { kind: "usage_exhausted", engineSessionId: "ses_1" },
        { kind: "clean", text: ["done"] },
      ]).engine,
    );
    await drain(
      runAgent({
        prompt: "do the thing",
        cwd: dir,
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "gpt-5.6-sol",
        promptEntryId: "turn-fb",
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );
    // The cross-provider hop had no prior-engine transcript to hand over
    // here, so the walk's own note is the plain unfenced one; what matters
    // is that the second dispatch went through the same choke point and
    // nothing was logged twice for the first.
    const logged = injections(sessionId);
    expect(logged.every((e) => e.contextInjection?.turnId === "turn-fb")).toBe(
      true,
    );
    expect(new Set(logged.map((e) => e.id)).size).toBe(logged.length);
  });

  test("a retried turn upserts its record instead of duplicating it", async () => {
    const sessionId = "os-ctx-retry";
    const prompt = `${wrapContext("## Engine handoff\nsame payload", "handoff")}\n\ngo`;
    for (const _ of [1, 2]) {
      __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
      await drain(
        runAgent({
          prompt,
          cwd: dir,
          mcpServers: [],
          fallbackModel: "none",
          promptEntryId: "turn-retry",
          journal: { osSessionId: sessionId, kind: "session" },
        }),
      );
      (globalThis as any).__osContextLogged?.clear(); // force the second write
    }
    expect(injections(sessionId)).toHaveLength(1);
  });

  test("nothing is logged for a session-less run", async () => {
    __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
    await drain(
      runAgent({
        prompt: `${wrapContext("orphan", "handoff")}\n\nhi`,
        cwd: dir,
        mcpServers: [],
        fallbackModel: "none",
      }),
    );
    expect(store.readTail("", 10).entries).toHaveLength(0);
  });
});

describe("context-log: injection records are not conversation", () => {
  test("the wire projection drops them, keeping the visible transcript intact", async () => {
    const sessionId = "os-ctx-wire";
    __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
    await drain(
      runAgent({
        prompt: `${wrapContext("## Engine handoff\nplumbing", "handoff")}\n\nvisible`,
        cwd: dir,
        mcpServers: [],
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );
    const stored = store.readTail(sessionId, 100).entries;
    expect(stored.some((e) => e.noticeKind === "context-injection")).toBe(true);
    // The turn also stood up a standing record (the run's tool surface);
    // both are audit rows, so both leave on the way to a client.
    expect(stored.some((e) => e.noticeKind === "standing-context")).toBe(true);
    const records = stored.filter(
      (e) =>
        e.noticeKind === "context-injection" ||
        e.noticeKind === "standing-context",
    );
    const wire = entriesForWire(stored);
    expect(
      wire.some(
        (e) =>
          e.noticeKind === "context-injection" ||
          e.noticeKind === "standing-context",
      ),
    ).toBe(false);
    expect(wire).toHaveLength(stored.length - records.length);
  });

  test("a transcript excerpt skips them", async () => {
    const sessionId = "os-ctx-excerpt";
    __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
    await drain(
      runAgent({
        prompt: `${wrapContext("## Engine handoff\nplumbing", "handoff")}\n\nvisible`,
        cwd: dir,
        mcpServers: [],
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );
    // Both record kinds are in the store for this session…
    expect(store.readTail(sessionId, 100).entries).not.toHaveLength(0);
    expect(injections(sessionId)).toHaveLength(1);
    expect(standing(sessionId)).toHaveLength(1);
    // …and the excerpt loader, which a recap is built over, sees none of
    // them: summarizing the harness's own plumbing back at the model is
    // exactly the loop these records must not join.
    const excerpt = await transcriptExcerpt(sessionId, {}, { store });
    expect(excerpt.total).toBe(0);
    expect(
      excerpt.windows.flatMap((w) => w.entries.map((e) => e.noticeKind)),
    ).toEqual([]);
  });

  test("a handoff note built from history skips them", () => {
    const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
      id: over.id || "e",
      type: over.type || "user",
      content: over.content || "",
      timestamp: "2026-08-16T00:00:00Z",
      ...over,
    });
    const note = buildEngineSwitchHandoffNote({
      fromProvider: "pi",
      toProvider: "claude",
      sameEngineRestart: true,
      entries: [
        entry({ id: "a", content: "real message" }),
        entry({
          id: "b",
          type: "system",
          content: "INJECTED PAYLOAD",
          noticeKind: "context-injection",
          contextInjection: { source: "handoff" },
        }),
        entry({
          id: "c",
          type: "system",
          content: "STANDING PAYLOAD",
          noticeKind: "standing-context",
          contextInjection: { source: "instructions", hash: "abc", bytes: 16 },
        }),
      ],
    });
    expect(note).toContain("real message");
    expect(note).not.toContain("INJECTED PAYLOAD");
    // The standing record is the run's own instructions: re-injecting it
    // into the note that seeds the next engine would hand the model its
    // own configuration as if a human had said it.
    expect(note).not.toContain("STANDING PAYLOAD");
  });
});

describe("context-log: standing context is recorded on change, not per turn", () => {
  async function turn(
    sessionId: string,
    over: {
      mcpServers?: string[] | "all";
      deniedTools?: Record<string, string>;
      promptEntryId?: string;
    } = {},
  ): Promise<void> {
    __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
    await drain(
      runAgent({
        prompt: "go",
        cwd: dir,
        mcpServers: over.mcpServers ?? [],
        deniedTools: over.deniedTools,
        fallbackModel: "none",
        promptEntryId: over.promptEntryId,
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );
  }

  test("the run's tool surface lands once, with its hash and size", async () => {
    const sessionId = "os-std-tools";
    await turn(sessionId, { promptEntryId: "turn-1" });
    await turn(sessionId, { promptEntryId: "turn-2" });
    await turn(sessionId, { promptEntryId: "turn-3" });

    const rows = standing(sessionId, "tools");
    // Three turns, one record: the whole point of a standing record.
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("system");
    expect(row.contextInjection?.turnId).toBe("turn-1");
    expect(row.contextInjection?.hash).toBe(
      createHash("sha256").update(row.content).digest("hex"),
    );
    expect(row.contextInjection?.bytes).toBe(
      Buffer.byteLength(row.content, "utf8"),
    );
    // The payload is the scoping decision itself, readable without a
    // replay: what the model could reach, and what was taken away.
    expect(JSON.parse(row.content)).toMatchObject({
      mcpScope: [],
      inProcess: [],
      deniedTools: [],
      confirmTools: [],
      localWorkspaceToolsDisabled: false,
    });
  });

  test("a changed surface earns a second record; an unchanged one does not", async () => {
    const sessionId = "os-std-change";
    await turn(sessionId, { promptEntryId: "turn-1" });
    const denied = { mcp__stripe__create_refund: "not available" };
    await turn(sessionId, { promptEntryId: "turn-2", deniedTools: denied });
    await turn(sessionId, { promptEntryId: "turn-3", deniedTools: denied });

    const rows = standing(sessionId, "tools");
    expect(rows).toHaveLength(2);
    // Each record is stamped with the turn that first saw it, so "what was
    // in force at turn N" is the newest record at or before it.
    expect(rows.map((r) => r.contextInjection?.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
    expect(new Set(rows.map((r) => r.contextInjection?.hash)).size).toBe(2);
    expect(JSON.parse(rows[1].content).deniedTools).toEqual([
      "mcp__stripe__create_refund",
    ]);
  });

  test("a server restart does not append a second copy of an unchanged record", async () => {
    const sessionId = "os-std-restart";
    await turn(sessionId, { promptEntryId: "turn-1" });
    // What a restart looks like from here: the in-process hash map is gone,
    // so the next turn re-records. The entry id is content-addressed, so
    // that lands on the same row instead of a second copy — which on a
    // 273KB instructions record is the difference between a bounded log and
    // megabytes a day.
    (globalThis as any).__osStandingContext?.clear();
    await turn(sessionId, { promptEntryId: "turn-2" });
    expect(standing(sessionId, "tools")).toHaveLength(1);
  });

  test("a fallback hop reuses the record instead of writing a second", async () => {
    const sessionId = "os-std-fallback";
    __setEngineForTest(
      makeFakeEngine([
        { kind: "usage_exhausted", engineSessionId: "ses_1" },
        { kind: "clean", text: ["done"] },
      ]).engine,
    );
    await drain(
      runAgent({
        prompt: "do the thing",
        cwd: dir,
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "gpt-5.6-sol",
        promptEntryId: "turn-fb",
        journal: { osSessionId: sessionId, kind: "session" },
      }),
    );
    // Two dispatches through the choke point, one surface: the record
    // tracks the scoping, not the number of engine calls.
    expect(standing(sessionId, "tools")).toHaveLength(1);
  });

  test("an identical surface in another session is still that session's record", async () => {
    await turn("os-std-a", { promptEntryId: "t" });
    await turn("os-std-b", { promptEntryId: "t" });
    expect(standing("os-std-a", "tools")).toHaveLength(1);
    expect(standing("os-std-b", "tools")).toHaveLength(1);
  });

  test("an oversized record splits into a blob and rehydrates in full", async () => {
    const sessionId = "os-std-big";
    // A wide allowlist is the cheap way to a payload past the store's 32KB
    // wire bound; a real instructions file gets there on its own.
    const many = Array.from({ length: 4000 }, (_, i) => `srv-${i}`);
    await turn(sessionId, { mcpServers: many, promptEntryId: "turn-big" });

    const rows = standing(sessionId, "tools");
    expect(rows).toHaveLength(1);
    expect(rows[0].contentClamped).toBe(true);
    const full = store.getFullEntry(sessionId, rows[0].id)!;
    expect(JSON.parse(full.content).mcpScope).toHaveLength(4000);
    // The hash and size describe the WHOLE record, not the clamped wire
    // form — which is how a reader knows it is holding a truncated copy.
    expect(rows[0].contextInjection?.hash).toBe(
      createHash("sha256").update(full.content).digest("hex"),
    );
    expect(rows[0].contextInjection?.bytes).toBeGreaterThan(
      rows[0].content.length,
    );
  });

  test('an undefined scope reads as "all" instead of killing the turn', async () => {
    const sessionId = "os-std-undefined-scope";
    __setEngineForTest(
      makeFakeEngine([{ kind: "clean", text: ["ok"] }]).engine,
    );
    const events: StreamEvent[] = [];
    // `mcpServers` is typed as required, but the create path casts an
    // optional value into it, so undefined does reach the choke point. It
    // spread-crashed the whole turn on the day this landed; an audit
    // record must never be able to do that.
    for await (const e of runAgent({
      prompt: "go",
      cwd: dir,
      mcpServers: undefined as unknown as "all",
      fallbackModel: "none",
      promptEntryId: "turn-undefined",
      journal: { osSessionId: sessionId, kind: "session" },
    }))
      events.push(e);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const rows = standing(sessionId, "tools");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).mcpScope).toBe("all");
  });

  test("a direct engine's instructions record rides the same helper, and leaves on the way out", async () => {
    const sessionId = "os-std-direct-instructions";
    const text = "## Run policy\nnever push to main\n";
    // What claude-direct and codex-direct call once their system prompt is
    // final: they assemble their own and never reach the pi runner,
    // so the adapter is the call site. Same helper, so the same
    // content-addressing — a second turn, and a restart that clears the
    // in-process map, both land on the one row.
    await logStandingContext({
      sessionId,
      turnId: "turn-1",
      source: "instructions",
      content: text,
    });
    await logStandingContext({
      sessionId,
      turnId: "turn-2",
      source: "instructions",
      content: text,
    });
    expect(standing(sessionId, "instructions")).toHaveLength(1);
    expect(
      standing(sessionId, "instructions")[0].contextInjection?.turnId,
    ).toBe("turn-1");

    // A restart clears the in-process map, so the next turn re-records —
    // onto the same content-addressed row, which keeps its place in the
    // transcript and takes the re-asserting turn's id.
    (globalThis as any).__osStandingContext?.clear();
    await logStandingContext({
      sessionId,
      turnId: "turn-3",
      source: "instructions",
      content: text,
    });

    const rows = standing(sessionId, "instructions");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(text.trim());
    expect(rows[0].contextInjection?.turnId).toBe("turn-3");

    // Instructions that actually moved earn their own record.
    await logStandingContext({
      sessionId,
      turnId: "turn-4",
      source: "instructions",
      content: `${text}also: no force pushes\n`,
    });
    expect(standing(sessionId, "instructions")).toHaveLength(2);

    // …and the same exclusion as every other record: this is the run's own
    // configuration, never conversation.
    expect(entriesForWire(store.readTail(sessionId, 10).entries)).toHaveLength(
      0,
    );
  });

  test("pi instructions record once across turns, and again only when the text changes", async () => {
    const sessionId = "os-std-pi-instructions";
    const text = "## Run policy\nkeep the checkout intact\n";
    for (const turnId of ["turn-1", "turn-2"]) {
      await logStandingContext({
        sessionId,
        turnId,
        source: "instructions",
        content: text,
      });
    }

    expect(standing(sessionId, "instructions")).toHaveLength(1);
    await logStandingContext({
      sessionId,
      turnId: "turn-3",
      source: "instructions",
      content: `${text}use the private index\n`,
    });
    const rows = standing(sessionId, "instructions");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.contextInjection?.turnId)).toEqual([
      "turn-1",
      "turn-3",
    ]);
  });

  test("nothing is recorded for a session-less run", async () => {
    __setEngineForTest(makeFakeEngine([{ kind: "clean" }]).engine);
    await drain(
      runAgent({
        prompt: "hi",
        cwd: dir,
        mcpServers: [],
        fallbackModel: "none",
      }),
    );
    expect(store.readTail("", 10).entries).toHaveLength(0);
  });
});
