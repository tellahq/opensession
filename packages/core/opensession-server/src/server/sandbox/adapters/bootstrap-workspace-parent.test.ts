import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceParentCommand } from "./bootstrap";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0).reverse()) {
    if (existsSync(dir)) chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function run(cwd: string, root: string) {
  const log = join(root, "sudo.log");
  const bin = join(root, "bin");
  await Bun.$`mkdir -p ${bin}`;
  writeFileSync(
    join(bin, "sudo"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`,
  );
  chmodSync(join(bin, "sudo"), 0o755);
  const child = Bun.spawn(["bash", "-c", ensureWorkspaceParentCommand(cwd)], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return {
    code: await child.exited,
    sudo: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

describe("ensureWorkspaceParentCommand", () => {
  test("creates a writable parent without sudo", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-parent-"));
    scratch.push(root);
    const cwd = join(root, "checkouts", "repo");
    const result = await run(cwd, root);
    expect(result.code).toBe(0);
    expect(existsSync(join(root, "checkouts"))).toBe(true);
    expect(result.sudo).toEqual([]);
  });

  test("falls back to sudo and hands the parent to the user", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-parent-"));
    scratch.push(root);
    const locked = join(root, "locked");
    await Bun.$`mkdir -p ${locked}`;
    chmodSync(locked, 0o555);
    scratch.push(locked);
    const parent = join(locked, "jake", "checkouts");
    const result = await run(join(parent, "repo"), root);
    expect(result.code).toBe(0);
    expect(result.sudo[0]).toBe(`-n mkdir -p ${parent}`);
    expect(result.sudo[1]).toMatch(
      new RegExp(`^-n chown \\d+:\\d+ ${parent}$`),
    );
  });
});
