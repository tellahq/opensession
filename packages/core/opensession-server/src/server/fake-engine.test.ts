/**
 * The fake engine driving runAgent's real fallback walk — token-free coverage
 * for the paths we previously only ever exercised in production: clean
 * passthrough, usage-exhaustion hops (model_switch + same-family session
 * resume), and the two-transient-failures circuit breaker (the 2026-07-17
 * stolen-socket class).
 *
 * agent-runner's module graph is import-safe under bun test (no socket binds,
 * no tickers at module scope — the run-rpc bind lives behind
 * startRunRpcServer's NODE_ENV=test guard and is not on this graph anyway).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import {
  __setEngineForTest,
  __setModelAvailabilityForTest,
  engineFamily,
  fallbackContinuationPrompt,
  runAgent,
} from "./agent-runner";
import { __setActiveRunsPathForTest, activeRunRecords } from "./run-journal";
import type { StreamEvent } from "./run-events";
import { makeFakeEngine } from "./testing/fake-engine";
import { stripContext } from "./prompt-context";

const journalTmp = `${mkdtempSync(`${tmpdir()}/fake-engine-test-`)}/active-runs.json`;
const prevJournal = __setActiveRunsPathForTest(journalTmp);

afterEach(() => {
  __setEngineForTest(null);
  __setModelAvailabilityForTest(null);
});
// Restore the journal path for any later test file in the suite.
process.on("beforeExit", () => __setActiveRunsPathForTest(prevJournal));

async function collect(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const types = (events: StreamEvent[]) => events.map((e) => e.type);

describe("fake engine through runAgent", () => {
  test("clean turn passes through verbatim (no fallback configured)", async () => {
    const fake = makeFakeEngine([
      {
        kind: "clean",
        engineSessionId: "ses_fake1",
        text: ["hello ", "world"],
        tools: [{ name: "bash", input: { command: "ls" }, result: "ok" }],
      },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "do the thing",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "none",
      }),
    );
    expect(types(events)).toEqual([
      "init",
      "text_chunk",
      "text_chunk",
      "tool_use",
      "tool_result",
      "done",
    ]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].model).toBe("pi/anthropic/claude-sonnet-5");
    expect(fake.calls[0].prompt).toBe("do the thing");
    const done = events.at(-1)!;
    expect(done.sessionId).toBe("ses_fake1");
  });

  test("terminal error passes through when no fallback is configured", async () => {
    const fake = makeFakeEngine([
      { kind: "error", content: "bridge disabled" },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "p",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "none",
      }),
    );
    expect(types(events)).toEqual(["init", "error"]);
    expect(events[1].content).toBe("bridge disabled");
  });

  test("usage exhaustion hops to the strongest auto-eligible fallback", async () => {
    const fake = makeFakeEngine([
      { kind: "usage_exhausted", engineSessionId: "ses_partial" },
      { kind: "clean", text: ["done on fallback"] },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "keep going",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "claude-opus-4-8",
        journal: { osSessionId: "bks-test-hop", kind: "prompt" },
      }),
    );
    // The partial attempt's init passes through, its exhausted done is
    // swallowed, then the structured switch cue + the fallback model's clean
    // turn. The switch is a timeline event, never assistant text. The walk
    // prefers the strongest AUTO candidate over the
    // configured preference when that preference ranks lower in the tier
    // graph — sonnet's best auto hop today is gpt-5.6-sol (cross-family).
    expect(types(events)).toEqual([
      "init",
      "model_switch",
      "init",
      "text_chunk",
      "done",
    ]);
    const sw = events[1];
    // fromModel is the picker-form id (resolveConcreteModel keeps native ids
    // native); toModel is the pi-mapped hop target.
    expect(sw.fromModel).toBe("claude-sonnet-5");
    expect(sw.toModel).toBe("pi/openai/gpt-5.6-sol");
    expect(sw.switchReason).toBe("out of credits");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].model).toBe("pi/openai/gpt-5.6-sol");
    // A direct runAgent caller may have no early transcript row to name.
    // runAgent assigns one stable id to the logical turn so both model attempts
    // upsert the same user entry instead of rendering the prompt twice.
    expect(fake.calls[0].opts.promptEntryId).toBeTruthy();
    expect(fake.calls[1].opts.promptEntryId).toBe(
      fake.calls[0].opts.promptEntryId,
    );
    expect(fake.calls[0].opts.promptEntryId).toBe(
      fake.calls[0].opts.startToken,
    );
    // Cross-family hop: no engine-session resume, just a fresh session with
    // a model-only recovery hint. It must not alter the visible user row.
    expect(fake.calls[1].sessionId).toBeUndefined();
    expect(fake.calls[1].prompt).toContain("previous attempt");
    expect(stripContext(fake.calls[1].prompt)).toBe("keep going");
    expect(fake.calls[1].journalKind).toBe("prompt-fallback");
    expect(fake.calls[0].firstJournaledAt).toBeTruthy();
    expect(fake.calls[1].firstJournaledAt).toBe(fake.calls[0].firstJournaledAt);
  });

  test("a provider handoff continues without another visible user turn", () => {
    const handoff = [
      "## Engine handoff",
      "Conversation transcript:",
      "- User: keep going",
      "- Assistant: partial work",
    ].join("\n");
    const continued = fallbackContinuationPrompt(handoff, "keep going", false);
    expect(continued).toContain("partial work");
    expect(stripContext(continued)).toBe("");
    // A fresh provider still needs an image-bearing prompt. Its stable entry
    // id makes this an upsert rather than another transcript row.
    expect(
      stripContext(fallbackContinuationPrompt(handoff, "inspect this", true)),
    ).toBe("inspect this");
  });

  test("Pi exhaustion stays on Pi while continuing through the model fallback walk", async () => {
    const fake = makeFakeEngine([
      { kind: "usage_exhausted", engineSessionId: "pi_partial" },
      { kind: "clean", text: ["continued on Pi"] },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "keep going",
        cwd: "/tmp",
        mcpServers: [],
        model: "pi/anthropic/claude-fable-5-1",
        fallbackModel: "claude-opus-4-8",
      }),
    );
    expect(types(events)).toEqual([
      "init",
      "model_switch",
      "init",
      "text_chunk",
      "done",
    ]);
    expect(events[1]).toMatchObject({
      type: "model_switch",
      fromModel: "pi/anthropic/claude-fable-5-1",
      toModel: "pi/openai/gpt-5.6-sol",
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].model).toBe("pi/anthropic/claude-fable-5-1");
    expect(fake.calls[1].model).toBe("pi/openai/gpt-5.6-sol");
    expect(fake.calls[1].sessionId).toBeUndefined();
  });

  test("known-dry Claude pool skips the doomed engine attempt and enters fallback directly", async () => {
    const fake = makeFakeEngine([{ kind: "clean", text: ["direct fallback"] }]);
    __setEngineForTest(fake.engine);
    __setModelAvailabilityForTest((_opts, model) =>
      model.includes("/anthropic/")
        ? "all configured accounts are exhausted"
        : null,
    );
    const events = await collect(
      runAgent({
        prompt: "keep going",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "claude-opus-4-8",
        journal: { osSessionId: "bks-test-dry-short-circuit", kind: "prompt" },
      }),
    );
    expect(types(events)).toEqual([
      "model_switch",
      "init",
      "text_chunk",
      "done",
    ]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].model).toBe("pi/openai/gpt-5.6-sol");
    // No source engine started, so there is no interrupted work to explain and
    // the fallback receives exactly the person's original prompt.
    expect(fake.calls[0].prompt).toBe("keep going");
    expect(events[0]).toMatchObject({
      type: "model_switch",
      fromModel: "claude-sonnet-5",
      toModel: "pi/openai/gpt-5.6-sol",
    });
  });

  test("known-dry Claude pool fails once without touching the engine when fallback is disabled", async () => {
    const fake = makeFakeEngine([{ kind: "clean", text: ["must not run"] }]);
    __setEngineForTest(fake.engine);
    __setModelAvailabilityForTest((_opts, model) =>
      model.includes("/anthropic/")
        ? "all configured accounts are exhausted"
        : null,
    );
    const events = await collect(
      runAgent({
        prompt: "p",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "none",
      }),
    );
    expect(fake.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      usageLimitExhausted: true,
    });
  });

  test("two consecutive transient failures trip the infrastructure circuit breaker", async () => {
    const fake = makeFakeEngine([
      { kind: "error", content: "fetch failed (socket hang up)" },
      { kind: "error", content: "fetch failed (socket hang up)" },
      { kind: "clean", text: ["should never run"] },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "p",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "claude-opus-4-8",
        journal: { osSessionId: "bks-test-breaker", kind: "prompt" },
      }),
    );
    const last = events.at(-1)!;
    expect(last.type).toBe("error");
    // Match the diagnosis, not the sentence: the notice copy is rewritten
    // from time to time (2353286f shortened this one, and this assertion
    // went red for weeks). What has to hold is that the run stops blaming
    // usage and names infrastructure, and still quotes the engine's error.
    expect(last.content).toMatch(/infrastructure/i);
    expect(last.content).toContain("fetch failed (socket hang up)");
    expect(last.usageLimitExhausted).toBeFalsy();
    // The walk stopped after the second transient death — no third model burned.
    expect(fake.calls).toHaveLength(2);
  });

  test("recovers from Claude's malformed terminal diagnostic", async () => {
    const fake = makeFakeEngine([
      {
        kind: "error",
        content:
          "Claude Code returned an error result: [ede_diagnostic] result_type=user " +
          "last_content_type=n/a stop_reason=null",
      },
      { kind: "clean", text: ["recovered"] },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "p",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-sonnet-5",
        fallbackModel: "claude-opus-5",
        journal: { osSessionId: "bks-test-claude-terminal", kind: "prompt" },
      }),
    );
    expect(fake.calls).toHaveLength(2);
    expect(events.find((event) => event.type === "model_switch")).toMatchObject(
      {
        fromModel: "claude-sonnet-5",
        toModel: "pi/openai/gpt-5.6-sol",
        temporaryFallback: true,
      },
    );
    expect(events.find((event) => event.type === "text_chunk")).toMatchObject({
      type: "text_chunk",
      text: "recovered",
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("stops on a provider overload without burning a same-provider fallback", async () => {
    const fake = makeFakeEngine([
      {
        kind: "error",
        content:
          "Our servers are currently overloaded. Please try again later.",
      },
      { kind: "clean", text: ["should never run"] },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "p",
        cwd: "/tmp",
        mcpServers: [],
        model: "gpt-5.6-sol",
        fallbackModel: "claude-opus-5",
      }),
    );
    expect(fake.calls).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events.at(-1)?.content).toBe(
      "The model provider is temporarily overloaded. Your session and completed work are preserved. " +
        "Retry this prompt in a minute.",
    );
  });

  test("journals the selected model behind a transient fallback for restart recovery", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = makeFakeEngine([
      { kind: "error", content: "fetch failed (socket hang up)" },
      { kind: "clean", text: ["recovered"], gate },
    ]);
    __setEngineForTest(fake.engine);
    const collecting = collect(
      runAgent({
        prompt: "p",
        cwd: "/tmp",
        mcpServers: [],
        model: "dial/medium",
        fallbackModel: "claude-opus-5",
        journal: { osSessionId: "bks-test-transient-journal", kind: "prompt" },
      }),
    );
    while (fake.calls.length < 2) await Bun.sleep(5);

    const run = activeRunRecords().find(
      (record) => record.osSessionId === "bks-test-transient-journal",
    );
    release();
    const events = await collecting;

    expect(run?.model).toBe("pi/anthropic/claude-opus-5");
    expect(run?.selectedModel).toBe("dial/medium");
    expect(run?.transientFallback).toBe(true);
    const switchEvent = events.find((event) => event.type === "model_switch");
    expect(switchEvent?.temporaryFallback).toBe(true);
  });

  test("pi model ids reach the engine seam unmapped (no pi rewrite)", async () => {
    // The seam sits AFTER model mapping and BEFORE the pi/pi branch,
    // so this asserts both halves of the pi dispatch contract: toPiModel
    // leaves pi/<provider>/<model> ids untouched, and a fake engine still
    // intercepts pi-model turns.
    const fake = makeFakeEngine([
      {
        kind: "clean",
        engineSessionId: "0199fake-pi-session",
        text: ["pi hi"],
      },
    ]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "pi turn",
        cwd: "/tmp",
        mcpServers: [],
        model: "pi/anthropic/claude-opus-5",
        fallbackModel: "none",
      }),
    );
    expect(types(events)).toEqual(["init", "text_chunk", "done"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].model).toBe("pi/anthropic/claude-opus-5");
  });

  test("script exhaustion fails loud instead of hanging", async () => {
    const fake = makeFakeEngine([]);
    __setEngineForTest(fake.engine);
    const events = await collect(
      runAgent({
        prompt: "p",
        cwd: "/tmp",
        model: "claude-sonnet-5",
        fallbackModel: "none",
        mcpServers: [],
      }),
    );
    expect(events.at(-1)!.type).toBe("error");
    expect(events.at(-1)!.content).toContain("script exhausted");
  });
});
