import { describe, expect, test } from "bun:test";
import {
  ancestorPids,
  CLI_HANDOFF_ENV,
  cliCommandRestartsService,
  handOffIfUnderService,
  LAUNCHD_HANDOFF_LABEL,
  renderHandoffPlist,
} from "./launchd-handoff";

const DOMAIN = "gui/501";
const LABELS = ["dev.opensession.server", "dev.opensession.session-kernel"];

/** launchctl/ps answers for a server (pid 100) whose session shell runs
 * the CLI as pid 300 (100 → 200 → 300), plus an unrelated terminal (400). */
function fakeSystem(opts: { handoffState?: "running" | "exited" } = {}) {
  const calls: string[][] = [];
  const runCommand = (async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[0] === "ps")
      return {
        code: 0,
        stdout: "1 0\n100 1\n150 1\n200 100\n300 200\n400 1",
        stderr: "",
      };
    const target = cmd[2] ?? "";
    if (target.endsWith("/dev.opensession.server"))
      return {
        code: 0,
        stdout: "\tstate = running\n\tpid = 100\n",
        stderr: "",
      };
    if (target.endsWith("/dev.opensession.session-kernel"))
      return { code: 0, stdout: "\tpid = 150\n", stderr: "" };
    if (target.endsWith(`/${LAUNCHD_HANDOFF_LABEL}`))
      return opts.handoffState
        ? { code: 0, stdout: `\tstate = ${opts.handoffState}\n`, stderr: "" }
        : { code: 113, stdout: "", stderr: "Could not find service" };
    throw new Error(`unexpected ${cmd.join(" ")}`);
  }) as never;
  const bootstrapped: string[] = [];
  const bootedOut: string[] = [];
  const written: string[] = [];
  return {
    calls,
    bootstrapped,
    bootedOut,
    written,
    opts: {
      serviceLabels: LABELS,
      domain: DOMAIN,
      runCommand,
      cli: ["/home/me/.opensession/bin/opensession"],
      env: { PATH: "/usr/bin:/bin" },
      writePlist: (_path: string, contents: string) => written.push(contents),
      bootstrap: async (label: string) => {
        bootstrapped.push(label);
        return { code: 0, stderr: "" };
      },
      bootout: async (label: string) => {
        bootedOut.push(label);
        return { code: 0, stderr: "" };
      },
    },
  };
}

describe("launchd CLI handoff", () => {
  test("only commands that stop or restart the service hand off", () => {
    for (const argv of [["restart"], ["stop"], ["bind", "lan"], ["update"]])
      expect(cliCommandRestartsService(argv)).toBe(true);
    for (const argv of [
      ["status"],
      ["start"],
      ["update", "--check"],
      ["update", "--no-restart"],
      ["logs"],
    ])
      expect(cliCommandRestartsService(argv)).toBe(false);
  });

  test("walks the parent chain", () => {
    expect(ancestorPids("100 1\n200 100\n300 200", 300)).toEqual([200, 100]);
    expect(ancestorPids("5 6\n6 5", 5)).toEqual([6]);
  });

  test("a restart from a session shell runs as its own launchd job", async () => {
    const sys = fakeSystem();
    const result = await handOffIfUnderService(["update"], {
      ...sys.opts,
      pid: 300,
    });
    expect(result).toMatchObject({ handedOff: true, code: 0 });
    expect(sys.bootstrapped).toEqual([LAUNCHD_HANDOFF_LABEL]);
    expect(sys.bootedOut).toEqual([]);
    const plist = sys.written[0]!;
    expect(plist).toContain(
      "<string>/home/me/.opensession/bin/opensession</string>\n    <string>update</string>",
    );
    expect(plist).toContain(`<key>${CLI_HANDOFF_ENV}</key><string>1</string>`);
    expect(plist).toContain("<key>LaunchOnlyOnce</key><true/>");
    expect(plist).not.toContain("KeepAlive");
  });

  test("a terminal outside the server runs the command itself", async () => {
    const sys = fakeSystem();
    expect(
      await handOffIfUnderService(["restart"], { ...sys.opts, pid: 400 }),
    ).toEqual({ handedOff: false });
    expect(sys.bootstrapped).toEqual([]);
  });

  test("the handoff job itself never hands off again", async () => {
    const sys = fakeSystem();
    expect(
      await handOffIfUnderService(["restart"], {
        ...sys.opts,
        pid: 300,
        env: { [CLI_HANDOFF_ENV]: "1" },
      }),
    ).toEqual({ handedOff: false });
    expect(sys.calls).toEqual([]);
  });

  test("clears a finished handoff and refuses while one still runs", async () => {
    const finished = fakeSystem({ handoffState: "exited" });
    expect(
      await handOffIfUnderService(["restart"], { ...finished.opts, pid: 300 }),
    ).toMatchObject({ handedOff: true, code: 0 });
    expect(finished.bootedOut).toEqual([LAUNCHD_HANDOFF_LABEL]);

    const running = fakeSystem({ handoffState: "running" });
    expect(
      await handOffIfUnderService(["restart"], { ...running.opts, pid: 300 }),
    ).toMatchObject({ handedOff: true, code: 1 });
    expect(running.bootstrapped).toEqual([]);
  });

  test("escapes plist values", () => {
    expect(
      renderHandoffPlist({
        programArguments: ["/a&b/<x>"],
        path: "/bin",
        log: "/l",
      }),
    ).toContain("<string>/a&amp;b/&lt;x&gt;</string>");
  });
});
