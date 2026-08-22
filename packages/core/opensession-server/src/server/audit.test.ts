import { describe, expect, test } from "bun:test";
import { buildAuditDigestFromLines } from "./audit";

const digest = (...events: Array<Record<string, unknown>>) =>
  buildAuditDigestFromLines("2026-08-19", events.map((event) => JSON.stringify(event)).join("\n"));

function totals(value: Record<string, unknown>): Record<string, unknown> {
  return value.totals as Record<string, unknown>;
}

function byRunKind(value: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return value.byRunKind as Record<string, Record<string, unknown>>;
}

describe("buildAuditDigest", () => {
  test("keeps historical generic terminals and learns metadata from later events", () => {
    const value = digest(
      { msg: "session_created", session_id: "legacy" },
      {
        kind: "user_prompt",
        session_id: "legacy",
        run_kind: "automation",
        mode: "ask",
        model: "opencode/anthropic/claude-fable-5",
        text_snippet: "check the queue",
      },
      {
        kind: "result",
        session_id: "legacy",
        run_kind: "automation",
        mode: "ask",
        duration_ms: 120,
        total_cost_usd: 1.25,
      },
      {
        kind: "error",
        session_id: "legacy-error",
        run_kind: "prompt",
        mode: "code",
        error: "historical failure",
      },
    );

    expect(totals(value)).toMatchObject({ turns: 1, errors: 1, costUsd: 1.25 });
    expect(byRunKind(value).automation).toMatchObject({ sessions: 1, turns: 1, costUsd: 1.25 });
    expect(byRunKind(value).prompt).toMatchObject({ sessions: 1, errors: 1 });
    expect(byRunKind(value)["?"]).toBeUndefined();
  });

  test("counts each terminal Pi turn once across retries, fallbacks, and mixed generic events", () => {
    const value = digest(
      { msg: "session_created", session_id: "pi-session" },
      {
        msg: "pi_turn",
        direction: "out",
        session: "pi-session",
        request_id: "attempt-1",
        run_key: "native-session",
        run_kind: "prompt",
        mode: "code",
        model: "pi/anthropic/claude-fable-5",
        ok: false,
        error: "primary exhausted",
        total_cost_usd: 0.25,
      },
      {
        kind: "error",
        session_id: "pi-session",
        run_kind: "prompt",
        mode: "code",
        error: "mirrored attempt failure",
      },
      {
        msg: "pi_turn",
        kind: "account_switch",
        direction: "out",
        session: "pi-session",
        request_id: "attempt-1",
        run_kind: "prompt",
        model: "pi/openai/gpt-5.6-sol",
        total_cost_usd: 20,
      },
      {
        msg: "pi_turn",
        direction: "out",
        session: "pi-session",
        request_id: "attempt-2",
        run_key: "fallback-native-session",
        run_kind: "prompt-fallback",
        mode: "code",
        model: "pi/openai/gpt-5.6-sol",
        ok: true,
        total_cost_usd: 0.75,
      },
      {
        kind: "result",
        session_id: "pi-session",
        run_kind: "prompt-fallback",
        total_cost_usd: 99,
      },
      {
        kind: "session_turn_metric",
        session_id: "pi-session",
        duration_ms: 500,
        outcome: "ok",
      },
      {
        msg: "pi_turn",
        direction: "out",
        session: "pi-session",
        request_id: "attempt-3",
        run_kind: "prompt",
        mode: "code",
        model: "pi/openai/gpt-5.6-sol",
        ok: false,
        error: "terminal Pi failure",
        total_cost_usd: 0.5,
      },
      {
        kind: "error",
        session_id: "pi-session",
        run_kind: "prompt",
        error: "mirrored terminal failure",
      },
      {
        kind: "session_turn_metric",
        session_id: "pi-session",
        duration_ms: 200,
        outcome: "failed",
      },
      // Utility Pi calls have no Open Session id and never join session totals.
      {
        msg: "pi_turn",
        direction: "out",
        run_key: "oneshot-title",
        run_kind: "prompt",
        model: "pi/openai/gpt-5.6-sol",
        ok: true,
        total_cost_usd: 40,
      },
      { msg: "pi_oneshot", status: "ok", run_key: "oneshot-title" },
    );

    expect(totals(value)).toMatchObject({
      sessions: 1,
      turns: 2,
      errors: 1,
      costUsd: 1.5,
    });
    expect(byRunKind(value).prompt).toMatchObject({
      sessions: 1,
      turns: 2,
      errors: 1,
      costUsd: 1.5,
    });
    expect(byRunKind(value)["?"]).toBeUndefined();
    expect(value.oneshots).toEqual({ total: 1, failed: 0 });
    expect(value.errorGroups).toEqual([
      expect.objectContaining({ count: 1, sample: "terminal Pi failure", runKinds: ["prompt"] }),
    ]);
  });
});
