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
  revokeSandboxPortalRelay,
  sandboxPortalLocalDir,
  sandboxPortalLocalUrls,
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
  expect(await sandboxPortalLocalUrls("os-local")).toEqual(
    new Map([["web", url]]),
  );
  // A caller that does not know the name keeps the recorded one.
  await ensureSandboxPortalRelay(identity);
  await Bun.sleep(50);
  expect(JSON.parse(readFileSync(record, "utf8")).name).toBe("web");

  revokeSandboxPortalRelay("bx_local", 4000);
  await settle(() => !existsSync(record));
  expect(existsSync(record)).toBe(false);
});
