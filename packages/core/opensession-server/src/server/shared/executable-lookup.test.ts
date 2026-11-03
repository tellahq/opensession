import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findExecutable } from "./executable-lookup";

const savedPath = process.env.PATH;
const roots: string[] = [];

afterEach(() => {
  process.env.PATH = savedPath;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function binDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "executable-lookup-"));
  roots.push(dir);
  return dir;
}

describe("findExecutable", () => {
  test("finds the first executable on PATH and skips non-executable files", async () => {
    const first = binDir();
    const second = binDir();
    writeFileSync(join(first, "acme-tool"), "not executable");
    writeFileSync(join(second, "acme-tool"), "#!/bin/sh\n");
    chmodSync(join(second, "acme-tool"), 0o755);
    process.env.PATH = `${first}:${second}`;
    expect(await findExecutable("acme-tool")).toBe(join(second, "acme-tool"));
  });

  test("returns null for a missing tool and agrees with Bun.which", async () => {
    process.env.PATH = binDir();
    expect(await findExecutable("acme-missing-tool")).toBeNull();
    process.env.PATH = savedPath;
    expect(await findExecutable("sh")).toBe(Bun.which("sh"));
  });
});
