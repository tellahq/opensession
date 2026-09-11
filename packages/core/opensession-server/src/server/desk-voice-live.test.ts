import { describe, expect, test } from "bun:test";
import {
  LIVE_CLIENT_ALLOWED_EVENTS,
  LIVE_ROW_GAP_MS,
  LiveResponseLoop,
  VoiceTranscriptRows,
  buildLiveSessionConfig,
} from "./desk-voice-live";
import { registerSessionControl, type SessionControl } from "./session-control";

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

describe("VoiceTranscriptRows", () => {
  function rows() {
    const out: Array<{ id: string; role: string; text: string }> = [];
    const r = new VoiceTranscriptRows({
      gapMs: LIVE_ROW_GAP_MS,
      idleMs: 60_000,
      rowId: (role, startMs) => `${role}-${startMs}`,
      onRow: (row) => out.push(row),
    });
    return { r, out };
  }

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

  test("drops whitespace-only rows", () => {
    const { r, out } = rows();
    r.push({ role: "user", delta: "  ", startMs: 0, endMs: 100 });
    r.flushAll();
    expect(out).toEqual([]);
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
    // Idle loop: a typed message runs the backend right away.
    l.requestContinue();
    expect(sent.at(-1)?.type).toBe("response.create");
    expect(sent.length).toBe(3);
  });
});
