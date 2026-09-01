import { afterEach, describe, expect, test } from "bun:test";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent } from "./run-events";
import {
  _setRunAgentForTests,
  extractLastFencedJson,
  runAgentCollect,
  validateJsonSchema,
  workflowExecutor,
} from "./workflow-execute";
import { DEFAULT_FALLBACK_MODEL } from "./models";
import { WORKFLOW_LIMITS, type WorkflowExecCtx } from "./workflow-types";

afterEach(() => {
  _setRunAgentForTests(null);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Mock runAgent: one StreamEvent[] script per call; records every opts. */
function mockRunAgent(
  scripts: Array<StreamEvent[] | ((opts: RunAgentOpts) => StreamEvent[])>,
) {
  const calls: RunAgentOpts[] = [];
  async function* fake(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
    const idx = calls.length;
    calls.push(opts);
    const script = scripts[Math.min(idx, scripts.length - 1)];
    const events = typeof script === "function" ? script(opts) : script;
    for (const event of events) yield event;
  }
  _setRunAgentForTests(fake);
  return calls;
}

function reply(text: string, extra: Partial<StreamEvent> = {}): StreamEvent[] {
  return [
    { type: "init", sessionId: "oc-1", model: "pi/anthropic/claude-sonnet-5" },
    { type: "text_chunk", text },
    {
      type: "done",
      model: "pi/anthropic/claude-sonnet-5",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 10,
      },
      ...extra,
    },
  ];
}

function makeCtx(overrides: Partial<WorkflowExecCtx> = {}): WorkflowExecCtx {
  return {
    runId: "wf-test",
    sessionId: "bks-test",
    cwd: "/tmp/wf-test",
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ── validateJsonSchema ───────────────────────────────────────────────────────

describe("validateJsonSchema", () => {
  test("valid nested object passes", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        files: { type: "array", items: { type: "string" } },
        meta: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
      required: ["name", "files"],
    };
    const value = {
      name: "a",
      count: 2,
      files: ["x", "y"],
      meta: { ok: true },
    };
    expect(validateJsonSchema(value, schema)).toEqual([]);
  });

  test("type mismatch at root", () => {
    expect(validateJsonSchema(42, { type: "string" })).toEqual([
      "(root): expected string, got number",
    ]);
  });

  test("integer rejects fractions, accepts whole numbers", () => {
    expect(validateJsonSchema(1.5, { type: "integer" })).toEqual([
      "(root): expected integer, got number",
    ]);
    expect(validateJsonSchema(3, { type: "integer" })).toEqual([]);
  });

  test("nested array error carries the index path", () => {
    const schema = {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
    };
    expect(validateJsonSchema({ files: ["a", "b", 3] }, schema)).toEqual([
      "files[2]: expected string, got number",
    ]);
  });

  test("missing required property", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    expect(validateJsonSchema({}, schema)).toEqual([
      "id: missing required property",
    ]);
  });

  test("enum + const", () => {
    expect(validateJsonSchema("red", { enum: ["red", "blue"] })).toEqual([]);
    expect(validateJsonSchema("green", { enum: ["red", "blue"] })).toEqual([
      '(root): expected one of "red", "blue"',
    ]);
    expect(validateJsonSchema(5, { const: 5 })).toEqual([]);
    expect(validateJsonSchema(6, { const: 5 })[0]).toContain(
      "expected const 5",
    );
  });

  test("anyOf passes when any branch matches", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(validateJsonSchema("x", schema)).toEqual([]);
    expect(validateJsonSchema(1, schema)).toEqual([]);
    expect(validateJsonSchema(true, schema)).toEqual([
      "(root): matched no anyOf branch",
    ]);
  });

  test("additionalProperties:false flags unknown keys", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    expect(validateJsonSchema({ a: "x", b: 1 }, schema)).toEqual([
      "b: unexpected property",
    ]);
  });

  test("null type", () => {
    expect(validateJsonSchema(null, { type: "null" })).toEqual([]);
    expect(validateJsonSchema("x", { type: "null" })).toEqual([
      "(root): expected null, got string",
    ]);
  });

  test("required Object.prototype key is really required (own properties only)", () => {
    const schema = { type: "object", required: ["constructor"] };
    // {} inherits `constructor` from Object.prototype — that must NOT satisfy required.
    expect(validateJsonSchema({}, schema)).toEqual([
      "constructor: missing required property",
    ]);
    expect(validateJsonSchema({ constructor: "mine" }, schema)).toEqual([]);
  });

  test("property named toString only validates when it's an own property", () => {
    const schema = {
      type: "object",
      properties: { toString: { type: "string" } },
    };
    // {} inherits toString (a function) — must not false-reject.
    expect(validateJsonSchema({}, schema)).toEqual([]);
    expect(validateJsonSchema({ toString: "text" }, schema)).toEqual([]);
    expect(validateJsonSchema({ toString: 3 }, schema)).toEqual([
      "toString: expected string, got number",
    ]);
  });

  test("additionalProperties:false flags prototype-named keys", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    // "constructor" in props hits Object.prototype — must still be flagged as unexpected.
    expect(validateJsonSchema({ a: "x", constructor: 1 }, schema)).toEqual([
      "constructor: unexpected property",
    ]);
  });

  test("array-form type: nullable idiom accepts any listed type, rejects others", () => {
    const schema = { type: ["string", "null"] };
    expect(validateJsonSchema("x", schema)).toEqual([]);
    expect(validateJsonSchema(null, schema)).toEqual([]);
    expect(validateJsonSchema(5, schema)).toEqual([
      "(root): expected string | null, got number",
    ]);
  });

  test("tuple-form items validates index-wise with pathed errors; extras pass", () => {
    const schema = {
      type: "object",
      properties: {
        pair: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
      },
    };
    expect(validateJsonSchema({ pair: ["a", 1] }, schema)).toEqual([]);
    expect(validateJsonSchema({ pair: ["a", "b"] }, schema)).toEqual([
      "pair[1]: expected number, got string",
    ]);
    // Items beyond the tuple pass.
    expect(validateJsonSchema({ pair: ["a", 1, true, {}] }, schema)).toEqual(
      [],
    );
  });

  test("a schema node that is itself an array errors instead of validating nothing", () => {
    expect(validateJsonSchema("x", [{ type: "string" }])).toEqual([
      "(root): invalid schema node (array where a schema object was expected)",
    ]);
    // Nested: an array where a property schema should be.
    const schema = { type: "object", properties: { a: [{ type: "string" }] } };
    expect(validateJsonSchema({ a: "x" }, schema)).toEqual([
      "a: invalid schema node (array where a schema object was expected)",
    ]);
  });
});

// ── extractLastFencedJson ────────────────────────────────────────────────────

describe("extractLastFencedJson", () => {
  test("single fenced json block", () => {
    const text = 'Here you go:\n```json\n{"a": 1}\n```\nDone.';
    expect(extractLastFencedJson(text)).toBe('{"a": 1}');
  });

  test("last block wins", () => {
    const text = '```json\n{"a": 1}\n```\nActually:\n```json\n{"a": 2}\n```';
    expect(extractLastFencedJson(text)).toBe('{"a": 2}');
  });

  test("untagged fence works as fallback", () => {
    expect(extractLastFencedJson('```\n{"b": 3}\n```')).toBe('{"b": 3}');
  });

  test("no fence returns null (caller falls back to whole reply)", () => {
    expect(extractLastFencedJson('{"a": 1}')).toBeNull();
    expect(extractLastFencedJson("just some prose")).toBeNull();
  });
});

// ── runAgentCollect ──────────────────────────────────────────────────────────

describe("runAgentCollect", () => {
  test("accumulates text, captures session id, model, tokens", async () => {
    mockRunAgent([
      [
        { type: "init", sessionId: "oc-abc", model: "pi/openai/gpt-5.5" },
        { type: "text_chunk", text: "hello " },
        { type: "tool_use", toolName: "Read" },
        { type: "text_chunk", text: "world" },
        {
          type: "done",
          model: "pi/openai/gpt-5.5",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextTokens: 100,
          },
        },
      ],
    ]);
    const res = await runAgentCollect({
      prompt: "p",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(res.text).toBe("hello world");
    expect(res.engineSessionId).toBe("oc-abc");
    expect(res.model).toBe("pi/openai/gpt-5.5");
    expect(res.tokens).toEqual({ input: 100, output: 20 });
    expect(res.toolCalls).toBe(1);
    expect(res.error).toBeUndefined();
  });

  test("captures an engine id reported before live event attachment", async () => {
    const reported: string[] = [];
    const runner = async function* (
      _opts: RunAgentOpts,
      onEngineSession?: (engineSessionId: string) => void,
    ): AsyncGenerator<StreamEvent> {
      onEngineSession?.("pi-early");
      yield { type: "text_chunk", text: "finished" };
      yield { type: "done" };
    };

    const res = await runAgentCollect(
      { prompt: "p", cwd: "/tmp", mcpServers: [] },
      undefined,
      (id) => reported.push(id),
      runner,
    );

    expect(res.engineSessionId).toBe("pi-early");
    expect(reported).toEqual(["pi-early"]);
  });

  test("error event surfaces as error", async () => {
    mockRunAgent([
      [
        { type: "init", sessionId: "oc-err" },
        { type: "error", content: "engine exploded" },
      ],
    ]);
    const res = await runAgentCollect({
      prompt: "p",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(res.error).toBe("engine exploded");
  });

  test("thrown generator surfaces as error", async () => {
    _setRunAgentForTests(async function* () {
      yield { type: "init", sessionId: "oc-1" } as StreamEvent;
      throw new Error("boom");
    });
    const res = await runAgentCollect({
      prompt: "p",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(res.error).toBe("boom");
  });

  test("legacy runner notice after a fallback does not leak into collected text", async () => {
    // Compatibility with an older/remote runner: partial first-attempt text →
    // model_switch → synthetic "[runner] …" notice chunk → fresh init +
    // complete reply on the fallback model → done.
    mockRunAgent([
      [
        {
          type: "init",
          sessionId: "oc-a",
          model: "pi/anthropic/claude-fable-5-1",
        },
        { type: "text_chunk", text: "I started answering but " },
        {
          type: "model_switch",
          fromModel: "pi/anthropic/claude-fable-5-1",
          toModel: "pi/anthropic/claude-sonnet-5",
        },
        {
          type: "text_chunk",
          text: "\n\n[runner] pi/anthropic/claude-fable-5-1 usage exhausted on all accounts; falling back to pi/anthropic/claude-sonnet-5.\n\n",
        },
        {
          type: "init",
          sessionId: "oc-b",
          model: "pi/anthropic/claude-sonnet-5",
        },
        { type: "text_chunk", text: "the complete " },
        { type: "text_chunk", text: "fresh reply" },
        {
          type: "done",
          model: "pi/anthropic/claude-sonnet-5",
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextTokens: 7,
          },
        },
      ],
    ]);
    const res = await runAgentCollect({
      prompt: "p",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(res.text).toBe("the complete fresh reply");
    expect(res.model).toBe("pi/anthropic/claude-sonnet-5");
    expect(res.engineSessionId).toBe("oc-b");
    expect(res.error).toBeUndefined();
  });

  test("model_switch without a runner-notice chunk keeps the fresh reply intact", async () => {
    mockRunAgent([
      [
        { type: "init", sessionId: "oc-a", model: "m-1" },
        { type: "text_chunk", text: "partial" },
        { type: "model_switch", fromModel: "m-1", toModel: "m-2" },
        { type: "init", sessionId: "oc-b", model: "m-2" },
        { type: "text_chunk", text: "fresh" },
        { type: "done", model: "m-2" },
      ],
    ]);
    const res = await runAgentCollect({
      prompt: "p",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(res.text).toBe("fresh");
  });

  test("abort mid-stream returns cancelled even if the run hangs", async () => {
    const hang = new Promise<never>(() => {});
    _setRunAgentForTests(async function* () {
      yield { type: "init", sessionId: "oc-hang" } as StreamEvent;
      yield { type: "text_chunk", text: "partial" } as StreamEvent;
      await hang;
    });
    const ac = new AbortController();
    const p = runAgentCollect(
      { prompt: "p", cwd: "/tmp", mcpServers: [] },
      ac.signal,
    );
    await Bun.sleep(10);
    ac.abort();
    const res = await p;
    expect(res.error).toBe("cancelled");
    expect(res.text).toBe("partial");
    expect(res.engineSessionId).toBe("oc-hang");
  });
});

// ── workflowExecutor ─────────────────────────────────────────────────────────

describe("workflowExecutor", () => {
  test("plain text call: preamble-wrapped prompt, ask mode, workflow kind", async () => {
    const calls = mockRunAgent([reply("the answer")]);
    const outcome = await workflowExecutor.execute(
      { prompt: "list the files", opts: {}, seq: 0 },
      makeCtx({ user: "alex", defaultModel: "gpt-5.5" }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("the answer");
    expect(outcome.tokens).toEqual({ input: 10, output: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("list the files");
    expect(calls[0].prompt).toContain(
      "focused worker agent inside a scripted workflow",
    );
    expect(calls[0].mode).toBe("ask");
    expect(calls[0].cwd).toBe("/tmp/wf-test");
    expect(calls[0].user).toBe("alex");
    expect(calls[0].journal).toEqual({ kind: "workflow" });
    expect(calls[0].fallbackModel).toBe(DEFAULT_FALLBACK_MODEL);
    expect(calls[0].accountAffinityKey).toBe("workflow:wf-test:0");
    // Workflow workers keep the full connector set, now spelled out rather
    // than inherited from an omitted field (McpScope).
    expect(calls[0].mcpServers).toBe("all");
    expect(calls[0].inProcessMcp).toBeUndefined();
    expect(calls[0].deniedTools).toBeUndefined();
  });

  test("parallel workers get distinct account affinity while one worker's retries stay sticky", async () => {
    const calls = mockRunAgent([reply("first"), reply("second")]);
    await workflowExecutor.execute(
      { prompt: "a", opts: {}, seq: 3 },
      makeCtx({ runId: "wf-affinity" }),
    );
    await workflowExecutor.execute(
      { prompt: "b", opts: {}, seq: 4 },
      makeCtx({ runId: "wf-affinity" }),
    );
    expect(calls[0].accountAffinityKey).toBe("workflow:wf-affinity:3");
    expect(calls[1].accountAffinityKey).toBe("workflow:wf-affinity:4");
  });

  test("model precedence: opts.model > ctx.defaultModel", async () => {
    const calls = mockRunAgent([reply("x"), reply("y")]);
    await workflowExecutor.execute(
      { prompt: "a", opts: { model: "claude-opus-4-8" }, seq: 0 },
      makeCtx({ defaultModel: "gpt-5.5" }),
    );
    await workflowExecutor.execute(
      { prompt: "b", opts: {}, seq: 1 },
      makeCtx({ defaultModel: "gpt-5.5" }),
    );
    expect(calls[0].model).toBe("claude-opus-4-8");
    expect(calls[1].model).toBe("gpt-5.6-sol");
  });

  test("effort: sent when the model offers the level, dropped when it doesn't", async () => {
    const calls = mockRunAgent([reply("x")]);
    await workflowExecutor.execute(
      {
        prompt: "verify",
        opts: { model: "claude-opus-5", effort: "xhigh" },
        seq: 0,
      },
      makeCtx(),
    );
    // Trimmed and lowercased, so a script's stray whitespace or capital still lands.
    await workflowExecutor.execute(
      {
        prompt: "verify",
        opts: { model: "claude-opus-5", effort: " XHigh " },
        seq: 1,
      },
      makeCtx(),
    );
    // Haiku's ladder is high/max, so "low" is dropped rather than coerced: the
    // runner would have rewritten it to the model default anyway.
    await workflowExecutor.execute(
      {
        prompt: "extract",
        opts: { model: "claude-haiku-4-5", effort: "low" },
        seq: 2,
      },
      makeCtx(),
    );
    await workflowExecutor.execute(
      { prompt: "plain", opts: {}, seq: 3 },
      makeCtx(),
    );
    expect(calls[0].effort).toBe("xhigh");
    expect(calls[1].effort).toBe("xhigh");
    expect(calls[2].effort).toBeUndefined();
    expect(calls[3].effort).toBeUndefined();
  });

  test("result capped at maxResultChars", async () => {
    const huge = "x".repeat(WORKFLOW_LIMITS.maxResultChars + 500);
    mockRunAgent([reply(huge)]);
    const outcome = await workflowExecutor.execute(
      { prompt: "p", opts: {}, seq: 0 },
      makeCtx(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.text?.length).toBe(WORKFLOW_LIMITS.maxResultChars);
  });

  test("agent error → ok:false with the error", async () => {
    mockRunAgent([[{ type: "error", content: "no accounts left" }]]);
    const outcome = await workflowExecutor.execute(
      { prompt: "p", opts: {}, seq: 0 },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("no accounts left");
  });

  test("already-cancelled workflow → ok:false workflow cancelled", async () => {
    const calls = mockRunAgent([reply("never")]);
    const ac = new AbortController();
    ac.abort();
    const outcome = await workflowExecutor.execute(
      { prompt: "p", opts: {}, seq: 0 },
      makeCtx({ signal: ac.signal }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("workflow cancelled");
    expect(calls).toHaveLength(0);
  });

  test("schema: valid fenced json → structured object", async () => {
    const schema = {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
      required: ["files"],
    };
    const calls = mockRunAgent([
      reply('Sure:\n```json\n{"files": ["a.ts", "b.ts"]}\n```'),
    ]);
    const outcome = await workflowExecutor.execute(
      { prompt: "list files", opts: { schema }, seq: 0 },
      makeCtx(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.structured).toEqual({ files: ["a.ts", "b.ts"] });
    expect(calls[0].prompt).toContain("JSON Schema");
    expect(calls[0].prompt).toContain('"files"');
  });

  test("schema: whole-reply JSON fallback when no fence", async () => {
    mockRunAgent([reply('{"n": 1}')]);
    const outcome = await workflowExecutor.execute(
      { prompt: "p", opts: { schema: { type: "object" } }, seq: 0 },
      makeCtx(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.structured).toEqual({ n: 1 });
  });

  test("schema retry: resumes the same engine session with the validation errors", async () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };
    const calls = mockRunAgent([
      reply('```json\n{"count": "three"}\n```'),
      reply('```json\n{"count": 3}\n```'),
    ]);
    const outcome = await workflowExecutor.execute(
      { prompt: "count things", opts: { schema }, seq: 0 },
      makeCtx(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.structured).toEqual({ count: 3 });
    expect(calls).toHaveLength(2);
    // First attempt starts fresh; the retry resumes the failed attempt's session.
    expect(calls[0].sessionId).toBeUndefined();
    expect(calls[1].sessionId).toBe("oc-1");
    expect(calls[1].accountAffinityKey).toBe(calls[0].accountAffinityKey);
    expect(calls[1].prompt).toContain("failed JSON Schema validation");
    expect(calls[1].prompt).toContain("count: expected integer, got string");
    // Retry prompts are self-contained (the session resume can be silently
    // lost): they restate the original task prompt AND the full schema.
    expect(calls[1].prompt).toContain("count things");
    expect(calls[1].prompt).toContain(JSON.stringify(schema));
    // Tokens accumulate across attempts.
    expect(outcome.tokens).toEqual({ input: 20, output: 10 });
  });

  test("schema: garbage on every attempt → ok:false after schemaAttempts", async () => {
    const calls = mockRunAgent([reply("not json at all, ever")]);
    const outcome = await workflowExecutor.execute(
      { prompt: "p", opts: { schema: { type: "object" } }, seq: 0 },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(WORKFLOW_LIMITS.schemaAttempts);
    expect(outcome.error).toContain(
      `after ${WORKFLOW_LIMITS.schemaAttempts} attempts`,
    );
    expect(outcome.error).toContain("not valid JSON");
  });

  test("semaphore-friendly: concurrent executes don't share state", async () => {
    let call = 0;
    _setRunAgentForTests(async function* (opts: RunAgentOpts) {
      const n = ++call;
      await Bun.sleep(5);
      yield { type: "init", sessionId: `oc-${n}` } as StreamEvent;
      yield {
        type: "text_chunk",
        text: `result-${opts.prompt.slice(-1)}`,
      } as StreamEvent;
      yield { type: "done" } as StreamEvent;
    });
    const ctx = makeCtx();
    const [a, b] = await Promise.all([
      workflowExecutor.execute({ prompt: "job A", opts: {}, seq: 0 }, ctx),
      workflowExecutor.execute({ prompt: "job B", opts: {}, seq: 1 }, ctx),
    ]);
    expect(a.text).toBe("result-A");
    expect(b.text).toBe("result-B");
  });
});
