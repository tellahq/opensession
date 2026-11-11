import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withCodexAuthLock } from "./codex-auth-lock";
import type { CodexAccount } from "./codex-accounts";
import {
  codexAccessTokenNeedsRefresh,
  codexResetCreditKey,
  codexUsageFor,
  consumeCodexResetCredit,
  normalizeCodexRateLimits,
  probeCodexUsage,
  refreshCodexUsage,
  shouldUseCodexResetCredit,
  type CodexAccountUsage,
} from "./codex-usage";

/** A structurally valid JWT whose only claim is `exp` (seconds). */
function jwtExpiringAt(expSeconds: number): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: expSeconds })}.sig`;
}

function writeAuth(codexHome: string, accessToken: string | undefined): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: accessToken
        ? { access_token: accessToken, refresh_token: "rt" }
        : undefined,
    }),
  );
}

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
            credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            individualLimit: {
              limit: "50.00",
              used: "37.50",
              remainingPercent: 25,
              resetsAt: 1_787_055_509,
            },
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
          credits: { hasCredits: true, unlimited: false, balance: "12.50" },
          spendLimit: {
            limit: "50.00",
            used: "37.50",
            remainingPercent: 25,
            resetsAt: "2026-08-18T12:18:29.000Z",
          },
          rateLimitReachedType: "secondary",
        },
      ],
      resetCreditsAvailable: 2,
    });
  });

  test("drops credits the account does not have and malformed spend caps", () => {
    const usage = normalizeCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: null,
        credits: { hasCredits: false, unlimited: false, balance: null },
        individualLimit: { limit: 50, used: "1.00" },
      },
    });
    expect(usage.buckets[0]).not.toHaveProperty("credits");
    expect(usage.buckets[0]).not.toHaveProperty("spendLimit");
  });

  test("keeps an unlimited credit grant without a balance", () => {
    const usage = normalizeCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: null,
        credits: { hasCredits: false, unlimited: true },
      },
    });
    expect(usage.buckets[0].credits).toEqual({
      hasCredits: false,
      unlimited: true,
      balance: null,
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

describe("codexAccessTokenNeedsRefresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const hour = 3600;

  test("true when the access token is expired or within a day of it", async () => {
    const expired = join(dir, "expired");
    writeAuth(expired, jwtExpiringAt(now / 1000 - hour));
    expect(await codexAccessTokenNeedsRefresh(expired, now)).toBe(true);
    const soon = join(dir, "soon");
    writeAuth(soon, jwtExpiringAt(now / 1000 + 6 * hour));
    expect(await codexAccessTokenNeedsRefresh(soon, now)).toBe(true);
  });

  test("false for a fresh token, an API-key login, or no auth.json", async () => {
    const fresh = join(dir, "fresh");
    writeAuth(fresh, jwtExpiringAt(now / 1000 + 9 * 24 * hour));
    expect(await codexAccessTokenNeedsRefresh(fresh, now)).toBe(false);
    const apiKey = join(dir, "api-key");
    writeAuth(apiKey, undefined);
    expect(await codexAccessTokenNeedsRefresh(apiKey, now)).toBe(false);
    expect(await codexAccessTokenNeedsRefresh(join(dir, "missing"), now)).toBe(
      false,
    );
  });
});

describe("probeCodexUsage", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const executable = join(dir, "fake-codex");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Fake app-server: answers the handshake, records whether the account
   * read asked for a refresh in `$CODEX_HOME/refresh-requested`, and can be
   * told to fail that read. */
  function writeFakeCodex(options: { accountReadFails?: boolean } = {}) {
    writeFileSync(
      executable,
      `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\\n' '{"id":1,"result":{"codexHome":"/tmp/fake"}}'
      ;;
    *'account/read'*)
      case "$line" in
        *'"refreshToken":true'*) : > "$CODEX_HOME/refresh-requested" ;;
      esac
      ${
        options.accountReadFails
          ? `printf '%s\\n' '{"id":2,"error":{"code":-32000,"message":"refresh token revoked"}}'`
          : `printf '%s\\n' '{"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt","email":"a@b.c","planType":"pro"}}}'`
      }
      ;;
    *'account/rateLimits/read'*)
      printf '%s\\n' '{"id":3,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":17,"windowDurationMins":300,"resetsAt":1787019073}}}}'
      exit 0
      ;;
  esac
done
`,
    );
    chmodSync(executable, 0o700);
  }

  test("performs the app-server handshake and reads rate limits", async () => {
    writeFakeCodex();
    const home = join(dir, "fresh-home");
    writeAuth(home, jwtExpiringAt(Date.now() / 1000 + 9 * 24 * 3600));

    const usage = await probeCodexUsage(home, executable, 2_000);
    expect(usage.error).toBeUndefined();
    expect(usage.buckets[0]).toMatchObject({
      id: "codex",
      primary: { utilization: 17, windowDurationMins: 300 },
    });
    expect(existsSync(join(home, "refresh-requested"))).toBe(false);
  });

  test("asks the app-server to refresh a near-expiry token first", async () => {
    writeFakeCodex();
    const home = join(dir, "stale-home");
    writeAuth(home, jwtExpiringAt(Date.now() / 1000 - 60));

    const usage = await probeCodexUsage(home, executable, 2_000);
    expect(usage.error).toBeUndefined();
    expect(existsSync(join(home, "refresh-requested"))).toBe(true);
  });

  test("still reads limits when the account read fails", async () => {
    writeFakeCodex({ accountReadFails: true });
    const home = join(dir, "broken-home");
    writeAuth(home, jwtExpiringAt(Date.now() / 1000 - 60));

    const usage = await probeCodexUsage(home, executable, 2_000);
    expect(usage.error).toBeUndefined();
    expect(usage.buckets[0]?.primary?.utilization).toBe(17);
  });
});

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function usageWithWeekly(
  weekly: { utilization: number | null; resetsAt: string | null },
  resetCreditsAvailable: number | null = 1,
): CodexAccountUsage {
  return {
    fetchedAt: new Date(NOW).toISOString(),
    buckets: [
      {
        id: "codex",
        primary: { utilization: 3, resetsAt: null, windowDurationMins: 300 },
        secondary: { ...weekly, windowDurationMins: 10_080 },
      },
    ],
    resetCreditsAvailable,
  };
}

describe("shouldUseCodexResetCredit", () => {
  const inDays = (days: number) => new Date(NOW + days * DAY).toISOString();

  test("spends a credit on a full weekly limit more than two days out", () => {
    expect(
      shouldUseCodexResetCredit(
        usageWithWeekly({ utilization: 100, resetsAt: inDays(2.1) }),
        NOW,
      ),
    ).toBe(true);
  });

  test("waits out a weekly limit that resets within one or two days", () => {
    for (const days of [0.5, 1, 1.5, 2]) {
      expect(
        shouldUseCodexResetCredit(
          usageWithWeekly({ utilization: 100, resetsAt: inDays(days) }),
          NOW,
        ),
      ).toBe(false);
    }
  });

  test("keeps the credit while any weekly allowance is left", () => {
    expect(
      shouldUseCodexResetCredit(
        usageWithWeekly({ utilization: 99, resetsAt: inDays(5) }),
        NOW,
      ),
    ).toBe(false);
  });

  test("needs a credit, a reset time, and a clean read", () => {
    expect(
      shouldUseCodexResetCredit(
        usageWithWeekly({ utilization: 100, resetsAt: inDays(5) }, 0),
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldUseCodexResetCredit(
        usageWithWeekly({ utilization: 100, resetsAt: null }),
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldUseCodexResetCredit(
        {
          ...usageWithWeekly({ utilization: 100, resetsAt: inDays(5) }),
          error: "timed out",
        },
        NOW,
      ),
    ).toBe(false);
  });

  test("ignores a full five-hour window and other buckets", () => {
    const usage: CodexAccountUsage = {
      fetchedAt: new Date(NOW).toISOString(),
      buckets: [
        {
          id: "codex",
          primary: {
            utilization: 100,
            resetsAt: inDays(0.1),
            windowDurationMins: 300,
          },
          secondary: {
            utilization: 40,
            resetsAt: inDays(5),
            windowDurationMins: 10_080,
          },
        },
        {
          id: "codex_spark",
          primary: null,
          secondary: {
            utilization: 100,
            resetsAt: inDays(5),
            windowDurationMins: 10_080,
          },
        },
      ],
      resetCreditsAvailable: 2,
    };
    expect(shouldUseCodexResetCredit(usage, NOW)).toBe(false);
  });

  test("finds a weekly window reported in the primary slot", () => {
    const usage: CodexAccountUsage = {
      fetchedAt: new Date(NOW).toISOString(),
      buckets: [
        {
          id: "codex",
          primary: {
            utilization: 100,
            resetsAt: inDays(4),
            windowDurationMins: 10_080,
          },
          secondary: null,
        },
      ],
      resetCreditsAvailable: 1,
    };
    expect(shouldUseCodexResetCredit(usage, NOW)).toBe(true);
  });
});

test("reset credit keys are stable per account and weekly window", () => {
  const key = codexResetCreditKey("acct-a", "2026-11-16T10:00:12.000Z");
  expect(key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(codexResetCreditKey("acct-a", "2026-11-16T10:00:47.000Z")).toBe(key);
  expect(codexResetCreditKey("acct-b", "2026-11-16T10:00:12.000Z")).not.toBe(
    key,
  );
  expect(codexResetCreditKey("acct-a", "2026-11-23T10:00:12.000Z")).not.toBe(
    key,
  );
});

describe("reset credits through the app-server", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-reset-"));
  const executable = join(dir, "fake-codex");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Fake app-server whose weekly window is full (resetting `resetsAt`, unix
   * seconds) until a reset credit is consumed, which it records in
   * `$CODEX_HOME/consumed` along with the idempotency key. */
  function writeFakeCodex(resetsAt: number) {
    writeFileSync(
      executable,
      `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"id":%s,"result":{}}\\n' "$id"
      ;;
    *'account/read'*)
      printf '{"id":%s,"result":{}}\\n' "$id"
      ;;
    *'account/rateLimits/read'*)
      if [ -f "$CODEX_HOME/consumed" ]; then
        printf '{"id":%s,"result":{"rateLimits":{"limitId":"codex","secondary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":${resetsAt + 7 * 86400}}},"rateLimitResetCredits":{"availableCount":0}}}\\n' "$id"
      else
        printf '{"id":%s,"result":{"rateLimits":{"limitId":"codex","secondary":{"usedPercent":100,"windowDurationMins":10080,"resetsAt":${resetsAt}}},"rateLimitResetCredits":{"availableCount":1}}}\\n' "$id"
      fi
      exit 0
      ;;
    *'account/rateLimitResetCredit/consume'*)
      printf '%s\\n' "$line" >> "$CODEX_HOME/consumed"
      printf '{"id":%s,"result":{"outcome":"reset"}}\\n' "$id"
      exit 0
      ;;
  esac
done
`,
    );
    chmodSync(executable, 0o700);
  }

  function homeAccount(id: string): CodexAccount {
    const home = join(dir, id);
    writeAuth(home, jwtExpiringAt(Date.now() / 1000 + 9 * 24 * 3600));
    return {
      id,
      name: id,
      kind: "home",
      value: home,
      createdAt: new Date(0).toISOString(),
    };
  }

  test("consume reports the backend outcome", async () => {
    writeFakeCodex(Math.floor(Date.now() / 1000) + 5 * 86400);
    const account = homeAccount("consume-home");
    const result = await consumeCodexResetCredit(
      account.value,
      "key-1",
      executable,
      2_000,
    );
    expect(result).toEqual({ outcome: "reset" });
    expect(readFileSync(join(account.value, "consumed"), "utf-8")).toContain(
      '"idempotencyKey":"key-1"',
    );
  });

  test("a poll spends a credit on a weekly limit days from resetting", async () => {
    writeFakeCodex(Math.floor(Date.now() / 1000) + 5 * 86400);
    const account = homeAccount("far-reset");
    const reset: string[] = [];
    await refreshCodexUsage([account], {
      executable,
      onResetCredit: (a) => reset.push(a.id),
    });
    expect(reset).toEqual(["far-reset"]);
    expect(existsSync(join(account.value, "consumed"))).toBe(true);
    expect(codexUsageFor("far-reset")?.buckets[0]?.secondary?.utilization).toBe(
      0,
    );
  });

  test("a poll leaves the credit when the weekly limit resets within two days", async () => {
    writeFakeCodex(Math.floor(Date.now() / 1000) + 36 * 3600);
    const account = homeAccount("near-reset");
    const reset: string[] = [];
    await refreshCodexUsage([account], {
      executable,
      onResetCredit: (a) => reset.push(a.id),
    });
    expect(reset).toEqual([]);
    expect(existsSync(join(account.value, "consumed"))).toBe(false);
    expect(
      codexUsageFor("near-reset")?.buckets[0]?.secondary?.utilization,
    ).toBe(100);
  });
});
