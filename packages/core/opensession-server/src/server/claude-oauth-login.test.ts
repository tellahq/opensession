import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addAccount,
  listAccountsPublic,
  pickAccount,
  refreshAllUsage,
} from "./claude-accounts";
import { completeClaudeLogin, startClaudeLogin } from "./claude-oauth-login";

const realFetch = globalThis.fetch;
let dir = "";
let accessToken = "test-access-token-usage-first";
let usageConnected = false;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opensession-claude-oauth-"));
  process.env.OPENSESSION_STATE_DIR = dir;
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(dir, "accounts.json");
  accessToken = "test-access-token-usage-first";
  usageConnected = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth/token")) {
      return Response.json({
        access_token: accessToken,
        refresh_token: "refresh-next",
        expires_in: 28_800,
        refresh_token_expires_in: 2_592_000,
        scope: "user:profile user:inference",
        account: { email_address: "alex@example.com" },
      });
    }
    if (url.endsWith("/api/oauth/profile")) {
      return Response.json({
        account: { email_address: "alex@example.com" },
        organization: { organization_type: "default_claude_max" },
      });
    }
    if (url.endsWith("/api/oauth/usage")) {
      if (!usageConnected)
        return new Response("missing scope", { status: 403 });
      return Response.json({
        five_hour: { utilization: 12, resets_at: null },
        seven_day: { utilization: 34, resets_at: null },
      });
    }
    throw new Error(`Unexpected fetch: ${url} ${init?.method || "GET"}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENSESSION_STATE_DIR;
  delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("Claude OAuth usage setup", () => {
  test("keeps the setup token for runs while OAuth credentials refresh usage", async () => {
    const added = await addAccount("Alex", "sk-ant-test-placeholder");
    expect(added).not.toHaveProperty("error");
    if ("error" in added) throw new Error(added.error);
    expect(added.noUsageScope).toBe(true);
    expect(pickAccount()?.token).toBe("sk-ant-test-placeholder");

    const started = await startClaudeLogin(added.id);
    expect(started).not.toHaveProperty("error");
    if ("error" in started) throw new Error(started.error);

    usageConnected = true;
    const completed = await completeClaudeLogin(
      started.id,
      "authorization-code#state",
    );
    expect(completed).not.toHaveProperty("error");
    if ("error" in completed) throw new Error(completed.error);

    expect(completed.account).toMatchObject({
      name: "Alex",
      email: "alex@example.com",
      authKind: "setup-token",
      noUsageScope: false,
      usable: true,
    });
    expect(pickAccount()?.token).toBe("sk-ant-test-placeholder");

    const credentialsPath = completed.account.credentialsPath!;
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
    expect(credentials.claudeAiOauth.refreshTokenExpiresAt).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );
    credentials.claudeAiOauth.expiresAt = 0;
    writeFileSync(credentialsPath, JSON.stringify(credentials));
    accessToken = "test-access-token-usage-refreshed";

    await refreshAllUsage();

    expect(pickAccount()?.token).toBe("sk-ant-test-placeholder");
    expect(listAccountsPublic()[0]?.authKind).toBe("setup-token");
    expect(
      JSON.parse(
        readFileSync(process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH!, "utf8"),
      ),
    ).toMatchObject({
      accounts: [{ token: "sk-ant-test-placeholder", credentialsPath }],
    });
  });
});
