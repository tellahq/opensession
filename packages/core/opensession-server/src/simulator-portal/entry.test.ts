import { expect, test } from "bun:test";
import { resolve } from "node:path";

const controller = resolve(import.meta.dir, "../main.ts");

/** The compiled binary reaches the viewer through `opensession simulator-portal`;
 * from source the same front controller runs under bun, so the dispatch is
 * observable without compiling. A missing flag stops the entry before it binds
 * a port or touches a simulator, which keeps this hermetic. */
async function dispatch(args: string[]) {
  const proc = Bun.spawn([process.execPath, controller, ...args], {
    cwd: resolve(import.meta.dir, "../../../../.."),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      OPENSESSION_DISPATCH_DEBUG: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("the simulator-portal subcommand dispatches to the viewer entry with the subcommand spliced out", async () => {
  const run = await dispatch(["simulator-portal", "--workspace", "/acme"]);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain('[dispatch] sub="simulator-portal"');
  // The viewer's own argument validation ran: --session is required.
  expect(run.stderr).toContain("session");
  expect(run.stdout + run.stderr).not.toContain("unknown command");
}, 40_000);

test("an unknown subcommand still falls through to the CLI", async () => {
  const run = await dispatch(["simulator-portal-typo"]);
  expect(run.stdout + run.stderr).toContain("unknown command");
}, 40_000);
