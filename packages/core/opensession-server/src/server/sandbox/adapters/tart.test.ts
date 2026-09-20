import { describe, expect, test } from "bun:test";
import {
  assertTartCapacity,
  baseSignature,
  DEFAULT_TART_IMAGE,
  guestRemoteArg,
  guestScript,
  localNetworkHintFor,
  parseTartList,
  tartSettings,
  tartTemplateVmName,
  tartVmName,
} from "./tart";

describe("tart settings", () => {
  test("defaults every shape field and keeps the runner as given", () => {
    const settings = tartSettings({ runner: " cubes-mac-mini " });
    expect(settings.runner).toBe("cubes-mac-mini");
    expect(settings.image).toBe(DEFAULT_TART_IMAGE);
    expect(settings.cpu).toBe(4);
    expect(settings.memoryMb).toBe(6144);
    expect(settings.maxVms).toBe(2);
  });

  test("honors explicit shape settings and ignores garbage", () => {
    const settings = tartSettings({
      runner: "r1",
      image: "ghcr.io/example/macos:1",
      cpu: 6,
      memoryMb: 8192,
      maxVms: 1,
    });
    expect(settings).toEqual({
      runner: "r1",
      image: "ghcr.io/example/macos:1",
      cpu: 6,
      memoryMb: 8192,
      maxVms: 1,
    });
    expect(
      tartSettings({ cpu: -1, maxVms: "x" as unknown as number }).cpu,
    ).toBe(4);
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
      "export HOME=/Users/admin PATH=/Users/admin/.bun/bin:/Users/admin/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; " +
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
