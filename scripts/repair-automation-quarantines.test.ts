import { describe, expect, test } from "bun:test";
import {
  automationLedgerVerdicts,
  journaledSessionIds,
} from "./repair-automation-quarantines";

describe("automation ledger verdicts", () => {
  test("indexes each run's terminal status by session id", () => {
    const verdicts = automationLedgerVerdicts([
      {
        runs: [
          { at: "1", sessionId: "os-a", trigger: "cron", status: "ok" },
          { at: "2", sessionId: "os-b", trigger: "cron", status: "error" },
        ],
      },
      {
        runs: [
          { at: "3", sessionId: "os-c", trigger: "manual", status: "running" },
        ],
      },
    ]);

    expect(verdicts.get("os-a")).toBe("ok");
    expect(verdicts.get("os-b")).toBe("error");
    expect(verdicts.get("os-c")).toBe("running");
    expect(verdicts.get("os-unknown")).toBeUndefined();
  });

  test("a still-running duplicate wins, so the repair stays fail-closed", () => {
    const verdicts = automationLedgerVerdicts([
      {
        runs: [
          { at: "1", sessionId: "os-dup", trigger: "cron", status: "running" },
          { at: "2", sessionId: "os-dup", trigger: "cron", status: "ok" },
        ],
      },
    ]);

    expect(verdicts.get("os-dup")).toBe("running");
  });

  test("tolerates automations with no run ledger", () => {
    expect(automationLedgerVerdicts([{}, { runs: [] }]).size).toBe(0);
  });
});

describe("journaled session ids", () => {
  test("collects every alias a record can be owned under", () => {
    const owned = journaledSessionIds([
      {
        runKey: "rh-1",
        osSessionId: "os-a",
        claudeSessionId: "engine-a",
        cwd: "/tmp",
      },
      { runKey: "rh-2", cwd: "/tmp" },
    ] as any);

    expect([...owned].sort()).toEqual(["engine-a", "os-a", "rh-1", "rh-2"]);
  });

  test("an empty journal owns nothing", () => {
    expect(journaledSessionIds([]).size).toBe(0);
  });
});
