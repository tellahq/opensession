import { expect, test } from "bun:test";
import { rollupAuditContents } from "./analytics";

const event = (fields: Record<string, unknown>) =>
  JSON.stringify({
    time: "2026-08-20T10:00:00.000Z",
    service: "opensession",
    ...fields,
  });

const rollup = (...events: Record<string, unknown>[]) =>
  rollupAuditContents("2026-08-20", events.map(event).join("\n"));

test("rolls a Pi retry chain into one logical session turn", () => {
  const value = rollup(
    {
      msg: "pi_turn",
      direction: "out",
      session: "os-session-a",
      run_kind: "prompt",
      model: "pi/anthropic/claude-opus-5",
      ok: false,
      duration_ms: 100,
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
      total_cost_usd: 1,
    },
    {
      msg: "pi_turn",
      direction: "out",
      session: "os-session-a",
      run_kind: "prompt-fallback",
      model: "pi/openai/gpt-5.6",
      ok: true,
      duration_ms: 200,
      input_tokens: 30,
      output_tokens: 4,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 5,
      total_cost_usd: 2,
    },
    // The pre-cutover runner mirrored this terminal. It must not double count.
    {
      kind: "result",
      session_id: "os-session-a",
      model: "pi/openai/gpt-5.6",
      input_tokens: 30,
      output_tokens: 4,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 5,
      total_cost_usd: 2,
    },
    {
      kind: "session_turn_metric",
      session_id: "os-session-a",
      duration_ms: 500,
      outcome: "ok",
    },
  );

  expect(value.turns).toBe(1);
  expect(value.errors).toBe(0);
  expect(value.durationMs).toBe(500);
  expect(value.tokens).toEqual({
    input: 40,
    output: 6,
    cacheRead: 60,
    cacheWrite: 8,
  });
  expect(value.costUsd).toBe(3);
  expect(value.bySession["os-session-a"]).toMatchObject({
    turns: 1,
    output: 6,
    errors: 0,
  });
  expect(value.byModel["claude-opus-5"]).toMatchObject({ turns: 1, output: 2 });
  expect(value.byModel["gpt-5.6"]).toMatchObject({ turns: 1, output: 4 });
});

test("counts failed Pi logical turns without multiplying attempt duration", () => {
  const value = rollup(
    {
      msg: "pi_turn",
      direction: "out",
      session: "os-session-b",
      run_kind: "automation",
      model: "pi/anthropic/claude-fable-5-1",
      ok: false,
      duration_ms: 900,
      error: "provider failed",
    },
    {
      kind: "session_turn_metric",
      session_id: "os-session-b",
      duration_ms: 1_000,
      outcome: "failed",
    },
  );

  expect(value.turns).toBe(1);
  expect(value.errors).toBe(1);
  expect(value.durationMs).toBe(1_000);
  expect(value.bySession["os-session-b"]).toMatchObject({
    kind: "automation",
    turns: 1,
    errors: 1,
  });
});

test("counts post-cutover logical metrics even when attempt telemetry is remote", () => {
  const value = rollup({
    kind: "session_turn_metric",
    session_id: "os-session-remote",
    duration_ms: 750,
    outcome: "ok",
  });

  expect(value.turns).toBe(1);
  expect(value.durationMs).toBe(750);
  expect(value.bySession["os-session-remote"]).toMatchObject({ turns: 1 });
});

test("keeps utility Pi usage out of active session counts", () => {
  const value = rollup({
    msg: "pi_turn",
    direction: "out",
    model: "pi/anthropic/claude-haiku-4-5",
    ok: true,
    input_tokens: 7,
    output_tokens: 3,
    cache_read_input_tokens: 11,
    cache_creation_input_tokens: 2,
  });

  expect(value.turns).toBe(0);
  expect(value.bySession).toEqual({});
  expect(value.tokens).toEqual({
    input: 7,
    output: 3,
    cacheRead: 11,
    cacheWrite: 2,
  });
});

test("preserves legacy result rollups", () => {
  const value = rollup({
    kind: "result",
    session_id: "os-legacy",
    run_kind: "prompt",
    model: "opencode/anthropic/claude-opus-5",
    input_tokens: 2,
    output_tokens: 3,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 7,
    total_cost_usd: 1.5,
  });

  expect(value.turns).toBe(1);
  expect(value.tokens).toEqual({
    input: 2,
    output: 3,
    cacheRead: 5,
    cacheWrite: 7,
  });
  expect(value.bySession["os-legacy"]).toMatchObject({ turns: 1, output: 3 });
});
