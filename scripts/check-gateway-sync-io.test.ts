import { describe, expect, test } from "bun:test";
import {
  compareWithBaseline,
  countByFile,
  readBaseline,
  scanGateway,
  scanSource,
  staleBaselineFiles,
} from "./check-gateway-sync-io";

describe("gateway sync I/O scan", () => {
  test("finds named, aliased and namespace fs calls and sync subprocesses", () => {
    const sites = scanSource(
      "x.ts",
      [
        'import { readFileSync, existsSync as exists, readFile } from "node:fs";',
        'import * as fs from "fs";',
        'import cp, { spawnSync } from "node:child_process";',
        "readFileSync('a');",
        "[1].filter(exists);",
        "fs.mkdirSync('b');",
        "fs.promises.readFile('c');",
        "cp.execFileSync('git');",
        "spawnSync('git');",
        "Bun.spawnSync(['git']);",
        "Bun.which('git');",
        "Bun.spawn(['git']);",
        "readFile('d', () => {});",
        "const o = { readFileSync: 1 }; o.readFileSync;",
      ].join("\n"),
    );
    expect(sites.map((site) => `${site.line} ${site.call}`)).toEqual([
      "4 readFileSync",
      "5 existsSync",
      "6 fs.mkdirSync",
      "8 cp.execFileSync",
      "9 spawnSync",
      "10 Bun.spawnSync",
      "11 Bun.which",
    ]);
  });

  test("an explicit marker exempts one call", () => {
    const sites = scanSource(
      "x.ts",
      [
        'import { writeFileSync } from "node:fs";',
        "// gateway-sync-ok: process exit hook, the loop is already gone",
        "process.on('exit', () => writeFileSync('a', 'b'));",
        "writeFileSync('c', 'd');",
      ].join("\n"),
    );
    expect(sites.map((site) => site.line)).toEqual([4]);
  });

  test("the baseline only shrinks", () => {
    expect(compareWithBaseline({ "a.ts": 2 }, { "a.ts": 2 })).toEqual([]);
    expect(compareWithBaseline({ "a.ts": 3 }, { "a.ts": 2 })[0]).toContain(
      "baseline allows 2",
    );
    expect(compareWithBaseline({ "b.ts": 1 }, {})[0]).toContain(
      "baseline allows 0",
    );
    expect(compareWithBaseline({ "a.ts": 1 }, { "a.ts": 2 })).toEqual([]);
    expect(
      staleBaselineFiles(
        { "a.ts": 1, "b.ts": 1 },
        { "a.ts": 2, "b.ts": 1, "c.ts": 1 },
      ),
    ).toEqual(["a.ts", "c.ts"]);
  });

  test("gateway modules add no synchronous filesystem or subprocess calls", () => {
    const sites = scanGateway();
    expect(
      compareWithBaseline(countByFile(sites), readBaseline(), sites),
    ).toEqual([]);
  });
});
