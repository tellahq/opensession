import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLog, serviceLogDirFromDefinition } from "./maintenance";

describe("rotateLog", () => {
  test("rotates a log over the cap: truncates in place and keeps .1", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-maint-"));
    const log = join(dir, "server.log");
    const body = "x".repeat(2048);
    writeFileSync(log, body);

    const freed = rotateLog(log, 1024); // cap below current size

    expect(freed).toBe(2048);
    expect(statSync(log).size).toBe(0); // live log truncated
    expect(readFileSync(`${log}.1`, "utf8")).toBe(body); // rotation preserved
  });

  test("truncates without a rotation when the copy runs out of space", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-maint-"));
    const log = join(dir, "server.log");
    writeFileSync(log, "x".repeat(2048));

    const freed = rotateLog(log, 1024, {
      copy: (_source, destination) => {
        writeFileSync(destination, "partial");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
      truncate: (path) => truncateSync(path, 0),
      remove: (path) => rmSync(path, { force: true }),
    });

    expect(freed).toBe(2048);
    expect(statSync(log).size).toBe(0);
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  test("leaves a log under the cap untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-maint-"));
    const log = join(dir, "server.log");
    writeFileSync(log, "small");

    const freed = rotateLog(log, 1024);

    expect(freed).toBe(0);
    expect(statSync(log).size).toBe(5);
    expect(() => statSync(`${log}.1`)).toThrow(); // no rotation created
  });

  test("no-ops on a missing log", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-maint-"));
    expect(rotateLog(join(dir, "nope.log"), 1024)).toBe(0);
  });
});

describe("serviceLogDirFromDefinition", () => {
  test("reads an existing systemd file log path", () => {
    expect(
      serviceLogDirFromDefinition(
        "[Service]\nStandardOutput=append:/srv/os/logs/server.log\n",
      ),
    ).toBe("/srv/os/logs");
  });

  test("uses a valid systemd error path when stdout is not a file", () => {
    expect(
      serviceLogDirFromDefinition(
        "[Service]\nStandardOutput=journal\nStandardError=append:/srv/os/logs/server.err.log\n",
      ),
    ).toBe("/srv/os/logs");
  });

  test("reads and decodes an existing launchd log path", () => {
    expect(
      serviceLogDirFromDefinition(
        "<key>StandardOutPath</key><string>/srv/Open &amp; Session/logs/server.log</string>",
      ),
    ).toBe("/srv/Open & Session/logs");
  });

  test("derives a custom release home from an older unit executable", () => {
    expect(
      serviceLogDirFromDefinition(
        "[Service]\nExecStart=/srv/os/bin/opensession server\n",
      ),
    ).toBe("/srv/os/logs");
  });

  test("ignores unrelated service files", () => {
    expect(serviceLogDirFromDefinition("[Service]\nExecStart=/usr/bin/other\n")).toBeNull();
  });
});
