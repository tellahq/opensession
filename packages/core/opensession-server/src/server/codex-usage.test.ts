import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withCodexAuthLock } from "./codex-auth-lock";
import {
  codexAccessTokenNeedsRefresh,
  normalizeCodexRateLimits,
  probeCodexUsage,
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

  test("true when the access token is expired or within a day of it", () => {
    const expired = join(dir, "expired");
    writeAuth(expired, jwtExpiringAt(now / 1000 - hour));
    expect(codexAccessTokenNeedsRefresh(expired, now)).toBe(true);
    const soon = join(dir, "soon");
    writeAuth(soon, jwtExpiringAt(now / 1000 + 6 * hour));
    expect(codexAccessTokenNeedsRefresh(soon, now)).toBe(true);
  });

  test("false for a fresh token, an API-key login, or no auth.json", () => {
    const fresh = join(dir, "fresh");
    writeAuth(fresh, jwtExpiringAt(now / 1000 + 9 * 24 * hour));
    expect(codexAccessTokenNeedsRefresh(fresh, now)).toBe(false);
    const apiKey = join(dir, "api-key");
    writeAuth(apiKey, undefined);
    expect(codexAccessTokenNeedsRefresh(apiKey, now)).toBe(false);
    expect(codexAccessTokenNeedsRefresh(join(dir, "missing"), now)).toBe(false);
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
