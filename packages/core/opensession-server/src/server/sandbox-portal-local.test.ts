import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "portal-local-"));
const previous = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;
mock.module("./preview", () => ({
  ensureAuthenticatedPortalRoute: async () =>
    "https://portals.example.test:21000",
  dropAuthenticatedPortalRoute: async () => {},
}));
const {
  ensureSandboxPortalRelay,
  mintSandboxPortalGrant,
  RELAY_RENEW_BEFORE_EXPIRY_MS,
  revokeSandboxPortalRelay,
  sandboxPortalLocalDir,
  sandboxPortalLocalUrls,
  sandboxPortalRelayClose,
  sandboxPortalRelayConnected,
  sandboxPortalRelayOpen,
  startSandboxPortalRelays,
  verifySandboxPortalGrant,
} = await import("./sandbox-portal-relay");

afterAll(() => {
  if (previous === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

async function settle(read: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !read(); i++) await Bun.sleep(20);
}

test("records a Sandbox Portal's loopback address for shells on this machine", async () => {
  const identity = { sessionId: "os-local", sandboxId: "bx_local", port: 4000 };
  await ensureSandboxPortalRelay({ ...identity, name: "web" });
  const record = join(sandboxPortalLocalDir("os-local"), "4000.json");
  await settle(() => existsSync(record));
  const { name, port, url } = JSON.parse(readFileSync(record, "utf8"));
  expect({ name, port }).toEqual({ name: "web", port: 4000 });
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  // Shown with localhost, which dev servers accept as a page origin.
  expect(await sandboxPortalLocalUrls("os-local")).toEqual(
    new Map([["web", url.replace("127.0.0.1", "localhost")]]),
  );
  // A caller that does not know the name keeps the recorded one.
  await ensureSandboxPortalRelay(identity);
  await Bun.sleep(50);
  expect(JSON.parse(readFileSync(record, "utf8")).name).toBe("web");

  revokeSandboxPortalRelay("bx_local", 4000);
  await settle(() => !existsSync(record));
  expect(existsSync(record)).toBe(false);
});

test("renews a connected relay's credential over its socket", async () => {
  const identity = { sessionId: "os-renew", sandboxId: "bx_renew", port: 4100 };
  await ensureSandboxPortalRelay({ ...identity, name: "web" });
  const first = mintSandboxPortalGrant(identity);
  const sent: any[] = [];
  const ws: any = {
    data: {
      kind: "sandbox-portal-relay",
      ...identity,
      // Due for renewal almost at once.
      expiresAt: Date.now() + RELAY_RENEW_BEFORE_EXPIRY_MS + 30,
    },
    close() {},
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
  };
  sandboxPortalRelayOpen(ws);
  try {
    await settle(() => sent.some((message) => message.t === "renew"));
    const renew = sent.find((message) => message.t === "renew");
    expect(renew.expiresAt).toBeGreaterThan(Date.now() + 5 * 60_000);
    expect(verifySandboxPortalGrant(renew.token, identity)).toBe(true);
    // The new credential supersedes the old one.
    expect(verifySandboxPortalGrant(first.token, identity)).toBe(false);
    expect(sandboxPortalRelayConnected(identity, 5 * 60_000)).toBe(true);
  } finally {
    sandboxPortalRelayClose(ws);
    revokeSandboxPortalRelay("bx_renew", 4100);
  }
});

test("a restarted process rebinds a relay on its recorded loopback port", async () => {
  const identity = { sessionId: "os-boot", sandboxId: "bx_boot", port: 4200 };
  await ensureSandboxPortalRelay({ ...identity, name: "app" });
  const record = join(sandboxPortalLocalDir("os-boot"), "4200.json");
  const index = join(root, ".opensession-sandbox-portal-relays.json");
  const indexed = () =>
    existsSync(index) &&
    readFileSync(index, "utf8").includes('"sandboxId":"bx_boot"');
  await settle(() => existsSync(record) && indexed());
  const { url } = JSON.parse(readFileSync(record, "utf8"));
  // Simulate the restart: this process's relays are gone, the files stay.
  const relays = (globalThis as any).__opensessionSandboxPortalRelays as Map<
    string,
    any
  >;
  const relay = relays.get("os-boot:bx_boot:4200");
  relay.server.stop(true);
  relays.delete("os-boot:bx_boot:4200");

  expect(await startSandboxPortalRelays()).toBeGreaterThanOrEqual(1);
  const rebound = relays.get("os-boot:bx_boot:4200");
  expect(`http://127.0.0.1:${rebound.server.port}`).toBe(url);
  // Nothing is connected and the Sandbox has no Portal route here, so the
  // address answers at once rather than refusing the connection.
  const response = await fetch(`${url}/`);
  expect(response.status).toBe(503);
  expect((await sandboxPortalLocalUrls("os-boot")).get("app")).toBe(
    url.replace("127.0.0.1", "localhost"),
  );

  revokeSandboxPortalRelay("bx_boot", 4200);
  await settle(() => !indexed());
  expect(indexed()).toBe(false);
});
