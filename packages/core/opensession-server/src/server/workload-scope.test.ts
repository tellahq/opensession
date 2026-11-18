import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setWorkloadScopingForTest,
  controlPlaneResidents,
  removeTree,
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

  test("systemd 259 does not expand `$` in a scoped command", () => {
    __setWorkloadScopingForTest(true, 259);
    const argv = workloadArgv(["sh", "-c", "echo $$ $HOME"], "app");
    expect(argv.indexOf("--expand-environment=no")).toBeLessThan(
      argv.indexOf("--"),
    );
    expect(argv.at(-1)).toBe("echo $$ $HOME");
    __setWorkloadScopingForTest(true, 252);
    expect(workloadArgv(["true"], "app")).not.toContain(
      "--expand-environment=no",
    );
  });

  test("a caller can name the scope so a later gateway can stop it", () => {
    __setWorkloadScopingForTest(true);
    const argv = workloadArgv(["bun", "server.ts"], "app", {
      unit: "opensession-app-dep-1",
    });
    expect(argv).toContain("--unit=opensession-app-dep-1");
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

  test("removeTree deletes a whole tree off the event loop", async () => {
    __setWorkloadScopingForTest(false);
    const root = mkdtempSync(join(tmpdir(), "remove-tree-"));
    const tree = join(root, "node_modules");
    for (let i = 0; i < 50; i++) {
      mkdirSync(join(tree, `pkg-${i}`, "lib"), { recursive: true });
      writeFileSync(join(tree, `pkg-${i}`, "lib", "index.js"), "x");
    }
    await removeTree(tree);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(root)).toBe(true);
    await removeTree(root);
  });
});
