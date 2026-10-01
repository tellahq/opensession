import { afterEach, describe, expect, test } from "bun:test";
import {
  __setWorkloadScopingForTest,
  controlPlaneResidents,
  workloadArgv,
  workloadCommand,
  workloadUnitName,
} from "./workload-scope";

afterEach(() => __setWorkloadScopingForTest(null));

describe("workload scope", () => {
  test("outside the control plane the command is unchanged", () => {
    __setWorkloadScopingForTest(false);
    expect(workloadArgv(["claude", "--print"], "bridge")).toEqual([
      "claude",
      "--print",
    ]);
    expect(workloadCommand("mcp-server", ["--stdio"], "mcp")).toEqual({
      command: "mcp-server",
      args: ["--stdio"],
    });
  });

  test("in the control plane the command runs in its own user scope", () => {
    __setWorkloadScopingForTest(true);
    const argv = workloadArgv(["sh", "-c", "exec app"], "app");
    const separator = argv.indexOf("--");
    // The command itself is untouched after the separator, so the scope
    // execs it in place: same pid, stdio, cwd and signals.
    expect(argv.slice(separator + 1)).toEqual(["sh", "-c", "exec app"]);
    expect(argv[0]).toBe("/usr/bin/env");
    expect(argv[1]).toStartWith("XDG_RUNTIME_DIR=");
    expect(argv).toContain("--scope");
    expect(argv).toContain("--slice=opensession-agents.slice");
    expect(
      argv.find((arg) => arg.startsWith("--unit=opensession-app-")),
    ).toBeTruthy();
  });

  test("unit names are unique and systemd-safe", () => {
    const a = workloadUnitName("Keychain Run!");
    const b = workloadUnitName("Keychain Run!");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^opensession-[a-z0-9-]+-[0-9a-f]{16}$/);
  });

  test("residents are only reported from inside the control plane", async () => {
    // Test processes never run in opensession-control.slice.
    expect(await controlPlaneResidents()).toBeNull();
  });
});
