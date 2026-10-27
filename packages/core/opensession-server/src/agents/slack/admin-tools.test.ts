import { describe, expect, test } from "bun:test";
import { formatAutomationRecord } from "./admin-tools";
import type { Automation } from "../../server/automations";

const automation: Automation = {
  id: "auto-1",
  name: "Morning digest",
  prompt: "Summarize yesterday's tickets.\nPost to #acme.",
  schedule: "0 9 * * 1-5",
  mode: "scratch",
  repo: "acme",
  mcpServers: ["opensession-web"],
  enabled: true,
  createdBy: "alice",
  createdAt: "2026-01-01T00:00:00.000Z",
  webhookSecret: "do-not-leak-this",
  runs: Array.from({ length: 8 }, (_, i) => ({
    sessionId: `os-run-${i}`,
    trigger: "cron" as const,
    at: `2026-01-0${i + 1}T09:00:00.000Z`,
    status: "ok" as const,
  })),
};

describe("formatAutomationRecord", () => {
  test("shows the full prompt verbatim and every setting", () => {
    const out = formatAutomationRecord(automation);
    expect(out).toContain(automation.prompt);
    expect(out).toContain('"schedule": "0 9 * * 1-5"');
    expect(out).toContain('"mode": "scratch"');
    expect(out).toContain('"opensession-web"');
  });

  test("never includes the webhook secret", () => {
    const out = formatAutomationRecord(automation);
    expect(out).not.toContain("do-not-leak-this");
    expect(out).not.toContain("webhookSecret");
  });

  test("keeps only the most recent runs", () => {
    const out = formatAutomationRecord(automation);
    expect(out).toContain("os-run-4");
    expect(out).not.toContain("os-run-5");
  });
});
