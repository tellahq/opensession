import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.each([
  { args: ["--clear-storage", "--workspace", "/not-a-workspace"] },
  { args: ["--confirm", "--workspace", "/not-a-workspace"] },
])("maintenance CLI rejects incomplete confirmation: %j", async ({ args }) => {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "main.ts"), ...args],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(status).not.toBe(0);
  expect(stderr).toContain("confirm");
  expect(stdout).not.toContain("Cleared");
});
