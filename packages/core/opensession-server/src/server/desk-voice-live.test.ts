import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESK_LIVE_BACKEND_MODEL,
  LIVE_CLIENT_ALLOWED_EVENTS,
  LIVE_ROW_GAP_MS,
  LiveResponseLoop,
  LiveUsageMeter,
  VoiceTranscriptRows,
  buildLiveSessionConfig,
  formatLiveUsage,
  liveTranscriptSpan,
} from "./desk-voice-live";
import {
  setVoiceBackendModel,
  setVoiceKey,
  voiceBackendModel,
  voiceKeyMasked,
} from "./desk-voice";
import { stateDir } from "./paths";
import { registerSessionControl, type SessionControl } from "./session-control";
import { VoiceCaptionStore } from "../frontend/lib/voice-captions";
import { VoiceReferenceLedger, linkSpokenReferences } from "./desk-voice-refs";

// The voice store resolves its path per call, so pointing OPENSESSION_STATE_DIR
// at a scratch dir here keeps every test below off the machine's real
// desk/voice.json (which may hold a key and a backend choice of its own).
let scratch = "";
let previousStateDir: string | undefined;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "desk-voice-live-test-"));
  previousStateDir = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = scratch;
});
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  rmSync(scratch, { recursive: true, force: true });
});

function registerStubControl(
  tail: Array<{ type: "user" | "assistant"; content: string }> = [],
) {
  registerSessionControl({
    listSessions: () => [] as ReturnType<SessionControl["listSessions"]>,
    getSession: () => undefined,
    transcriptTail: async () =>
      tail.map((e, i) => ({
        id: `e${i}`,
        type: e.type,
        content: e.content,
        timestamp: "2026-09-10T09:00:00.000Z",
      })) as Awaited<ReturnType<SessionControl["transcriptTail"]>>,
    answerQuestion: () => false,
    deliverToSession: async () => ({
      status: "error" as const,
      message: "not used",
    }),
    cancelSession: () => false,
    reparentSession: async () => ({ ok: false, error: "not used" }),
    createSession: async () => ({
      id: "unused",
      createdBy: "Test",
      createdAt: "2026-09-10T09:00:00.000Z",
    }),
  });
}

describe("Desk voice GPT-Live session config", () => {
  test("delegates to a Responses backend that carries the voice tool facade", async () => {
    registerStubControl();
    const config = await buildLiveSessionConfig("missing-test-session");
    expect(config.model).toBe("gpt-live-1");
    expect(config.delegation.type).toBe("responses");
    const names = config.delegation.responses.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_current_work",
        "start_session",
        "steer_session",
        "list_sessions",
        "opensession-admin_list_automations",
      ]),
    );
    // MCP schemas are not strict-mode compatible; every tool opts out.
    expect(
      config.delegation.responses.tools.every((t) => t.strict === false),
    ).toBe(true);
    // The voice prompt stays short; the rules live in the backend prompt.
    expect(config.instructions.length).toBeLessThan(2000);
    expect(config.delegation.responses.instructions).toContain("start_session");
  });

  test("locks the browser data channel down to hanging up", async () => {
    registerStubControl();
    const config = await buildLiveSessionConfig("missing-test-session");
    expect(LIVE_CLIENT_ALLOWED_EVENTS).toEqual(["session.close"]);
    expect(config.client.data_channel.allowed_client_events).toEqual([
      "session.close",
    ]);
    const visible = config.client.data_channel.allowed_server_events.map(
      (s) => s.type,
    );
    expect(visible).toContain("session.started");
    expect(visible).toContain("session.closed");
    expect(visible).not.toContain("response.event");
  });

  test("delegates to Terra unless the instance chose Luna, read per call", async () => {
    registerStubControl();
    expect(DESK_LIVE_BACKEND_MODEL).toBe("gpt-5.6-terra");
    expect(await voiceBackendModel()).toBe("gpt-5.6-terra");
    let config = await buildLiveSessionConfig("missing-test-session");
    expect(config.delegation.responses.model).toBe("gpt-5.6-terra");

    await setVoiceBackendModel("gpt-5.6-luna");
    config = await buildLiveSessionConfig("missing-test-session");
    expect(config.delegation.responses.model).toBe("gpt-5.6-luna");
    // The voice model itself does not change with the backend.
    expect(config.model).toBe("gpt-live-1");

    await setVoiceBackendModel("gpt-5.6-terra");
    config = await buildLiveSessionConfig("missing-test-session");
    expect(config.delegation.responses.model).toBe("gpt-5.6-terra");
  });

  test("refuses any backend but the two allowed ids and leaves the setting alone", async () => {
    await setVoiceBackendModel("gpt-5.6-luna");
    for (const bad of ["gpt-5.6", "gpt-live-1", "", 42, null, undefined])
      await expect(setVoiceBackendModel(bad)).rejects.toThrow(
        /Voice backend must be/,
      );
    expect(await voiceBackendModel()).toBe("gpt-5.6-luna");
    await setVoiceBackendModel("gpt-5.6-terra");
  });

  test("stores the backend beside the key, 0600, and neither write drops the other", async () => {
    await setVoiceKey("sk-test-1234");
    await setVoiceBackendModel("gpt-5.6-luna");
    expect(await voiceKeyMasked()).toBe("sk-…1234");
    expect(await voiceBackendModel()).toBe("gpt-5.6-luna");
    await setVoiceKey("sk-test-5678");
    expect(await voiceBackendModel()).toBe("gpt-5.6-luna");
    const path = join(stateDir("desk"), "voice.json");
    expect(path.startsWith(scratch)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      openaiApiKey: "sk-test-5678",
      liveBackendModel: "gpt-5.6-luna",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Clearing the key keeps the choice; only the key goes.
    await setVoiceKey("");
    expect(await voiceKeyMasked()).toBeUndefined();
    expect(await voiceBackendModel()).toBe("gpt-5.6-luna");
    await setVoiceBackendModel("gpt-5.6-terra");
  });

  test("concurrent key and backend saves preserve both values", async () => {
    await Promise.all([
      setVoiceKey("sk-test-concurrent"),
      setVoiceBackendModel("gpt-5.6-luna"),
    ]);
    expect(await voiceKeyMasked()).toBe("sk-…rent");
    expect(await voiceBackendModel()).toBe("gpt-5.6-luna");
    await setVoiceKey("");
    await setVoiceBackendModel("gpt-5.6-terra");
  });

  test("seeds the live model with the recent Desk text conversation", async () => {
    registerStubControl([
      { type: "user", content: "what's   running?" },
      { type: "assistant", content: "Two sessions." },
    ]);
    const config = await buildLiveSessionConfig("desk-session");
    expect(config.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "what's running?" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Two sessions." }],
      },
    ]);
  });
});

describe("LiveUsageMeter", () => {
  test("sums backend usage across delegations from terminal events only", () => {
    const meter = new LiveUsageMeter();
    // Streaming events carry no usage; only the terminal one counts.
    expect(
      meter.handle({ type: "response.created", response: { id: "resp_1" } }),
    ).toBe(false);
    expect(
      meter.handle({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c1", name: "x" },
      }),
    ).toBe(false);
    expect(
      meter.handle({
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            input_tokens_details: { cached_tokens: 800 },
            output_tokens_details: { reasoning_tokens: 120 },
          },
        },
      }),
    ).toBe(true);
    // `response.done` naming the same response is not counted twice.
    expect(
      meter.handle({
        type: "response.done",
        response: { id: "resp_1", usage: { input_tokens: 1200 } },
      }),
    ).toBe(false);
    // A second delegation's response, with partial detail.
    expect(
      meter.handle({
        type: "response.done",
        response: {
          id: "resp_2",
          usage: { input_tokens: 50, output_tokens: 7 },
        },
      }),
    ).toBe(true);
    // A terminal event without usage adds nothing.
    expect(
      meter.handle({ type: "response.completed", response: { id: "resp_3" } }),
    ).toBe(false);
    expect(meter.totals).toEqual({
      inputTokens: 1250,
      outputTokens: 307,
      cachedInputTokens: 800,
      reasoningTokens: 120,
      responses: 2,
    });
    expect(formatLiveUsage(meter.totals)).toBe(
      "tokens in=1250 (cached 800) out=307 (reasoning 120)",
    );
  });

  test("an idle call reports zero without detail", () => {
    const meter = new LiveUsageMeter();
    expect(formatLiveUsage(meter.totals)).toBe("tokens in=0 out=0");
  });
});

describe("VoiceTranscriptRows", () => {
  function rows() {
    const out: Array<{ id: string; role: string; text: string }> = [];
    const r = new VoiceTranscriptRows({
      gapMs: LIVE_ROW_GAP_MS,
      idleMs: 60_000,
      rowId: (role, startMs) => `${role}-${startMs}`,
      onRow: ({ id, role, text }) => out.push({ id, role, text }),
    });
    return { r, out };
  }

  test("hands each row over with the span of its fragments", () => {
    const out: Array<{ id: string; startMs: number; endMs: number }> = [];
    const r = new VoiceTranscriptRows({
      gapMs: LIVE_ROW_GAP_MS,
      idleMs: 60_000,
      rowId: (role, startMs) => `${role}-${startMs}`,
      onRow: ({ id, startMs, endMs }) => out.push({ id, startMs, endMs }),
    });
    r.push({ role: "user", delta: "What is", startMs: 1000, endMs: 1200 });
    r.push({ role: "user", delta: " running?", startMs: 1200, endMs: 1800 });
    r.flushAll();
    expect(out).toEqual([{ id: "user-1000", startMs: 1000, endMs: 1800 }]);
  });

  test("joins fragments of one utterance and splits on a timeline gap", () => {
    const { r, out } = rows();
    r.push({ role: "user", delta: "What is", startMs: 1000, endMs: 1200 });
    r.push({ role: "user", delta: " running?", startMs: 1200, endMs: 1800 });
    expect(out).toEqual([]);
    r.push({ role: "user", delta: "Also,", startMs: 5000, endMs: 5300 });
    expect(out).toEqual([
      { id: "user-1000", role: "user", text: "What is running?" },
    ]);
    r.flushAll();
    expect(out[1]).toEqual({ id: "user-5000", role: "user", text: "Also," });
  });

  test("keeps overlapping user and assistant rows independent, in start order", () => {
    const { r, out } = rows();
    r.push({ role: "assistant", delta: "Sure, ", startMs: 100, endMs: 600 });
    r.push({ role: "user", delta: "wait", startMs: 400, endMs: 700 });
    r.push({
      role: "assistant",
      delta: "one moment.",
      startMs: 600,
      endMs: 1200,
    });
    r.flushAll();
    expect(out).toEqual([
      { id: "assistant-100", role: "assistant", text: "Sure, one moment." },
      { id: "user-400", role: "user", text: "wait" },
    ]);
  });

  test("ends a turn when the other speaker starts after it, so user/assistant/user stays three rows in order", () => {
    const { r, out } = rows();
    r.push({ role: "user", delta: "What's running?", startMs: 0, endMs: 800 });
    r.push({
      role: "assistant",
      delta: "Two sessions.",
      startMs: 900,
      endMs: 1800,
    });
    // Within the user's 2s gap of the first fragment, but a new turn: the
    // assistant answered in between.
    r.push({ role: "user", delta: "Stop one.", startMs: 1900, endMs: 2400 });
    expect(out).toEqual([
      { id: "user-0", role: "user", text: "What's running?" },
      { id: "assistant-900", role: "assistant", text: "Two sessions." },
    ]);
    r.flushAll();
    expect(out[2]).toEqual({
      id: "user-1900",
      role: "user",
      text: "Stop one.",
    });
  });

  test("puts a late-arriving user fragment ahead of the reply that followed it", () => {
    const { r, out } = rows();
    // Recognition lags playback: the reply's transcript shows up first.
    r.push({
      role: "assistant",
      delta: "Two sessions.",
      startMs: 900,
      endMs: 1800,
    });
    r.push({ role: "user", delta: "What's running?", startMs: 0, endMs: 800 });
    // The assistant's idle fires first; the question still goes out first.
    r.flush("assistant");
    expect(out).toEqual([
      { id: "user-0", role: "user", text: "What's running?" },
      { id: "assistant-900", role: "assistant", text: "Two sessions." },
    ]);
  });

  test("an interrupted reply still leads the interruption when a later fragment closes both", () => {
    const { r, out } = rows();
    r.push({
      role: "assistant",
      delta: "Sure, one moment.",
      startMs: 100,
      endMs: 1200,
    });
    r.push({ role: "user", delta: "wait", startMs: 400, endMs: 700 });
    // Past the user's gap and past the assistant's end: both rows close, and
    // the one that started first goes out first.
    r.push({ role: "user", delta: "go on.", startMs: 5000, endMs: 5400 });
    expect(out).toEqual([
      { id: "assistant-100", role: "assistant", text: "Sure, one moment." },
      { id: "user-400", role: "user", text: "wait" },
    ]);
    r.flushAll();
    expect(out[2]).toEqual({ id: "user-5000", role: "user", text: "go on." });
  });

  test("drops whitespace-only rows", () => {
    const { r, out } = rows();
    r.push({ role: "user", delta: "  ", startMs: 0, endMs: 100 });
    r.flushAll();
    expect(out).toEqual([]);
  });

  test.each([
    { start_ms: 1200, end_ms: "unknown", startMs: 1200, endMs: 1200 },
    { start_ms: "unknown", end_ms: 1500, startMs: 0, endMs: 1500 },
    { start_ms: null, end_ms: null, startMs: 0, endMs: 0 },
    { start_ms: NaN, end_ms: Infinity, startMs: 0, endMs: 0 },
    { start_ms: -Infinity, end_ms: {}, startMs: 0, endMs: 0 },
    { start_ms: undefined, end_ms: undefined, startMs: 0, endMs: 0 },
    { start_ms: 1200, end_ms: 1500, startMs: 1200, endMs: 1500 },
  ])("normalizes sideband timestamps and drains captions: %j", (event) => {
    const span = liveTranscriptSpan(event);
    expect(span).toEqual({ startMs: event.startMs, endMs: event.endMs });
    const captions = new VoiceCaptionStore();
    captions.start("live_abc");
    captions.push({
      role: "assistant",
      delta: "PR forty two.",
      startMs: event.startMs,
      endMs: event.endMs,
    });
    const r = new VoiceTranscriptRows({
      gapMs: LIVE_ROW_GAP_MS,
      idleMs: 60_000,
      rowId: (role, startMs) => `voice-live_abc-${role}-${startMs}`,
      onRow: (row) => {
        captions.land({
          id: `${row.id}-end-${row.endMs}`,
          type: row.role,
          content: "PR opensession#42.",
        });
      },
    });
    r.push({ role: "assistant", delta: "PR forty two.", ...span });
    expect(captions.getSnapshot().captions).toHaveLength(1);
    r.flushAll();
    expect(captions.getSnapshot().captions).toEqual([]);
  });

  test("the browser's captions drain exactly as the mirrored rows land", () => {
    // The browser sees the same fragments on its data channel and shows them
    // as captions (frontend/lib/voice-captions.ts) until this class's row
    // for them reaches the transcript. The mirrored id carries the row's
    // span the way startLiveCall builds it, so the captions come down even
    // when the Desk's words were rewritten into references on the way.
    const captions = new VoiceCaptionStore();
    captions.start("live_abc");
    const ledger = new VoiceReferenceLedger();
    ledger.collect(
      "list_current_work",
      {},
      {
        sessions: [
          {
            id: "bks-01900000-0000-7000-8000-000000000000",
            title: "Work 0",
            repo: "opensession",
            prNumber: 42,
          },
        ],
      },
      [{ id: "opensession", ghRepo: "tellahq/opensession" }],
    );
    const mirrored: string[] = [];
    const r = new VoiceTranscriptRows({
      gapMs: LIVE_ROW_GAP_MS,
      idleMs: 60_000,
      rowId: (role, startMs) => `voice-live_abc-${role}-${startMs}`,
      onRow: (row) => {
        const content =
          row.role === "assistant"
            ? linkSpokenReferences(row.text, ledger)
            : row.text;
        mirrored.push(content);
        captions.land({
          id: `${row.id}-end-${row.endMs}`,
          type: row.role,
          content,
        });
      },
    });
    const shown = () =>
      captions.getSnapshot().captions.map((c) => [c.role, c.text]);
    const push = (
      role: "user" | "assistant",
      delta: string,
      startMs: number,
      endMs: number,
    ) => {
      captions.push({ role, delta, startMs, endMs });
      r.push({ role, delta, startMs, endMs });
    };
    push("user", "What's", 0, 300);
    push("user", " running?", 300, 800);
    expect(shown()).toEqual([["user", "What's running?"]]);
    // The reply starting closes the question's row; its caption goes with it.
    push("assistant", "Two, and ", 900, 1100);
    expect(shown()).toEqual([["assistant", "Two, and"]]);
    push("assistant", "PR forty two is open.", 1100, 1800);
    expect(shown()).toEqual([["assistant", "Two, and PR forty two is open."]]);
    push("user", "Stop one.", 1900, 2400);
    expect(shown()).toEqual([["user", "Stop one."]]);
    expect(mirrored[1]).toBe("Two, and PR opensession#42 is open.");
    r.flushAll();
    expect(shown()).toEqual([]);
  });
});

describe("LiveResponseLoop", () => {
  function loop(
    runTool: (
      callId: string,
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {
    const sent: Array<Record<string, unknown>> = [];
    const l = new LiveResponseLoop({ send: (e) => sent.push(e), runTool });
    return { l, sent };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("answers every function call before continuing the response", async () => {
    const ran: string[] = [];
    const { l, sent } = loop(async (_id, name, args) => {
      ran.push(name);
      return { ok: true, args };
    });
    l.handle("del_1", { type: "response.created", response: { id: "resp_1" } });
    l.handle("del_1", {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_a",
        name: "list_current_work",
        arguments: "{}",
      },
    });
    l.handle("del_1", {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_b",
        name: "inspect_session",
        arguments: '{"session_id":"os-1"}',
      },
    });
    l.handle("del_1", { type: "response.completed" });
    await tick();
    await tick();
    expect(ran).toEqual(["list_current_work", "inspect_session"]);
    expect(sent.map((e) => e.type)).toEqual([
      "response.item.create",
      "response.item.create",
      "response.create",
    ]);
    const outputs = sent
      .filter((e) => e.type === "response.item.create")
      .map((e) => e.item as { call_id: string; output: string });
    expect(outputs.map((o) => o.call_id).sort()).toEqual(["call_a", "call_b"]);
    expect(JSON.parse(outputs[1].output)).toEqual({
      ok: true,
      args: { session_id: "os-1" },
    });
  });

  test("waits for a slow tool even when the response completes first", async () => {
    let release: (v: unknown) => void = () => {};
    const { l, sent } = loop(() => new Promise((r) => (release = r)));
    l.handle("del_1", { type: "response.created" });
    l.handle("del_1", {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c1", name: "start_session" },
    });
    l.handle("del_1", { type: "response.completed" });
    await tick();
    expect(sent).toEqual([]);
    expect(l.busy).toBe(true);
    release({ id: "os-new", started: true });
    await tick();
    await tick();
    expect(sent.map((e) => e.type)).toEqual([
      "response.item.create",
      "response.create",
    ]);
    // The continue opened another response; the loop is busy until it ends.
    expect(l.busy).toBe(true);
    l.handle("del_1", { type: "response.created" });
    l.handle("del_1", { type: "response.completed" });
    expect(l.busy).toBe(false);
  });

  test("reports a thrown tool as an error output instead of stalling", async () => {
    const { l, sent } = loop(async () => {
      throw new Error("boom");
    });
    l.handle("del_1", { type: "response.created" });
    l.handle("del_1", {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c1", name: "steer_session" },
    });
    l.handle("del_1", { type: "response.completed" });
    await tick();
    await tick();
    const output = sent[0].item as { output: string };
    expect(JSON.parse(output.output)).toEqual({ error: "boom" });
    expect(sent[1].type).toBe("response.create");
  });

  test("does not continue a response that made no calls", async () => {
    const { l, sent } = loop(async () => ({}));
    l.handle("del_1", { type: "response.created" });
    l.handle("del_1", { type: "response.completed" });
    await tick();
    expect(sent).toEqual([]);
  });

  test("defers a typed-text continue until outstanding calls are answered", async () => {
    let release: (v: unknown) => void = () => {};
    const { l, sent } = loop(() => new Promise((r) => (release = r)));
    l.handle("del_1", { type: "response.created" });
    l.handle("del_1", {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c1", name: "list_current_work" },
    });
    l.requestContinue();
    expect(sent).toEqual([]);
    l.handle("del_1", { type: "response.completed" });
    release({ sessions: [] });
    await tick();
    await tick();
    expect(sent.map((e) => e.type)).toEqual([
      "response.item.create",
      "response.create",
    ]);
    // The continued response streams and ends with no further calls.
    l.handle("del_1", { type: "response.created" });
    l.handle("del_1", { type: "response.completed" });
    expect(sent.length).toBe(2);
    // Idle loop: a typed message runs the backend right away.
    l.requestContinue();
    expect(sent.at(-1)?.type).toBe("response.create");
    expect(sent.length).toBe(3);
  });

  test("defers a typed-text continue while a response is still streaming", async () => {
    const { l, sent } = loop(async () => ({}));
    l.handle("del_1", { type: "response.created", response: { id: "resp_1" } });
    // No function call yet, but the response has not finished: a second
    // response.create now would collide with it.
    expect(l.busy).toBe(true);
    l.requestContinue();
    expect(sent).toEqual([]);
    l.handle("del_1", { type: "response.completed" });
    await tick();
    expect(sent.map((e) => e.type)).toEqual(["response.create"]);
    // That continue opened a new response; it is busy again until it ends.
    l.handle("del_1", { type: "response.created", response: { id: "resp_2" } });
    expect(l.busy).toBe(true);
    l.handle("del_1", { type: "response.completed" });
    expect(l.busy).toBe(false);
    expect(sent.length).toBe(1);
  });

  test("a failed response frees the loop and runs the deferred typed text", () => {
    const { l, sent } = loop(async () => ({}));
    l.handle("del_1", { type: "response.created" });
    l.requestContinue();
    expect(sent).toEqual([]);
    l.handle("del_1", { type: "response.failed" });
    expect(sent.map((e) => e.type)).toEqual(["response.create"]);
    // Busy again: that create has not been answered with response.created.
    expect(l.busy).toBe(true);
    l.handle("del_1", { type: "response.created" });
    l.handle("del_1", { type: "response.completed" });
    expect(l.busy).toBe(false);
  });

  test("back-to-back typed messages open one response at a time", () => {
    const { l, sent } = loop(async () => ({}));
    // Two /live/text requests before the backend has acknowledged the first
    // response.create: the second waits rather than colliding.
    l.requestContinue();
    l.requestContinue();
    expect(sent.map((e) => e.type)).toEqual(["response.create"]);
    expect(l.busy).toBe(true);
    l.handle("del_1", { type: "response.created", response: { id: "resp_1" } });
    expect(l.busy).toBe(true);
    l.handle("del_1", { type: "response.completed" });
    // The deferred second message runs once the first response ends.
    expect(sent.map((e) => e.type)).toEqual([
      "response.create",
      "response.create",
    ]);
    l.handle("del_1", { type: "response.created", response: { id: "resp_2" } });
    l.handle("del_1", { type: "response.completed" });
    expect(l.busy).toBe(false);
    expect(sent.length).toBe(2);
  });
});
