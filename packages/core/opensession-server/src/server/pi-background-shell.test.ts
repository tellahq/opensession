import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalBackgroundShells,
  createRemoteBackgroundShells,
  shellReportText,
  type BackgroundExit,
  type BackgroundShells,
} from "./pi-background-shell";
import {
  RemoteWorkspace,
  type RemoteWorkspaceTransport,
} from "./remote-workspace";

let root: string;
let checkout: string;
let scratch: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "os-bg-shell-"));
  checkout = join(root, "checkout");
  scratch = join(root, "scratch");
  mkdirSync(checkout, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = () => ({ PATH: process.env.PATH || "/usr/bin:/bin" });

/** bash in its own process group, as the runner starts it. */
function local(exits: BackgroundExit[] = []): BackgroundShells {
  return createLocalBackgroundShells({
    outputCap: 1_000,
    startWaitS: 0.3,
    onExit: (exit) => exits.push(exit),
    spawn: async (command) => {
      const proc = Bun.spawn(["setsid", "/bin/bash", "-c", command], {
        cwd: checkout,
        env: env(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: proc.exited,
        killTree: () => {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {}
        },
      };
    },
  });
}

// The "Sandbox" is a temp dir here, and the transport runs each script the
// way a provider does: `bash -c` after a cd, returning when its pipes close.
const transport: RemoteWorkspaceTransport = async (body) => {
  const proc = Bun.spawn(
    ["bash", "-c", `cd -- "$OS_CWD" || exit 125\n${String(body.script)}`],
    {
      env: {
        ...env(),
        HOME: root,
        ...(body.env as Record<string, string> | undefined),
        OS_CWD: String(body.cwd || "/"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function remote(exits: BackgroundExit[] = []): BackgroundShells {
  return createRemoteBackgroundShells({
    workspace: new RemoteWorkspace(
      {
        provider: "box",
        sandboxId: "bx_test",
        cwd: checkout,
        scratchDir: scratch,
      },
      transport,
    ),
    env: { OPENSESSION_SCRATCH: scratch },
    outputCap: 1_000,
    startWaitS: 1,
    onExit: (exit) => exits.push(exit),
  });
}

for (const [where, make] of [
  ["on this machine", local],
  ["in a Sandbox", remote],
] as const) {
  describe(`background commands ${where}`, () => {
    test("a quick command reports its result from the start call", async () => {
      const exits: BackgroundExit[] = [];
      const shells = make(exits);
      const report = await shells.start("echo hello; echo oops >&2");
      expect(report.running).toBe(false);
      expect(report.exitCode).toBe(0);
      expect(report.output).toContain("hello");
      expect(report.output).toContain("oops");
      expect(exits.map((exit) => exit.exitCode)).toEqual([0]);
      // Reported once, then forgotten.
      await expect(shells.status(report.id, 0)).rejects.toThrow(
        /No background command/,
      );
      await shells.dispose();
    });

    test("a slow command keeps running and hands back only new output", async () => {
      const shells = make();
      const started = await shells.start(
        "echo one; sleep 2; echo two; sleep 2; echo three; exit 3",
      );
      expect(started.running).toBe(true);
      expect(started.exitCode).toBeNull();
      expect(started.output).toContain("one");

      const middle = await shells.status(started.id, 2.5);
      expect(middle.running).toBe(true);
      expect(middle.output).toContain("two");
      expect(middle.output).not.toContain("one");

      // The wait ends when the command does, not when the wait runs out.
      const before = Date.now();
      const last = await shells.status(started.id, 30);
      expect(Date.now() - before).toBeLessThan(10_000);
      expect(last.running).toBe(false);
      expect(last.exitCode).toBe(3);
      expect(last.output).toContain("three");
      expect(last.output).not.toContain("two");
      await shells.dispose();
    }, 20_000);

    test("output past the cap keeps its tail and says how much went", async () => {
      const shells = make();
      const report = await shells.start(
        "head -c 5000 /dev/zero | tr '\\0' x; echo END",
      );
      expect(report.running).toBe(false);
      expect(report.output.length).toBeLessThanOrEqual(1_000);
      expect(report.output.trimEnd().endsWith("END")).toBe(true);
      expect(report.droppedChars).toBeGreaterThan(4_000);
      await shells.dispose();
    });

    test("kill stops the command and what it started", async () => {
      const exits: BackgroundExit[] = [];
      const shells = make(exits);
      const marker = join(root, `survivor-${where.replace(/\W/g, "")}`);
      const started = await shells.start(
        `(sleep 1.5; touch ${marker}) & echo up; sleep 60`,
      );
      expect(started.running).toBe(true);
      const killed = await shells.kill(started.id);
      expect(killed.running).toBe(false);
      expect(killed.exitCode).toBeNull();
      expect(exits.at(-1)?.killed).toBe(true);
      await Bun.sleep(2_000);
      expect(existsSync(marker)).toBe(false);
      await shells.dispose();
    }, 20_000);

    test("the end of the run stops whatever is still going", async () => {
      const shells = make();
      const marker = join(root, `left-${where.replace(/\W/g, "")}`);
      const started = await shells.start(`sleep 1.5; touch ${marker}`);
      expect(started.running).toBe(true);
      await shells.dispose();
      await Bun.sleep(2_000);
      expect(existsSync(marker)).toBe(false);
      await expect(shells.status(started.id, 0)).rejects.toThrow(
        /No background command/,
      );
      await expect(shells.start("echo late")).rejects.toThrow(/ended/);
    }, 20_000);

    test("an aborted wait returns at once and leaves the command running", async () => {
      const shells = make();
      const started = await shells.start("sleep 30");
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 200);
      const before = Date.now();
      const report = await shells.status(started.id, 60, abort.signal);
      expect(Date.now() - before).toBeLessThan(5_000);
      expect(report.running).toBe(true);
      await shells.dispose();
    }, 20_000);
  });
}

describe("shellReportText", () => {
  const base = {
    id: "bg1",
    output: "",
    droppedChars: 0,
    runningForS: 42,
    silentForS: 0,
  };

  test("says a running command is running, and for how long it was quiet", () => {
    expect(
      shellReportText({
        ...base,
        running: true,
        exitCode: null,
        silentForS: 12,
      }),
    ).toBe(
      "[bg1 is still running after 42s, no output for 12s]\n(no new output)",
    );
  });

  test("reports an exit with its code and output", () => {
    expect(
      shellReportText({
        ...base,
        running: false,
        exitCode: 1,
        output: "boom\n",
        droppedChars: 7,
      }),
    ).toBe(
      "[bg1 exited with code 1 after 42s]\n[output truncated: first 7 characters dropped]\nboom\n",
    );
  });

  test("a killed command has no exit code to report", () => {
    expect(shellReportText({ ...base, running: false, exitCode: null })).toBe(
      "[bg1 was stopped after 42s]\n(no more output)",
    );
  });
});
