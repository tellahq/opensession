import { describe, expect, test } from "bun:test";
import {
  computeExpires,
  jwtEmail,
  jwtExpMs,
  parseXaiCatalogBody,
  parseXaiUsageBody,
  tokensFromResponse,
  xaiProxyHeaders,
  xaiStatusLabel,
} from "./xai-oauth";

function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

describe("xai-oauth token shaping", () => {
  test("reads identity and expiry from the JWTs", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(jwtEmail(jwt({ email: " me@example.com " }))).toBe("me@example.com");
    expect(jwtEmail("opaque")).toBeUndefined();
    expect(jwtExpMs(jwt({ exp }))).toBe(exp * 1000);
    expect(jwtExpMs("opaque")).toBeNull();
  });

  test("expiry is the earlier of expires_in and the token's own exp, minus skew", () => {
    const now = Date.now();
    const soon = Math.floor(now / 1000) + 600;
    const capped = computeExpires(jwt({ exp: soon }), 3600);
    expect(capped).toBeLessThanOrEqual(soon * 1000 - 5 * 60 * 1000);
    const opaque = computeExpires("opaque", 3600);
    expect(opaque).toBeGreaterThan(now + 50 * 60 * 1000);
  });

  test("a refresh response may omit the refresh token when it did not rotate", () => {
    const tokens = tokensFromResponse(
      { access_token: "a2", expires_in: 1800 },
      "r-old",
    );
    expect(tokens.refresh).toBe("r-old");
    expect(() => tokensFromResponse({ access_token: "a2" })).toThrow(
      /refresh token/,
    );
    expect(() => tokensFromResponse({ refresh_token: "r" })).toThrow(
      /access token/,
    );
  });

  test("status labels never echo upstream text and mark auth failures fatal", () => {
    expect(xaiStatusLabel(401)).toEqual({
      label: "authentication rejected",
      fatal: true,
    });
    expect(xaiStatusLabel(429).label).toBe("rate limited");
    expect(xaiStatusLabel(503).fatal).toBe(false);
  });

  test("proxy headers carry the model override only for inference", () => {
    expect(xaiProxyHeaders()).not.toHaveProperty("x-grok-model-override");
    expect(xaiProxyHeaders("grok-4.6")["x-grok-model-override"]).toBe(
      "grok-4.6",
    );
    expect(xaiProxyHeaders()["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
  });
});

describe("parseXaiUsageBody", () => {
  test("extracts the credit meters and period from the nested config", () => {
    const snapshot = parseXaiUsageBody(
      {
        subscriptionTier: "SuperGrok Heavy",
        onDemandEnabled: false,
        config: {
          creditUsagePercent: 42.5,
          monthlyLimit: { val: 30000 },
          used: { val: 12750 },
          onDemandCap: { val: 5000 },
          onDemandUsed: {},
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-31T00:00:00Z",
            end: "2026-09-07T00:00:00Z",
          },
          productUsage: [
            { product: "GrokBuild", usagePercent: 150 },
            { product: "bad" },
          ],
        },
      },
      "2026-09-02T00:00:00Z",
    );
    expect(snapshot).toEqual({
      fetchedAt: "2026-09-02T00:00:00Z",
      subscriptionTier: "SuperGrok Heavy",
      onDemandEnabled: false,
      creditUsagePercent: 42.5,
      usedCents: 12750,
      monthlyLimitCents: 30000,
      onDemandCapCents: 5000,
      periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      periodStart: "2026-08-31T00:00:00Z",
      periodEnd: "2026-09-07T00:00:00Z",
      productUsage: [{ product: "GrokBuild", usagePercent: 100 }],
    });
  });

  test("derives the percent from used/limit and rejects non-billing shapes", () => {
    expect(
      parseXaiUsageBody({
        config: { used: { val: 50 }, monthlyLimit: { val: 200 } },
      }).creditUsagePercent,
    ).toBe(25);
    expect(() => parseXaiUsageBody([])).toThrow();
    expect(() => parseXaiUsageBody({ config: "nope" })).toThrow();
  });
});

describe("parseXaiCatalogBody", () => {
  test("keeps chat models only, with the proxy's window fields", () => {
    expect(
      parseXaiCatalogBody({
        data: [
          {
            id: "grok-4.6",
            context_window: 500000,
            supports_reasoning_effort: true,
          },
          { id: "grok-imagine-image" },
          { id: "grok-embedding-1" },
          { id: "other-vendor" },
          {
            id: "grok-build",
            context_length: 256000,
            max_output_tokens: 30000,
          },
        ],
      }),
    ).toEqual([
      { id: "grok-4.6", contextWindow: 500000, supportsReasoningEffort: true },
      { id: "grok-build", contextWindow: 256000, maxTokens: 30000 },
    ]);
    expect(parseXaiCatalogBody({ data: "x" })).toEqual([]);
  });
});
