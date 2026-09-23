import { describe, expect, test } from "bun:test";
import {
  remoteGuestOsForProvider,
  remoteLayout,
  remoteLayoutForProvider,
  remoteWarmWorkspaceDir,
  REMOTE_HOME,
} from "./bootstrap";

describe("remote guest layout", () => {
  test("linux keeps the legacy /home/ubuntu paths byte for byte", () => {
    const L = remoteLayout("linux");
    expect(L.home).toBe(REMOTE_HOME);
    expect(L.bun).toBe("/home/ubuntu/.bun/bin/bun");
    expect(L.path.startsWith("/home/ubuntu/.bun/bin:")).toBe(true);
    expect(L.sessionScratchRoot).toBe(
      "/home/ubuntu/.opensession/session-scratch",
    );
    expect(remoteLayout()).toBe(L);
  });

  test("darwin lives under the image's admin user with Homebrew on the PATH", () => {
    const L = remoteLayout("darwin");
    expect(L.home).toBe("/Users/admin");
    expect(L.bun).toBe("/Users/admin/.bun/bin/bun");
    expect(L.path).toContain("/opt/homebrew/bin");
    expect(L.lifecycleDir).toBe("/Users/admin/.opensession/lifecycle");
  });

  test("tart and use.computer guests are darwin, each under its image's user", () => {
    expect(remoteGuestOsForProvider("tart")).toBe("darwin");
    expect(remoteGuestOsForProvider("usecomputer")).toBe("darwin");
    expect(remoteGuestOsForProvider("daytona")).toBe("linux");
    expect(remoteGuestOsForProvider(undefined)).toBe("linux");
    expect(remoteLayoutForProvider("box").home).toBe("/home/ubuntu");
    expect(remoteLayoutForProvider("tart")).toBe(remoteLayout("darwin"));
    const lume = remoteLayoutForProvider("usecomputer");
    expect(lume.os).toBe("darwin");
    expect(lume.home).toBe("/Users/lume");
    expect(lume.bun).toBe("/Users/lume/.bun/bin/bun");
    expect(lume.path.startsWith("/Users/lume/.bun/bin:")).toBe(true);
    expect(lume).toBe(remoteLayout("darwin", "/Users/lume"));
    expect(remoteWarmWorkspaceDir("repo", lume)).toBe(
      "/Users/lume/.bks-warm/repo",
    );
  });

  test("warm dirs follow the layout", () => {
    expect(remoteWarmWorkspaceDir("repo")).toBe("/home/ubuntu/.bks-warm/repo");
    expect(remoteWarmWorkspaceDir("repo", "darwin")).toBe(
      "/Users/admin/.bks-warm/repo",
    );
  });
});
