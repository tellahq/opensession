import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the state, sandbox config, and account store at a temp dir BEFORE the
// modules load (paths are read at import).
const root = mkdtempSync(join(tmpdir(), "claude-api-credentials-"));
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_SANDBOX_CONFIG = join(root, "sandbox.json");
process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(root, "accounts.json");
writeFileSync(
  process.env.OPENSESSION_SANDBOX_CONFIG,
  JSON.stringify({ callbackBaseUrl: "https://identity.example.test" }),
);

const federation = {
  organizationId: "00000000-0000-4000-8000-000000000000",
  federationRuleId: "fdrl_abc123",
  serviceAccountId: "svac_def456",
};

writeFileSync(
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH,
  JSON.stringify({
    accounts: [
      {
        id: "sub",
        name: "sub",
        token: "sk-ant-oat01-sub",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "api",
        name: "api",
        token: "",
        authKind: "federation",
        federation,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  }),
);

let credentials: typeof import("./claude-api-credentials");
let accounts: typeof import("./claude-accounts");

beforeAll(async () => {
  credentials = await import("./claude-api-credentials");
  accounts = await import("./claude-accounts");
  await accounts.loadClaudeAccounts();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function claims(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  );
}

type Call = { url: string; init: RequestInit };

function tokenEndpoint(
  respond: (call: Call) => Response = () =>
    Response.json({ access_token: "sk-ant-oat01-minted", expires_in: 3600 }),
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("federation settings", () => {
  test("accepts Console IDs and rejects malformed ones", () => {
    expect(
      credentials.parseClaudeFederation({
        ...federation,
        workspaceId: " wrkspc_x1 ",
      }),
    ).toEqual({ ...federation, workspaceId: "wrkspc_x1" });
    expect(
      credentials.parseClaudeFederation({
        ...federation,
        federationRuleId: "rule",
      }),
    ).toEqual({ error: "Federation rule ID should start with fdrl_" });
    expect(
      credentials.parseClaudeFederation({ ...federation, organizationId: "" }),
    ).toEqual({ error: "Organization ID should be a UUID" });
  });

  test("names this server's issuer, subject, audience, and keys", async () => {
    const setup = await credentials.claudeFederationSetup();
    expect(setup).toMatchObject({
      issuer: "https://identity.example.test/workload-identity",
      jwksUrl: "https://identity.example.test/workload-identity/jwks.json",
      publicIssuer: true,
      subject: "opensession:claude-api",
      audience: "https://api.anthropic.com",
    });
    const jwks = JSON.parse(setup.jwks);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256" });
    expect(jwks.keys[0].d).toBeUndefined();
  });
});

describe("token exchange", () => {
  test("presents a fresh server ID token with the jwt-bearer grant", async () => {
    const { calls, fetchImpl } = tokenEndpoint();
    const token = await credentials.exchangeFederatedToken(
      { ...federation, workspaceId: "default" },
      fetchImpl,
    );
    expect(token.token).toBe("sk-ant-oat01-minted");
    expect(token.lifetimeMs).toBe(3_600_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/oauth/token");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe(
      "oauth-2025-04-20,oidc-federation-2026-04-01",
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      federation_rule_id: "fdrl_abc123",
      organization_id: federation.organizationId,
      service_account_id: "svac_def456",
      workspace_id: "default",
    });
    const idToken = claims(body.assertion);
    expect(idToken).toMatchObject({
      iss: "https://identity.example.test/workload-identity",
      sub: "opensession:claude-api",
      aud: "https://api.anthropic.com",
    });
    expect(Number(idToken.exp) - Number(idToken.iat)).toBe(3600);

    // Anthropic rejects a reused jti, so every exchange signs a new token.
    await credentials.exchangeFederatedToken(federation, fetchImpl);
    const second = claims(JSON.parse(String(calls[1]!.init.body)).assertion);
    expect(second.jti).not.toBe(idToken.jti);
  });

  test("reports a refused exchange without echoing credentials", async () => {
    const { fetchImpl } = tokenEndpoint(() =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "subject mismatch for sk-ant-oat01-leak",
        },
        { status: 401 },
      ),
    );
    const error = await credentials
      .exchangeFederatedToken(federation, fetchImpl)
      .catch((e: Error) => e);
    expect(String(error)).toContain(
      "Anthropic token exchange failed (401): invalid_grant",
    );
    expect(String(error)).toContain("Workload identity page");
    expect(String(error)).not.toContain("leak");
  });

  test("shares one token per account until it nears expiry", async () => {
    let n = 0;
    const { calls, fetchImpl } = tokenEndpoint(() =>
      Response.json({ access_token: `sk-ant-oat01-t${++n}`, expires_in: 3600 }),
    );
    const [a, b] = await Promise.all([
      credentials.federatedAccessToken("acct-1", federation, fetchImpl),
      credentials.federatedAccessToken("acct-1", federation, fetchImpl),
    ]);
    expect(a.token).toBe("sk-ant-oat01-t1");
    expect(b.token).toBe("sk-ant-oat01-t1");
    expect(calls).toHaveLength(1);

    // A token inside its refresh margin (here, already expired) is exchanged
    // again.
    const { calls: shortCalls, fetchImpl: shortFetch } = tokenEndpoint(() =>
      Response.json({ access_token: "sk-ant-oat01-short", expires_in: 0 }),
    );
    await credentials.federatedAccessToken("acct-2", federation, shortFetch);
    await credentials.federatedAccessToken("acct-2", federation, shortFetch);
    expect(shortCalls).toHaveLength(2);

    credentials.forgetFederatedTokens("acct-1");
    await credentials.federatedAccessToken("acct-1", federation, fetchImpl);
    expect(calls).toHaveLength(2);
  });
});

describe("Claude Code auth", () => {
  test("sends each credential kind the way Claude Code expects", async () => {
    expect(
      await credentials.claudeCodeAuth({ id: "s", token: "sk-ant-oat01-s" }),
    ).toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-s" },
      key: "subscription",
    });
    const key = await credentials.claudeCodeAuth({
      id: "k",
      token: "sk-ant-api03-k",
      authKind: "api-key",
    });
    expect(key.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-k" });
    expect(key.key).not.toContain("sk-ant");
    const { fetchImpl } = tokenEndpoint();
    const federated = await credentials.claudeCodeAuth(
      { id: "f", token: "", authKind: "federation", federation },
      fetchImpl,
    );
    expect(federated.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-minted",
    });
    expect(federated.key).toStartWith("federation:");
  });
});

describe("account routing", () => {
  test("API accounts serve only Mythos, and Mythos only API accounts", () => {
    expect(
      accounts.pickAccount(undefined, undefined, "claude-mythos-5-2")?.id,
    ).toBe("api");
    expect(
      accounts.pickAccount(
        undefined,
        undefined,
        "pi/anthropic/claude-mythos-5-1",
      )?.id,
    ).toBe("api");
    expect(
      accounts.pickAccount(undefined, undefined, "claude-opus-5-5")?.id,
    ).toBe("sub");
    // Account-less picks (CLI credentials, web search) stay on subscriptions.
    expect(accounts.pickAccount()?.id).toBe("sub");
    expect(
      accounts.pickAccount(new Set(["api"]), undefined, "claude-mythos-5-2"),
    ).toBeUndefined();
  });

  test("a fixed session cannot switch to a model its account refuses", async () => {
    const { fixedSubscriptionModelError } =
      await import("./fixed-subscription");
    expect(
      fixedSubscriptionModelError("sub", "pi/anthropic/claude-mythos-5-2"),
    ).toMatch(/Mythos runs only on Claude API accounts/);
    expect(
      fixedSubscriptionModelError("api", "pi/anthropic/claude-opus-5-5"),
    ).toMatch(/only runs Mythos/);
    expect(
      fixedSubscriptionModelError("api", "pi/anthropic/claude-mythos-5-2"),
    ).toBeUndefined();
    expect(
      fixedSubscriptionModelError("sub", "pi/anthropic/claude-opus-5-5"),
    ).toBeUndefined();
  });

  test("only a whole account notice counts as one in a successful result", async () => {
    const { isClaudeAccountNotice, mayBecomeClaudeAccountNotice } =
      await import("./runner-shared");
    for (const notice of [
      "5-hour limit reached ∙ resets 3am",
      "You've hit your session limit · resets 12:50pm (UTC)",
      "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
      "Claude AI usage limit reached|1767225600",
      "You're out of usage credits.",
      "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.",
      "Claude Max subscription issue. Check your subscription status.",
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    ])
      expect(isClaudeAccountNotice(notice)).toBe(true);
    for (const answer of [
      "Use /usage-credits to check your balance before running Claude again.",
      "You're out of usage credits on the old plan, but the new plan has a separate balance.",
      "You've hit your session limit before; it resets after five hours.",
      "The API rate limit resets every minute, so retry after a short wait.",
      "Your plan's usage limit reached its cap yesterday; it resets weekly.",
      // A valid reset stamp followed by prose is an answer.
      "You've hit your session limit · resets 12:50pm (UTC), then retry.",
      "5-hour limit reached ∙ resets 3am, so wait until then.",
      "You've hit your weekly limit · resets Aug 20, 9am (UTC) unless you upgrade.",
      "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models. Then try again.",
    ])
      expect(isClaudeAccountNotice(answer)).toBe(false);
    // Streamed text that opens like a notice is held until it can be judged.
    expect(mayBecomeClaudeAccountNotice("You're out of usage cred")).toBe(true);
    expect(mayBecomeClaudeAccountNotice("Here is the plan")).toBe(false);
  });

  test("an API rate limit benches the account briefly", () => {
    accounts.markExhausted("api", "claude-mythos-5-2");
    expect(
      accounts.pickAccount(undefined, undefined, "claude-mythos-5-2"),
    ).toBeUndefined();
    const api = accounts.listAccountsPublic().find((a) => a.id === "api");
    expect(api?.authKind).toBe("federation");
    expect(api?.federation).toEqual(federation);
    expect(api?.noUsageScope).toBe(false);
    accounts.returnAccountToPool("api");
    expect(
      accounts.pickAccount(undefined, undefined, "claude-mythos-5-2")?.id,
    ).toBe("api");
  });

  test("a setup-token form rejects an API key", async () => {
    expect(await accounts.addAccount("x", "sk-ant-api03-nope")).toEqual({
      error:
        "That's a Claude API key, not a setup token. Add it as a Claude API account instead.",
    });
  });

  test("concurrent adds keep both accounts", async () => {
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((r) => (releaseUsage = r));
    const sign = spyOn(
      await import("./workload-identity"),
      "signServerIdentityToken",
    ).mockResolvedValue("header.payload.signature");
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url: string,
    ) => {
      if (String(url).endsWith("/v1/oauth/token"))
        return Response.json({
          access_token: "sk-ant-oat01-x",
          expires_in: 3600,
        });
      // The subscription add's usage check is still in flight while the API
      // account commits.
      await usageGate;
      return new Response("{}", { status: 403 });
    }) as unknown as typeof fetch);
    try {
      const subscription = accounts.addAccount(
        "racer-sub",
        "sk-ant-oat01-racer-subscription-token",
      );
      const api = await accounts.addClaudeApiAccount({
        name: "racer-api",
        federation: { ...federation, federationRuleId: "fdrl_racer" },
      });
      expect("error" in api).toBe(false);
      releaseUsage();
      expect("error" in (await subscription)).toBe(false);
      const names = accounts.listAccountsPublic().map((a) => a.name);
      expect(names).toContain("racer-sub");
      expect(names).toContain("racer-api");
    } finally {
      fetchSpy.mockRestore();
      sign.mockRestore();
    }
  });
});
