import { describe, expect, test } from "bun:test";
import {
  assertTartCapacity,
  baseSignature,
  chooseTartHost,
  DEFAULT_TART_IMAGE,
  guestRemoteArg,
  guestScript,
  launchdPlist,
  localNetworkHintFor,
  parseTartList,
  parseTartVncUrl,
  tartSettings,
  tartTemplateVmName,
  tartVmName,
} from "./tart";

describe("tart settings", () => {
  test("defaults every shape field and folds the single-host form into a host list", () => {
    const settings = tartSettings({ runner: " cubes-mac-mini " });
    expect(settings.hosts).toEqual([{ runner: "cubes-mac-mini", maxVms: 2 }]);
    expect(settings.image).toBe(DEFAULT_TART_IMAGE);
    expect(settings.cpu).toBe(4);
    expect(settings.memoryMb).toBe(6144);
    expect(tartSettings(undefined).hosts).toEqual([]);
  });

  test("honors explicit shape settings and ignores garbage", () => {
    const settings = tartSettings({
      hosts: [{ runner: "mini-1" }, { runner: "ec2-mac-1", maxVms: 1 }],
      image: "ghcr.io/example/macos:1",
      cpu: 6,
      memoryMb: 8192,
    });
    expect(settings).toEqual({
      hosts: [
        { runner: "mini-1", maxVms: 2 },
        { runner: "ec2-mac-1", maxVms: 1 },
      ],
      image: "ghcr.io/example/macos:1",
      cpu: 6,
      memoryMb: 8192,
    });
    expect(tartSettings({ cpu: -1 }).cpu).toBe(4);
  });

  test("a host list wins over the single-host fields", () => {
    expect(
      tartSettings({ runner: "old", maxVms: 1, hosts: [{ runner: "new" }] })
        .hosts,
    ).toEqual([{ runner: "new", maxVms: 2 }]);
  });
});

describe("tart placement", () => {
  const host = (runnerName: string, maxVms = 2) => ({
    runnerId: `id-${runnerName}`,
    runnerName,
    maxVms,
  });
  const vm = (name: string, running: boolean, source = "local") => ({
    name,
    source,
    running,
  });

  test("prefers the host with the most free slots, in configured order on ties", () => {
    const chosen = chooseTartHost([
      { host: host("a"), vms: [vm("sbx-1", true)] },
      { host: host("b"), vms: [] },
      { host: host("c"), vms: [] },
    ]);
    expect(chosen?.host.runnerName).toBe("b");
  });

  test("a warm template beats a freer host", () => {
    const chosen = chooseTartHost(
      [
        { host: host("a"), vms: [vm("sbx-1", true), vm("tpl-repo", false)] },
        { host: host("b"), vms: [] },
      ],
      "tpl-repo",
    );
    expect(chosen?.host.runnerName).toBe("a");
  });

  test("full hosts are skipped; stopped VMs and OCI images do not count", () => {
    const chosen = chooseTartHost([
      { host: host("a"), vms: [vm("sbx-1", true), vm("sbx-2", true)] },
      {
        host: host("b", 1),
        vms: [vm("sbx-3", false), vm("img", false, "oci")],
      },
    ]);
    expect(chosen?.host.runnerName).toBe("b");
    expect(
      chooseTartHost([{ host: host("a", 1), vms: [vm("sbx-1", true)] }]),
    ).toBeNull();
  });
});

describe("tart VM names", () => {
  test("session VMs are prefixed and filesystem-safe", () => {
    expect(tartVmName("os-01a0aa88-3742-7b7f-966c-9aa4ed7e97c6")).toBe(
      "sbx-os-01a0aa88-3742-7b7f-966c-9aa4ed7e97c6",
    );
    expect(tartVmName("weird id/with:chars")).toBe("sbx-weird-id-with-chars");
  });

  test("template VMs carry the repo and the template name", () => {
    expect(tartTemplateVmName("opensession", "opensession-repo-abc")).toBe(
      "tpl-opensession-opensession-repo-abc",
    );
  });
});

describe("tart list parsing", () => {
  test("reads names, sources, and running state across field spellings", () => {
    const vms = parseTartList(
      JSON.stringify([
        {
          Source: "OCI",
          Name: "ghcr.io/x/y:1",
          Running: false,
          State: "stopped",
        },
        { Source: "local", Name: "sbx-a", Running: true, State: "running" },
        { source: "local", name: "sbx-b", state: "stopped" },
      ]),
    );
    expect(vms).toEqual([
      { name: "ghcr.io/x/y:1", source: "oci", running: false },
      { name: "sbx-a", source: "local", running: true },
      { name: "sbx-b", source: "local", running: false },
    ]);
    expect(parseTartList("")).toEqual([]);
    expect(() => parseTartList("not json")).toThrow(/no JSON/);
  });
});

describe("tart capacity", () => {
  const vms = parseTartList(
    JSON.stringify([
      { Source: "local", Name: "sbx-a", Running: true },
      { Source: "local", Name: "sbx-b", Running: true },
      { Source: "local", Name: "sbx-c", Running: false },
      { Source: "oci", Name: "img", Running: false },
    ]),
  );

  test("refuses a third guest and names the running ones", () => {
    expect(() => assertTartCapacity(vms, "sbx-c", 2, "mini")).toThrow(
      /mini is full: 2 of 2 VMs running \(sbx-a, sbx-b\)/,
    );
  });

  test("a VM that is already running does not count against itself", () => {
    expect(() => assertTartCapacity(vms, "sbx-a", 2, "mini")).not.toThrow();
    expect(() => assertTartCapacity(vms, "sbx-c", 3, "mini")).not.toThrow();
  });
});

describe("tart guest commands", () => {
  test("guest scripts export the darwin layout, env, and cwd", () => {
    const script = guestScript("git status", {
      cwd: "/Users/admin/worktrees/x",
      env: { FOO: "a b" },
    });
    expect(script).toBe(
      "export HOME=/Users/admin PATH=/Users/admin/.bun/bin:/Users/admin/.local/bin:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin; " +
        "export FOO='a b'; cd /Users/admin/worktrees/x && git status",
    );
  });

  test("the remote argument carries the script as base64 only", () => {
    const arg = guestRemoteArg("echo 'hi' && exit 7");
    expect(arg).toMatch(
      /^'bash -c "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"'$/,
    );
    expect(arg).not.toContain("echo");
    const encoded = arg.match(/printf %s ([A-Za-z0-9+/=]+)/)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toBe(
      "echo 'hi' && exit 7",
    );
  });

  test("the base signature changes with the image", () => {
    expect(baseSignature("a")).not.toBe(baseSignature("b"));
    expect(baseSignature("a")).toContain("tart@");
  });
});

describe("tart display", () => {
  test("reads the password and port of the latest VNC line", () => {
    const log = [
      "VNC server is running at vnc://:old-word@127.0.0.1:61790",
      "Stopping VM...",
      "VNC server is running at vnc://:calm-hazard-later-chest@127.0.0.1:61792",
    ].join("\n");
    expect(parseTartVncUrl(log)).toEqual({
      port: 61792,
      password: "calm-hazard-later-chest",
    });
  });

  test("reports no display while the guest is still booting", () => {
    expect(parseTartVncUrl("")).toBeNull();
    expect(parseTartVncUrl("vnc://:pw@10.0.0.5:5900")).toBeNull();
  });
});

describe("local network hint", () => {
  test("names the recorded decision for the Runner binary", () => {
    const denied = localNetworkHintFor(
      "denied /opt/homebrew/bin/bun\n",
      "mini",
    );
    expect(denied).toContain("switched off");
    expect(denied).toContain("/opt/homebrew/bin/bun");
    expect(denied).toContain("on mini");
    expect(
      localNetworkHintFor("allowed /opt/homebrew/bin/bun", "mini"),
    ).toContain("restart the Runner service");
    expect(
      localNetworkHintFor("unset /opt/homebrew/bin/bun", "mini"),
    ).toContain("accept the");
    expect(localNetworkHintFor("", "mini")).toContain("accept the");
  });
});

describe("launchd plist", () => {
  test("runs the guest once under the Runner user's home", () => {
    const plist = launchdPlist("os-abc");
    expect(plist).toContain("<string>opensession-tart-os-abc</string>");
    expect(plist).toContain(
      "<string>$HOME/.opensession-tart/tart.app/Contents/MacOS/tart</string>",
    );
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>os-abc</string>");
    expect(plist).toContain("<key>KeepAlive</key><false/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("$HOME/.opensession-tart/vms/os-abc.log");
  });
});
