/**
 * The guard that keeps module-scope side effects out of the server and executor,
 * plus the control that proves the guard can still see one.
 *
 * The control matters more than it looks: this check reports "nothing was
 * created at import time", and a probe that quietly stopped instrumenting
 * anything would report exactly the same thing. So the second test hands it a
 * module that DOES arm a ticker and asserts it is caught.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  scanModuleSideEffects,
  serverModules,
} from "./check-module-side-effects";

const scratch = mkdtempSync(`${tmpdir()}/side-effect-guard-`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("module-scope side effects", () => {
  test("no server or executor module binds, ticks or spawns at import time", async () => {
    const scan = await scanModuleSideEffects();
    // A module that cannot be imported in a bare process is unmeasured, not
    // clean — surface it rather than counting it as a pass.
    expect(scan.failed).toEqual([]);
    expect(scan.scanned).toBeGreaterThan(200);
    expect(
      scan.hits.map((h) => `${h.kind} at ${h.frame} (via ${h.module})`),
    ).toEqual([]);
  }, 120_000);

  test("the guard catches a module that arms a ticker at import", async () => {
    const fixture = `${scratch}/ticking-module.ts`;
    writeFileSync(
      fixture,
      "setInterval(() => {}, 60_000);\nexport const armed = true;\n",
    );
    const scan = await scanModuleSideEffects([fixture]);
    expect(scan.failed).toEqual([]);
    expect(scan.hits.map((h) => h.kind)).toEqual(["setInterval"]);
  }, 60_000);

  test("scans the whole server graph, not a handful of files", () => {
    const modules = serverModules();
    expect(modules.length).toBeGreaterThan(200);
    expect(modules).toContain(
      "packages/core/opensession-server/src/server/interactive-mcp.ts",
    );
    expect(modules).toContain(
      "packages/core/opensession-server/src/server/session-index.ts",
    );
    expect(modules).toContain(
      "packages/core/opensession-server/src/executor/main.ts",
    );
    expect(modules.filter((m) => m.endsWith(".test.ts"))).toEqual([]);
  });
});
