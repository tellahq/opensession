import { expect, it } from "bun:test";
import { join } from "node:path";

it("passes PR cache staleness integration cases in a fresh process", async () => {
  const fixture = join(
    import.meta.dir,
    "../../../../../test/fixtures/pr-cache-staleness.fixture.ts",
  );
  const proc = Bun.spawn([process.execPath, "test", fixture], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
