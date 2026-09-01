import { describe, expect, test } from "bun:test";
import {
  isObviouslyPrivateWebhookHost,
  isTailnetIpv4,
  normalizeAppOrigin,
  normalizeWebhookOrigin,
} from "./setup-access";

describe("setup access origins", () => {
  test("normalizes app origins and rejects URL suffixes", () => {
    expect(normalizeAppOrigin(" https://OS.Example.com/ ")).toBe(
      "https://os.example.com",
    );
    expect(normalizeAppOrigin("http://100.83.4.2:3850")).toBe(
      "http://100.83.4.2:3850",
    );
    expect(() => normalizeAppOrigin("os.example.com")).toThrow(
      "must be a full URL",
    );
    expect(() => normalizeAppOrigin("https://os.example.com/settings")).toThrow(
      "must not include a path",
    );
  });

  test("requires a separate public HTTPS webhook origin", () => {
    expect(
      normalizeWebhookOrigin(
        "https://Hooks.Example.com/",
        "https://os.example.com",
      ),
    ).toBe("https://hooks.example.com");
    expect(normalizeWebhookOrigin("", "https://os.example.com")).toBe("");
    expect(() =>
      normalizeWebhookOrigin(
        "http://hooks.example.com",
        "https://os.example.com",
      ),
    ).toThrow("must use https");
    expect(() =>
      normalizeWebhookOrigin(
        "https://os.example.com",
        "https://os.example.com",
      ),
    ).toThrow("different hostname");
    expect(() =>
      normalizeWebhookOrigin(
        "https://hooks.example.com:8443",
        "https://os.example.com",
      ),
    ).toThrow("default HTTPS port 443");
    expect(() => normalizeAppOrigin("https://os.example.com:8443")).toThrow(
      "default HTTPS port 443",
    );
  });

  test("rejects addresses providers cannot reach", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.2.3.4",
      "100.64.0.1",
      "100.127.255.254",
      "172.20.0.1",
      "192.168.1.2",
      "hooks.tailnet.ts.net",
      "service.internal",
      "router.home.arpa",
      "::1",
      "fd7a:115c:a1e0::1",
      "fe80::1",
    ]) {
      expect(isObviouslyPrivateWebhookHost(host)).toBe(true);
      const urlHost = host.includes(":") ? `[${host}]` : host;
      expect(() =>
        normalizeWebhookOrigin(`https://${urlHost}`, "https://os.example.com"),
      ).toThrow("public internet");
    }
    expect(isObviouslyPrivateWebhookHost("hooks.example.com")).toBe(false);
  });

  test("recognizes the Tailscale IPv4 range only", () => {
    expect(isTailnetIpv4("100.64.0.1")).toBe(true);
    expect(isTailnetIpv4("100.127.255.254")).toBe(true);
    expect(isTailnetIpv4("100.128.0.1")).toBe(false);
    expect(isTailnetIpv4("192.168.1.1")).toBe(false);
  });
});
