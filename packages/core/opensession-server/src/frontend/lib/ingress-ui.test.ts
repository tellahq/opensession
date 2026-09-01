import { describe, expect, test } from "bun:test";
import {
  configuredAppDomain,
  configuredIngressDrafts,
  customCaddyConfig,
  customDnsRecords,
  INGRESS_METHODS,
  ingressHealthDot,
  ingressHealthLabel,
  ingressHostname,
  privateAppCaddyConfig,
  privateAppDnsRecord,
  publicUrlForMethod,
  suggestedPublicIngressDomain,
} from "./ingress-ui";
import type { PublicIngressSettings } from "./api/ingress";

const settings = {
  publicBaseUrl: "https://old.example.test",
  exposure: "custom",
  app: {
    publicBaseUrl: "https://os.example.test",
    hostname: "os.example.test",
    tailnetIpv4: "100.64.0.10",
  },
  server: { ipv4: ["203.0.113.10"], ipv6: ["2001:db8::10"] },
} as PublicIngressSettings;

describe("public ingress form", () => {
  test("shows a newly started connector as pending rather than failed", () => {
    expect(ingressHealthLabel("starting")).toBe("Waiting");
    expect(ingressHealthDot("starting")).toBe("var(--yellow)");
  });

  test("presents the supported ways to publish the callback endpoint", () => {
    expect(INGRESS_METHODS).toEqual([
      {
        value: "custom",
        label: "Direct HTTPS with Caddy",
        description:
          "Your domain with any DNS provider. Requires ports 80 and 443.",
      },
      {
        value: "cloudflare",
        label: "Cloudflare Tunnel",
        description: "Your domain through Cloudflare. No inbound ports.",
      },
    ]);
  });

  test("keeps one draft and display URL per exposure method", () => {
    expect(configuredIngressDrafts(settings)).toEqual({
      cloudflare: "https://ingress.os.example.test",
      custom: "old.example.test",
    });
    expect(
      publicUrlForMethod(settings, "cloudflare", "callbacks.example.test"),
    ).toBe("https://callbacks.example.test");
    expect(publicUrlForMethod(settings, "custom", "")).toBe("");
  });

  test("builds private app DNS and Caddy instructions on the tailnet", () => {
    expect(configuredAppDomain(settings)).toBe("os.example.test");
    expect(privateAppDnsRecord(settings, "team.example.test")).toBe(
      "A team.example.test 100.64.0.10",
    );
    expect(suggestedPublicIngressDomain("os.example.test")).toBe(
      "ingress.os.example.test",
    );
    expect(suggestedPublicIngressDomain("private.example.test")).toBe(
      "ingress.private.example.test",
    );
    const caddy = privateAppCaddyConfig(settings, "team.example.test");
    expect(caddy).toContain("team.example.test {");
    expect(caddy).toContain("bind 100.64.0.10");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:3850");
  });

  test("accepts a bare custom domain for public DNS and Caddy instructions", () => {
    expect(ingressHostname("new.example.test")).toBe("new.example.test");
    expect(customDnsRecords(settings, "new.example.test")).toEqual([
      "A new.example.test 203.0.113.10",
      "AAAA new.example.test 2001:db8::10",
    ]);
    expect(
      customDnsRecords(settings, "new.example.test", "198.51.100.20"),
    ).toEqual([
      "A new.example.test 198.51.100.20",
      "AAAA new.example.test 2001:db8::10",
    ]);
    expect(customCaddyConfig("new.example.test")).toContain(
      "new.example.test {",
    );
  });
});
