import { describe, expect, test } from "bun:test";
import { buildSandboxScorecard, SCORECARD_THRESHOLDS } from "./scorecard";

const now = new Date("2026-08-10T12:00:00.000Z");
const event = (kind: string, fields: Record<string, unknown>, day = 10) => ({
  kind,
  time: `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`,
  ...fields,
});

describe("sandbox real-work scorecard", () => {
  test("a handful of successful smokes cannot pass the gate", () => {
    const scorecard = buildSandboxScorecard(
      [
        event("session_turn_metric", {
          environment: "sandbox",
          provider: "daytona",
          start_to_first_token_ms: 500,
          duration_ms: 1_000,
          outcome: "ok",
        }),
      ],
      { now },
    );

    expect(scorecard.gate.automaticReady).toBe(false);
    expect(scorecard.gate.readyToFlip).toBe(false);
    expect(scorecard.gate.reasons.join(" ")).toContain("more sandbox turns");
    expect(scorecard.gate.reasons.join(" ")).toContain("restart-survival");
  });

  test("passes the automatic gate only with sustained parity evidence", () => {
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < SCORECARD_THRESHOLDS.minimumTurnsPerEnvironment; i++) {
      const day = 6 + (i % SCORECARD_THRESHOLDS.minimumSandboxDays);
      events.push(
        event(
          "session_turn_metric",
          {
            environment: "worktree",
            provider: "host",
            start_to_first_event_ms: 350,
            start_to_first_token_ms: 1_000,
            duration_ms: 3_000,
            outcome: i === 0 ? "failed" : "ok",
          },
          day,
        ),
      );
      events.push(
        event(
          "session_turn_metric",
          {
            environment: "sandbox",
            provider: "daytona",
            sandbox_ready_ms: 90,
            start_to_first_event_ms: 300,
            start_to_first_token_ms: 900,
            duration_ms: 2_900,
            outcome: i === 0 ? "failed" : "ok",
          },
          day,
        ),
      );
    }
    for (
      let i = 0;
      i < SCORECARD_THRESHOLDS.minimumPreviewsPerEnvironment;
      i++
    ) {
      events.push(
        event("preview_ready_metric", {
          environment: "worktree",
          provider: "host",
          ready_ms: 2_000,
        }),
      );
      events.push(
        event("preview_ready_metric", {
          environment: "sandbox",
          provider: "daytona",
          ready_ms: 1_900,
        }),
      );
    }
    for (let i = 0; i < SCORECARD_THRESHOLDS.minimumSandboxResumes; i++) {
      events.push(
        event("sandbox_resume_metric", {
          provider: "daytona",
          resume_ms: 800,
          outcome: "ok",
        }),
      );
    }
    for (let i = 0; i < SCORECARD_THRESHOLDS.minimumRestartAttempts; i++) {
      events.push(
        event("sandbox_restart_survival_metric", {
          provider: "daytona",
          recovery_ms: 900,
          outcome: "ok",
        }),
      );
    }

    const scorecard = buildSandboxScorecard(events, { now });
    expect(scorecard.gate.automaticReady).toBe(true);
    expect(scorecard.gate.defaultFlipApproved).toBe(false);
    expect(scorecard.gate.readyToFlip).toBe(false);
    expect(
      scorecard.turns.find((score) => score.environment === "sandbox")
        ?.firstToken.medianMs,
    ).toBe(900);
  });

  test("fails when sandbox latency, failures, or restart survival regress", () => {
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i++) {
      const day = 6 + (i % 5);
      events.push(
        event(
          "session_turn_metric",
          {
            environment: "worktree",
            provider: "host",
            start_to_first_token_ms: 500,
            outcome: "ok",
          },
          day,
        ),
      );
      events.push(
        event(
          "session_turn_metric",
          {
            environment: "sandbox",
            provider: "daytona",
            start_to_first_token_ms: 900,
            outcome: i < 2 ? "failed" : "ok",
          },
          day,
        ),
      );
    }
    for (let i = 0; i < 5; i++) {
      events.push(
        event("preview_ready_metric", {
          environment: "worktree",
          provider: "host",
          ready_ms: 100,
        }),
      );
      events.push(
        event("preview_ready_metric", {
          environment: "sandbox",
          provider: "daytona",
          ready_ms: 90,
        }),
      );
      events.push(
        event("sandbox_resume_metric", {
          provider: "daytona",
          resume_ms: 80,
          outcome: "ok",
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      events.push(
        event("sandbox_restart_survival_metric", {
          provider: "daytona",
          recovery_ms: 90,
          outcome: i ? "ok" : "failed",
        }),
      );
    }

    const reasons = buildSandboxScorecard(events, { now }).gate.reasons.join(
      " ",
    );
    expect(reasons).toContain("first-token latency");
    expect(reasons).toContain("failure rate");
    expect(reasons).toContain("Not every observed sandbox run survived");
  });
});
