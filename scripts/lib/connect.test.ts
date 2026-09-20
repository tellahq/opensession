import { describe, expect, test } from "bun:test";
import {
  parseRunnerPortalRegistry,
  repairWindowsPath,
  resolveWindowsSchtasks,
  resolveWindowsShell,
  runnerExecCommand,
  runnerCommandAwsEnvironment,
  runnerLaunchdPlist,
  runnerScheduledTaskXml,
  scheduledTaskStartBoundary,
  runnerSystemdUnit,
  serializeRunnerPortalRegistry,
  windowsPowerShellPath,
  windowsRunnerEnvironment,
  windowsSystem32,
} from "./connect";

describe("Runner service definitions", () => {
  test("launchd reconnects through the CLI without embedding a credential", () => {
    const plist = runnerLaunchdPlist(
      "/opt/opensession/cli",
      "/opt/bun/bin/bun",
    );
    expect(plist).toContain("runner</string><string>run");
    expect(plist).toContain("KeepAlive");
    expect(plist).not.toContain("runner.json");
  });

  test("systemd uses a user service with restart semantics", () => {
    const unit = runnerSystemdUnit("/opt/opensession/cli", "/opt/bun/bin/bun");
    expect(unit).toContain(
      "ExecStart=/opt/bun/bin/bun /opt/opensession/cli runner run",
    );
    expect(unit).toContain("Restart=always");
    expect(unit).not.toContain("Token=");
  });

  test("the compiled binary re-invokes itself without a script argument", () => {
    // A `bun build --compile` binary reports `/$bunfs/root/opensession` as
    // argv[1]; passing that along made every service start exit with
    // `unknown command` and loop under Restart=always.
    const exe = "/home/michael/.opensession/bin/opensession";
    expect(runnerSystemdUnit("", exe)).toContain(
      `ExecStart=${exe} runner run\n`,
    );
    expect(runnerLaunchdPlist("", exe)).toContain(
      `<array><string>${exe}</string><string>runner</string><string>run</string></array>`,
    );
    const xml = runnerScheduledTaskXml(
      "",
      "C:\\Users\\o'brien\\.opensession\\bin\\opensession.exe",
      "OFFICE\\owner",
    );
    expect(xml).toContain(
      "&amp; 'C:\\Users\\o''brien\\.opensession\\bin\\opensession.exe' runner run *&gt;&gt;",
    );
    for (const rendered of [
      runnerSystemdUnit("", exe),
      runnerLaunchdPlist("", exe),
      xml,
    ])
      expect(rendered).not.toContain("$bunfs");
  });

  test("the Windows scheduled task reconnects hidden without embedding a credential", () => {
    const xml = runnerScheduledTaskXml(
      "C:\\Users\\o'brien\\.opensession\\src\\scripts\\cli.ts",
      "C:\\Users\\o'brien\\.bun\\bin\\bun.exe",
      "OFFICE\\owner",
      undefined,
      scheduledTaskStartBoundary(new Date(2026, 8, 14, 15, 3, 46)),
    );
    expect(xml).toContain("runner run");
    expect(xml).toContain("-WindowStyle Hidden");
    expect(xml).toContain("$env:OPENSESSION_RUNNER_SUPERVISED = '1';");
    expect(xml).toContain("<UserId>OFFICE\\owner</UserId>");
    expect(xml).toContain("<RestartOnFailure>");
    // Supervision: a repeating time trigger relaunches a dead Runner, and the
    // boundary is local wall-clock time without an offset, as schtasks wants.
    expect(xml).toContain("<StartBoundary>2026-09-14T15:03:46</StartBoundary>");
    expect(xml).toContain("<Interval>PT5M</Interval>");
    expect(xml).toContain(
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    );
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    // A quote in the profile path must not break the PowerShell action.
    expect(xml).toContain("o''brien");
    expect(xml).not.toContain("runner.json");
  });

  test("a PATH missing System32 is repaired for child processes", () => {
    const repaired = repairWindowsPath(
      "C:\\Users\\o\\.bun\\bin",
      "C:\\Windows",
    );
    expect(repaired).toBe(
      "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32\\Wbem;C:\\Users\\o\\.bun\\bin",
    );
    // An empty PATH is the worst case and still has to come out usable.
    expect(
      repairWindowsPath("", "C:\\Windows").startsWith("C:\\Windows\\System32;"),
    ).toBe(true);
  });

  test("a healthy PATH is left exactly as it was, whatever its casing or trailing slashes", () => {
    const healthy =
      "C:\\WINDOWS\\system32\\;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32\\Wbem;C:\\tools";
    expect(repairWindowsPath(healthy, "C:\\Windows")).toBe(healthy);
  });

  test("the Windows runner environment repairs PATH under whatever spelling it arrives in", () => {
    const env = windowsRunnerEnvironment({
      Path: "C:\\nope",
      SystemRoot: "D:\\Win",
    });
    expect(env.Path).toBe(
      "D:\\Win\\System32;D:\\Win\\System32\\WindowsPowerShell\\v1.0;D:\\Win\\System32\\Wbem;C:\\nope",
    );
    expect(env.PATH).toBeUndefined();
    // No PATH at all in the parent still yields a working one.
    expect(
      windowsRunnerEnvironment({ SystemRoot: "C:\\Windows" }).Path,
    ).toContain("C:\\Windows\\System32");
  });

  test("the Windows runner environment keeps system essentials and drops secrets", () => {
    const env = windowsRunnerEnvironment({
      Path: "C:\\Windows\\system32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\o",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      HOME: "/home/x",
    });
    expect(env.Path).toContain("C:\\Windows\\system32");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });

  test("System32 binaries resolve from SystemRoot rather than PATH", () => {
    expect(windowsSystem32("schtasks.exe", "C:\\Windows")).toBe(
      "C:\\Windows\\System32\\schtasks.exe",
    );
    expect(windowsSystem32("schtasks.exe", "D:\\Win\\")).toBe(
      "D:\\Win\\System32\\schtasks.exe",
    );
    expect(windowsPowerShellPath("C:\\Windows")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  test("the shell prefers the known path, then pwsh, then the bare name", () => {
    const qualified = windowsPowerShellPath("C:\\Windows");
    // PATH is empty in all three cases: the known path is what saves it.
    expect(
      resolveWindowsShell({
        systemRoot: "C:\\Windows",
        exists: (p) => p === qualified,
        which: () => null,
      }),
    ).toBe(qualified);
    expect(
      resolveWindowsShell({
        systemRoot: "C:\\Windows",
        exists: () => false,
        which: (b) => (b === "pwsh.exe" ? "C:\\PS\\pwsh.exe" : null),
      }),
    ).toBe("C:\\PS\\pwsh.exe");
    // Last resort keeps today's behaviour rather than failing outright.
    expect(
      resolveWindowsShell({
        systemRoot: "C:\\Windows",
        exists: () => false,
        which: () => null,
      }),
    ).toBe("powershell.exe");
  });

  test("schtasks resolves off SystemRoot, and says nothing was found rather than guessing", () => {
    const qualified = windowsSystem32("schtasks.exe", "C:\\Windows");
    expect(
      resolveWindowsSchtasks({
        systemRoot: "C:\\Windows",
        exists: (p) => p === qualified,
        which: () => null,
      }),
    ).toBe(qualified);
    expect(
      resolveWindowsSchtasks({
        systemRoot: "C:\\Windows",
        exists: () => false,
        which: (b) => (b === "schtasks.exe" ? "C:\\alt\\schtasks.exe" : null),
      }),
    ).toBe("C:\\alt\\schtasks.exe");
    expect(
      resolveWindowsSchtasks({
        systemRoot: "C:\\Windows",
        exists: () => false,
        which: () => null,
      }),
    ).toBeUndefined();
  });

  test("the exec command is PowerShell on Windows and bash everywhere else", () => {
    expect(runnerExecCommand("echo hi", "linux")).toEqual([
      "bash",
      "-lc",
      "echo hi",
    ]);
    const windows = runnerExecCommand("echo hi", "win32");
    expect(windows.slice(1)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "echo hi",
    ]);
    expect(windows[0].toLowerCase()).toMatch(
      /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/,
    );
  });

  test("the scheduled task names a fully qualified PowerShell, never a bare one", () => {
    const xml = runnerScheduledTaskXml(
      "C:\\cli.ts",
      "C:\\bun.exe",
      "OFFICE\\owner",
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(xml).toContain(
      "<Command>D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>",
    );
    expect(xml).not.toContain("<Command>powershell.exe</Command>");
  });

  test("keeps Runner Portal metadata and ports in the shared workspace registry", () => {
    const record = {
      name: "api",
      key: "ignored",
      command: "bun run dev",
      port: 4300,
      state: "awake" as const,
    };
    const text = serializeRunnerPortalRegistry(
      "WEBAPP_PORT=3000\n# retain this\n",
      [record],
    );
    expect(text).toContain("WEBAPP_PORT=3000");
    expect(text).toContain("PORTAL_API_PORT=4300");
    expect(parseRunnerPortalRegistry(text)).toEqual([
      { ...record, key: "PORTAL_API_PORT" },
    ]);
  });
});

describe("Runner command AWS environment", () => {
  test("is absent on ordinary commands and rejects malformed credentials", () => {
    expect(runnerCommandAwsEnvironment(undefined)).toEqual({});
    for (const input of [
      null,
      false,
      "secret",
      {},
      { AWS_ACCESS_KEY_ID: "key" },
    ])
      expect(() => runnerCommandAwsEnvironment(input)).toThrow();
  });
  test("only accepts AWS credentials and does not mutate the process environment", () => {
    const before = { ...process.env };
    const credentials = {
      AWS_ACCESS_KEY_ID: "key",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "eu-west-1",
      AWS_DEFAULT_REGION: "eu-west-1",
    };
    expect(
      runnerCommandAwsEnvironment({
        ...credentials,
        PATH: "/evil",
        NODE_OPTIONS: "--require evil",
        AWS_PROFILE: "personal",
      }),
    ).toEqual({ ...credentials, AWS_EC2_METADATA_DISABLED: "true" });
    expect(process.env).toEqual(before);
  });
});
