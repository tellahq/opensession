import { describe, expect, test } from "bun:test";
import {
  automationEgressDomains,
  automationEgressProbeBlockedUrl,
  automationModelEgressDestinations,
  DAYTONA_DOMAIN_ALLOWLIST_MAX,
  parseAutomationEgressDomain,
} from "./automation-egress";

describe("sandbox automation egress", () => {
  test("normalizes URLs and wildcard domains", () => {
    expect(parseAutomationEgressDomain("https://API.Example.com/path")).toBe(
      "api.example.com",
    );
    expect(parseAutomationEgressDomain("*.Example.com")).toBe("*.example.com");
  });

  test("refuses destinations Daytona cannot enforce as domains", () => {
    for (const value of ["*", "127.0.0.1", "10.0.0.0/8", "example.com:443"]) {
      expect(() => parseAutomationEgressDomain(value)).toThrow();
    }
  });

  test("adds only the selected model provider", () => {
    expect(
      automationModelEgressDestinations("pi/anthropic/claude-sonnet-5"),
    ).toEqual(["api.anthropic.com"]);
    expect(automationModelEgressDestinations("pi/openai/gpt-5.6-sol")).toEqual([
      "api.openai.com",
      "chatgpt.com",
    ]);
  });

  test("includes run infrastructure and explicit destinations", () => {
    const domains = automationEgressDomains({
      callbackBaseUrl: "wss://sessions.example.com",
      cloneUrl: "https://github.com/tellahq/opensession.git",
      mcpDestinations: ["https://api.plain.com/v1"],
      extra: ["uploads.example.com", "api.anthropic.com"],
    });

    expect(domains).toContain("sessions.example.com");
    expect(domains).toContain("github.com");
    expect(domains).toContain("api.anthropic.com");
    expect(domains).toContain("registry.npmjs.org");
    expect(domains).toContain("api.plain.com");
    expect(domains).toContain("uploads.example.com");
  });

  test("chooses a blocked probe outside wildcard policy entries", () => {
    expect(
      automationEgressProbeBlockedUrl(["example.com", "*.example.com"]),
    ).toBe("https://www.iana.org/");
  });

  test("fails instead of truncating Daytona's allowlist", () => {
    const extras = Array.from(
      { length: DAYTONA_DOMAIN_ALLOWLIST_MAX },
      (_, index) => `service-${index}.example.com`,
    );
    expect(() =>
      automationEgressDomains({
        callbackBaseUrl: "wss://sessions.example.com",
        cloneUrl: "https://github.com/tellahq/opensession.git",
        extra: extras,
      }),
    ).toThrow(`Daytona allows at most ${DAYTONA_DOMAIN_ALLOWLIST_MAX}`);
  });
});
