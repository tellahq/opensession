import { describe, expect, test } from "bun:test";
import {
  guestRunDir,
  remoteGuestOsForProvider,
  remoteLayout,
  remoteLayoutForProvider,
  remoteRunnerHostCommand,
  remoteWarmWorkspaceDir,
  REMOTE_HOME,
  REMOTE_REPO,
} from "./bootstrap";

describe("remote guest layout", () => {
  test("linux keeps the legacy /home/ubuntu paths byte for byte", () => {
    const L = remoteLayout("linux");
    expect(L.home).toBe(REMOTE_HOME);
    expect(L.repo).toBe(REMOTE_REPO);
    expect(L.bun).toBe("/home/ubuntu/.bun/bin/bun");
    expect(L.path.startsWith("/home/ubuntu/.bun/bin:")).toBe(true);
    expect(remoteLayout()).toBe(L);
  });

  test("darwin lives under the image's admin user with Homebrew on the PATH", () => {
    const L = remoteLayout("darwin");
    expect(L.home).toBe("/Users/admin");
    expect(L.repo).toBe("/Users/admin/projects/opensession");
    expect(L.runnerBinary).toBe("/Users/admin/.local/bin/opensession-runner");
    expect(L.path).toContain("/opt/homebrew/bin");
    expect(L.runsBase).toBe("/Users/admin/.opensession-sessions/sandbox-runs");
    expect(L.hostEntry).toContain("/Users/admin/projects/opensession/");
  });

  test("only tart guests are darwin", () => {
    expect(remoteGuestOsForProvider("tart")).toBe("darwin");
    expect(remoteGuestOsForProvider("daytona")).toBe("linux");
    expect(remoteGuestOsForProvider(undefined)).toBe("linux");
    expect(remoteLayoutForProvider("box").home).toBe("/home/ubuntu");
  });

  test("run dirs are identical on linux and remapped on darwin", () => {
    const linux = remoteLayout("linux");
    const darwin = remoteLayout("darwin");
    const hostDir = `${linux.runsBase}/sess/rh-1`;
    expect(guestRunDir(linux, hostDir)).toBe(hostDir);
    expect(guestRunDir(darwin, hostDir)).toBe(`${darwin.runsBase}/sess/rh-1`);
    expect(guestRunDir(darwin, "/elsewhere/x")).toBe("/elsewhere/x");
  });

  test("warm dirs and host commands follow the layout", () => {
    expect(remoteWarmWorkspaceDir("repo")).toBe("/home/ubuntu/.bks-warm/repo");
    expect(remoteWarmWorkspaceDir("repo", "darwin")).toBe(
      "/Users/admin/.bks-warm/repo",
    );
    const command = remoteRunnerHostCommand(
      "/spec.json",
      remoteLayout("darwin"),
    );
    expect(command).toContain("/Users/admin/.local/bin/opensession-runner");
    expect(command).toContain("/Users/admin/.bun/bin/bun run");
  });
});
