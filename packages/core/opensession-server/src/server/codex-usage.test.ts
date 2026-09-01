import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withCodexAuthLock } from "./codex-auth-lock";
import { normalizeCodexRateLimits, probeCodexUsage } from "./codex-usage";

test("Codex auth operations serialize per CODEX_HOME", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const first = withCodexAuthLock("/tmp/locked-home", async () => {
    events.push("first:start");
    markFirstStarted();
    await gate;
    events.push("first:end");
  });
  const second = withCodexAuthLock("/tmp/locked-home", async () => {
    events.push("second:start");
  });
  await firstStarted;
  expect(events).toEqual(["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(["first:start", "first:end", "second:start"]);
});

describe("normalizeCodexRateLimits", () => {
  test("preserves multi-bucket windows, plan, and reset credits", () => {
    const usage = normalizeCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            planType: "pro",
            primary: {
              usedPercent: 21,
              windowDurationMins: 300,
              resetsAt: 1_787_019_073,
            },
            secondary: {
              usedPercent: 42,
              windowDurationMins: 10_080,
              resetsAt: 1_787_055_509,
            },
          },
          codex_spark: {
            limitId: "codex_spark",
            limitName: "Spark",
            primary: null,
            secondary: null,
            rateLimitReachedType: "secondary",
          },
        },
        rateLimitResetCredits: { availableCount: 2 },
      },
      "2026-08-11T12:00:00.000Z",
    );

    expect(usage).toEqual({
      fetchedAt: "2026-08-11T12:00:00.000Z",
      buckets: [
        {
          id: "codex",
          plan: "pro",
          primary: {
            utilization: 21,
            windowDurationMins: 300,
            resetsAt: "2026-08-18T02:11:13.000Z",
          },
          secondary: {
            utilization: 42,
            windowDurationMins: 10_080,
            resetsAt: "2026-08-18T12:18:29.000Z",
          },
        },
        {
          id: "codex_spark",
          label: "Spark",
          primary: null,
          secondary: null,
          rateLimitReachedType: "secondary",
        },
      ],
      resetCreditsAvailable: 2,
    });
  });

  test("accepts the backward-compatible singular bucket", () => {
    const usage = normalizeCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 8, windowDurationMins: 60, resetsAt: null },
      },
    });
    expect(usage.buckets).toHaveLength(1);
    expect(usage.buckets[0].primary).toEqual({
      utilization: 8,
      windowDurationMins: 60,
      resetsAt: null,
    });
    expect(usage.resetCreditsAvailable).toBeNull();
  });
});

describe("probeCodexUsage", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const executable = join(dir, "fake-codex");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("performs the app-server handshake and reads rate limits", async () => {
    writeFileSync(
      executable,
      `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*)
      printf '%s\\n' '{"id":1,"result":{"codexHome":"/tmp/fake"}}'
      ;;
    *'account/rateLimits/read'*)
      printf '%s\\n' '{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":17,"windowDurationMins":300,"resetsAt":1787019073}}}}'
      exit 0
      ;;
  esac
done
`,
    );
    chmodSync(executable, 0o700);

    const usage = await probeCodexUsage("/tmp/fake-home", executable, 2_000);
    expect(usage.error).toBeUndefined();
    expect(usage.buckets[0]).toMatchObject({
      id: "codex",
      primary: { utilization: 17, windowDurationMins: 300 },
    });
  });
});
