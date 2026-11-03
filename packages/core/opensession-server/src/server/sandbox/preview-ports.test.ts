import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setSessionsDirForTest } from "../paths";
import {
  SANDBOX_HTTPS_BASE,
  SANDBOX_HTTPS_RANGE,
  lookupSandboxHttpsPort,
  releaseSandboxPreviewPorts,
  sandboxAllocationForHttpsPort,
  sandboxHttpsPortFor,
} from "./preview-ports";

let scratch: string;
let prevDir: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bks-preview-ports-"));
  prevDir = __setSessionsDirForTest(scratch);
});

afterAll(() => {
  __setSessionsDirForTest(prevDir);
  rmSync(scratch, { recursive: true, force: true });
});

describe("sandbox preview https-port allocator", () => {
  test("allocates inside the sandbox range, disjoint from the host scheme", async () => {
    const p = await sandboxHttpsPortFor("bks-sbx-a", 3300);
    expect(p).toBeGreaterThanOrEqual(SANDBOX_HTTPS_BASE);
    expect(p).toBeLessThan(SANDBOX_HTTPS_BASE + SANDBOX_HTTPS_RANGE);
    // The host scheme (webappPort + 6000) tops out at 9999 — structurally
    // below the sandbox range, so a host preview can never compute p.
    expect(p).toBeGreaterThan(3999 + 6000);
  });

  test("stable per (sandboxId, containerPort), persisted across reads", async () => {
    const p1 = await sandboxHttpsPortFor("bks-sbx-a", 3300);
    const p2 = await sandboxHttpsPortFor("bks-sbx-a", 3300);
    expect(p2).toBe(p1);
    expect(await lookupSandboxHttpsPort("bks-sbx-a", 3300)).toBe(p1);
  });

  test("two sandboxes with the SAME container port never collide", async () => {
    const a = await sandboxHttpsPortFor("bks-sbx-a", 3300);
    const b = await sandboxHttpsPortFor("bks-sbx-b", 3300);
    expect(b).not.toBe(a);
  });

  test("probing walks past occupied slots (forced hash collision)", async () => {
    // Allocate many keys; every allocation must be unique regardless of hash
    // collisions in the deterministic first guess.
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const p = await sandboxHttpsPortFor(`bks-sbx-many-${i}`, 3300);
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
  });

  test("lookup never allocates", async () => {
    expect(
      await lookupSandboxHttpsPort("bks-sbx-never-started", 3300),
    ).toBeNull();
  });

  test("reverses a durable allocation for restart recovery", async () => {
    const httpsPort = await sandboxHttpsPortFor("bks-sbx-recover", 3302);
    expect(await sandboxAllocationForHttpsPort(httpsPort)).toEqual({
      sandboxId: "bks-sbx-recover",
      containerPort: 3302,
    });
    expect(await sandboxAllocationForHttpsPort(19_999)).toBeNull();
  });

  test("release drops all of a sandbox's allocations and returns the ports", async () => {
    const p1 = await sandboxHttpsPortFor("bks-sbx-rel", 3300);
    const p2 = await sandboxHttpsPortFor("bks-sbx-rel", 3301);
    const released = (await releaseSandboxPreviewPorts("bks-sbx-rel")).sort();
    expect(released).toEqual([p1, p2].sort());
    expect(await lookupSandboxHttpsPort("bks-sbx-rel", 3300)).toBeNull();
    // Other sandboxes' allocations survive.
    expect(await lookupSandboxHttpsPort("bks-sbx-a", 3300)).not.toBeNull();
  });
});
