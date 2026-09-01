import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  configuredPrivateAppOrigin,
  configuredPublicIngress,
  directHttpsBindAddress,
  displayedServerAddresses,
  normalizeCustomIngressOrigin,
  normalizeIngressOrigin,
  normalizePrivateAppOrigin,
  publicIngressHealth,
  savePrivateAppOrigin,
  savePublicIngress,
} from "./ingress-settings";

const previous = process.env.OPENSESSION_CONFIG;
const previousEnvFile = process.env.OPENSESSION_ENV_FILE;
const previousUiBase = process.env.OPENSESSION_UI_BASE;
const previousIngressBase = process.env.OPENSESSION_INGRESS_BASE;
const previousPublicIpv4 = process.env.OPENSESSION_PUBLIC_IPV4;
const previousPublicIpv6 = process.env.OPENSESSION_PUBLIC_IPV6;
const dirs: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "opensession-ingress-settings-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      server: {
        publicBaseUrl: "https://app.example.test",
        webhookBaseUrl: "https://old.example.test",
        webhookPort: 3848,
      },
    }),
  );
  const envPath = join(dir, ".opensession.env");
  writeFileSync(envPath, "OPENSESSION_UI_BASE=https://app.example.test\n");
  process.env.OPENSESSION_CONFIG = path;
  process.env.OPENSESSION_ENV_FILE = envPath;
  delete process.env.OPENSESSION_INGRESS_BASE;
  delete process.env.OPENSESSION_PUBLIC_IPV4;
  delete process.env.OPENSESSION_PUBLIC_IPV6;
  return { path, envPath };
}

afterEach(() => {
  if (previous === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previous;
  if (previousEnvFile === undefined) delete process.env.OPENSESSION_ENV_FILE;
  else process.env.OPENSESSION_ENV_FILE = previousEnvFile;
  if (previousUiBase === undefined) delete process.env.OPENSESSION_UI_BASE;
  else process.env.OPENSESSION_UI_BASE = previousUiBase;
  if (previousIngressBase === undefined)
    delete process.env.OPENSESSION_INGRESS_BASE;
  else process.env.OPENSESSION_INGRESS_BASE = previousIngressBase;
  if (previousPublicIpv4 === undefined)
    delete process.env.OPENSESSION_PUBLIC_IPV4;
  else process.env.OPENSESSION_PUBLIC_IPV4 = previousPublicIpv4;
  if (previousPublicIpv6 === undefined)
    delete process.env.OPENSESSION_PUBLIC_IPV6;
  else process.env.OPENSESSION_PUBLIC_IPV6 = previousPublicIpv6;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("public ingress settings", () => {
  test("requires a separate public HTTPS origin", () => {
    fixture();
    expect(normalizeIngressOrigin("https://ingress.example.test/")).toBe(
      "https://ingress.example.test",
    );
    expect(() => normalizeIngressOrigin("http://ingress.example.test")).toThrow(
      "must use HTTPS",
    );
    expect(() => normalizeIngressOrigin("https://app.example.test")).toThrow(
      "different hostname",
    );
    expect(() => normalizeIngressOrigin("https://127.0.0.1")).toThrow(
      "public internet",
    );
  });

  test("custom domains do not require URL syntax", () => {
    fixture();
    expect(normalizeCustomIngressOrigin("ingress.example.test")).toBe(
      "https://ingress.example.test",
    );
    expect(normalizeCustomIngressOrigin("https://ingress.example.test/")).toBe(
      "https://ingress.example.test",
    );
    expect(() =>
      normalizeCustomIngressOrigin("http://ingress.example.test"),
    ).toThrow("must use HTTPS");
  });

  test("binds direct HTTPS to the routed interface instead of the private listener", () => {
    expect(
      directHttpsBindAddress("54.10.20.30", "172.31.21.26", "100.77.110.100"),
    ).toBe("172.31.21.26");
    expect(
      directHttpsBindAddress("54.10.20.30", "100.77.110.100", "100.77.110.100"),
    ).toBeNull();
    expect(
      directHttpsBindAddress("2001:db8::10", "172.31.21.26", "100.77.110.100"),
    ).toBeNull();
  });

  test("reports DNS propagation separately from a broken listener", () => {
    const server = { a: ["203.0.113.10"], aaaa: [] };
    expect(
      publicIngressHealth("custom", "unreachable", { a: [], aaaa: [] }, server),
    ).toBe("waiting_dns");
    expect(
      publicIngressHealth(
        "custom",
        "unreachable",
        { a: ["203.0.113.20"], aaaa: [] },
        server,
      ),
    ).toBe("waiting_dns");
    expect(
      publicIngressHealth(
        "custom",
        "unreachable",
        { a: ["203.0.113.10"], aaaa: [] },
        server,
      ),
    ).toBe("unreachable");
    expect(
      publicIngressHealth(
        "cloudflare",
        "unreachable",
        { a: [], aaaa: [] },
        server,
      ),
    ).toBe("unreachable");
  });

  test("gives newly configured ingress methods time to become reachable", () => {
    const startedAt = 10_000;
    const addresses = { a: [], aaaa: [] };
    expect(
      publicIngressHealth(
        "cloudflare",
        "unreachable",
        addresses,
        addresses,
        startedAt,
        startedAt + 30_000,
      ),
    ).toBe("starting");
    expect(
      publicIngressHealth(
        "cloudflare",
        "ready",
        addresses,
        addresses,
        startedAt,
        startedAt + 30_000,
      ),
    ).toBe("ready");
    expect(
      publicIngressHealth(
        "custom",
        "unreachable",
        { a: [], aaaa: [] },
        { a: ["203.0.113.10"], aaaa: [] },
        startedAt,
        startedAt + 30_000,
      ),
    ).toBe("waiting_dns");
    expect(
      publicIngressHealth(
        "custom",
        "unreachable",
        { a: ["203.0.113.10"], aaaa: [] },
        { a: ["203.0.113.10"], aaaa: [] },
        startedAt,
        startedAt + 30_000,
      ),
    ).toBe("starting");
    expect(
      publicIngressHealth(
        "cloudflare",
        "unreachable",
        addresses,
        addresses,
        startedAt,
        startedAt + 60_000,
      ),
    ).toBe("unreachable");
  });

  test("uses proven healthy DNS when a NATed server cannot detect its public IP", () => {
    const dns = { a: ["203.0.113.10"], aaaa: [] };
    expect(displayedServerAddresses({ a: [], aaaa: [] }, dns, "ready")).toEqual(
      dns,
    );
    expect(
      displayedServerAddresses({ a: [], aaaa: [] }, dns, "unreachable"),
    ).toEqual({ a: [], aaaa: [] });
  });

  test("saves a bare private app domain and keeps status on the persisted value", async () => {
    const { path, envPath } = fixture();
    process.env.OPENSESSION_UI_BASE = "https://app.example.test";
    expect(normalizePrivateAppOrigin("team.example.test")).toBe(
      "https://team.example.test",
    );
    await savePrivateAppOrigin("team.example.test");
    expect(JSON.parse(readFileSync(path, "utf8")).server.publicBaseUrl).toBe(
      "https://team.example.test",
    );
    expect(readFileSync(envPath, "utf8")).toContain(
      "OPENSESSION_UI_BASE=https://team.example.test",
    );
    expect(process.env.OPENSESSION_UI_BASE).toBe("https://app.example.test");
    expect(configuredPrivateAppOrigin()).toBe("https://team.example.test");
  });

  test("persists and immediately activates the public callback origin", async () => {
    const { path, envPath } = fixture();
    process.env.OPENSESSION_INGRESS_BASE = "https://old-ingress.example.test";
    await savePublicIngress({
      publicBaseUrl: "https://ingress.example.test",
      exposure: "custom",
    });
    expect(JSON.parse(readFileSync(path, "utf8")).ingress.publicBaseUrl).toBe(
      "https://ingress.example.test",
    );
    expect(readFileSync(envPath, "utf8")).toContain(
      "OPENSESSION_INGRESS_BASE=https://ingress.example.test",
    );
    expect(process.env.OPENSESSION_INGRESS_BASE).toBe(
      "https://ingress.example.test",
    );
    process.env.OPENSESSION_INGRESS_BASE = "https://old-ingress.example.test";
    expect(configuredPublicIngress().publicBaseUrl).toBe(
      "https://ingress.example.test",
    );
  });

  test("saves a public address override for direct HTTPS", async () => {
    const { envPath } = fixture();
    await savePublicIngress({
      publicBaseUrl: "https://ingress.example.test",
      exposure: "custom",
      publicIp: "8.8.8.8",
    });
    expect(process.env.OPENSESSION_PUBLIC_IPV4).toBe("8.8.8.8");
    expect(readFileSync(envPath, "utf8")).toContain(
      "OPENSESSION_PUBLIC_IPV4=8.8.8.8",
    );
    await expect(
      savePublicIngress({
        publicBaseUrl: "https://ingress.example.test",
        exposure: "custom",
        publicIp: "100.64.0.10",
      }),
    ).rejects.toThrow("publicly routable");
  });

  test("writes one canonical owner and removes retired server fields", async () => {
    const { path } = fixture();
    await savePublicIngress({
      publicBaseUrl: "https://ingress.example.test",
      exposure: "cloudflare",
      cloudflareTunnelId: "11111111-2222-3333-4444-555555555555",
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.ingress).toEqual({
      publicBaseUrl: "https://ingress.example.test",
      exposure: "cloudflare",
      cloudflareTunnelId: "11111111-2222-3333-4444-555555555555",
    });
    expect(saved.server).toEqual({ publicBaseUrl: "https://app.example.test" });
  });
});
