import { describe, expect, test } from "bun:test";
import {
  automaticallyRecoverableSessionSafety,
  publicSessionSafety,
  reconcileAutomaticallyRecoverableSessionSafety,
  safetyOperationLabel,
} from "./session-safety";

describe("public session safety state", () => {
  test("explains quarantine without exposing internal failure text", () => {
    const safety = publicSessionSafety({
      sessionId: "safety-session",
      reason: "SQLITE_IOERR secret internal path",
      commandKind: "turn:settle_outcome_projection",
      quarantinedAt: Date.parse("2026-08-26T12:00:00.000Z"),
      repairable: false,
    });

    expect(safety).toMatchObject({
      status: "paused_for_safety",
      automaticReconciliationRunning: false,
      pausedAt: "2026-08-26T12:00:00.000Z",
      operation: "finishing the current turn",
      repairAvailable: false,
    });
    expect(safety.explanation).not.toContain("SQLITE");
    expect(safety.explanation).toContain("paused");
  });

  test("turns actor command kinds into readable operations", () => {
    expect(safetyOperationLabel("delivery:ack_dispatch")).toBe(
      "delivering a message",
    );
    expect(safetyOperationLabel("run_state:reattaching")).toBe(
      "recovering the active run",
    );
  });

  test("automatically releases only proven actor-restart command fences", async () => {
    const recoverable = {
      sessionId: "recoverable-session",
      reason: "actor restarted after execution began",
      commandKind: "gateway:complete",
      quarantinedAt: 1,
      repairable: true,
    };
    const delivery = {
      ...recoverable,
      sessionId: "delivery-session",
      reason: "actor restarted before execution admission",
      commandKind: "delivery:complete_submit_command",
    };
    const contradiction = {
      ...recoverable,
      sessionId: "contradictory-session",
      reason: "receipt identity mismatch",
    };
    const unreconciled = {
      ...recoverable,
      sessionId: "unreconciled-session",
      repairable: false,
    };
    const committedOutbox = {
      ...recoverable,
      sessionId: "committed-outbox-session",
      reason: "Outbox 4000000000001815 crossed session ownership",
      commandKind: "core:ack_outbox",
      repairable: false,
    };
    expect(automaticallyRecoverableSessionSafety(recoverable)).toBe(true);
    expect(automaticallyRecoverableSessionSafety(delivery)).toBe(true);
    expect(automaticallyRecoverableSessionSafety(committedOutbox)).toBe(true);
    expect(publicSessionSafety(committedOutbox).repairAvailable).toBe(true);
    expect(automaticallyRecoverableSessionSafety(contradiction)).toBe(false);
    expect(automaticallyRecoverableSessionSafety(unreconciled)).toBe(false);

    const attempted: string[] = [];
    expect(
      await reconcileAutomaticallyRecoverableSessionSafety(
        [contradiction, recoverable, delivery, committedOutbox, unreconciled],
        async (sessionId) => {
          attempted.push(sessionId);
          return true;
        },
      ),
    ).toEqual([
      "recoverable-session",
      "delivery-session",
      "committed-outbox-session",
    ]);
    expect(attempted).toEqual([
      "recoverable-session",
      "delivery-session",
      "committed-outbox-session",
    ]);
  });
});
