import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HOME = mkdtempSync(join(tmpdir(), "os-sandbox-portals-test-"));
const previous = process.env.HOME;
process.env.HOME = HOME;
const {
  cachedSandboxPortalOwner,
  cacheSandboxPortals,
  dropCachedSandboxPortals,
  sleepingSandboxPortalStatus,
} = await import("./sandbox-portals");

beforeEach(() => dropCachedSandboxPortals("sbx-test"));
afterAll(() => {
  process.env.HOME = previous;
  rmSync(HOME, { recursive: true, force: true });
});

describe("sleeping Sandbox Portal cache", () => {
  test("keeps metadata readable without retaining a live URL", () => {
    cacheSandboxPortals("bks-test", "sbx-test", [
      {
        name: "Demo",
        key: "PORTAL_DEMO_PORT",
        port: 4400,
        running: true,
        pids: [],
        previewUrl: "https://preview.test:20000",
        description: "A test service",
        state: "awake",
        managed: true,
      },
    ]);
    const status = sleepingSandboxPortalStatus("bks-test", "sbx-test");
    expect(status?.services).toEqual([
      {
        name: "Demo",
        key: "PORTAL_DEMO_PORT",
        port: 4400,
        running: false,
        pids: [],
        previewUrl: null,
        description: "A test service",
        state: "sleeping",
        managed: true,
      },
    ]);
    expect(cachedSandboxPortalOwner("sbx-test", 4400)).toBe("bks-test");
    expect(cachedSandboxPortalOwner("sbx-test", 4401)).toBeNull();
  });
});
