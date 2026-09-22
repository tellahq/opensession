import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A release build replaces the embedded-viewer stub with a generated manifest.
// Stand one in before the command module loads so the compiled branch is the
// one under test; the unit-test runner isolates this mock to this file.
mock.module("../simulator-portal/embedded-viewer", () => ({
  EMBEDDED_SIMULATOR_VIEWER: { assets: { "/main.js": "/$bunfs/root/main.js" } },
}));

const execPath = process.execPath;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "execPath", { value: execPath });
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("a compiled binary with an embedded viewer re-execs itself with the subcommand", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "simulator-portal-test-"));
  roots.push(workspaceDir);
  await mkdir(join(workspaceDir, "Demo.app"));
  Object.defineProperty(process, "execPath", {
    value: "/opt/acme/releases/opensession-0.4.67-darwin-arm64",
    configurable: true,
    writable: true,
  });
  const { simulatorPortalCommand } = await import("./simulator-portal-command");
  const portal = await simulatorPortalCommand({
    sessionId: "session-a",
    workspaceDir,
    appPath: "Demo.app",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  });
  expect(portal.command).toBe(
    `/opt/acme/releases/opensession-0.4.67-darwin-arm64 simulator-portal --session session-a --workspace ${await realpath(workspaceDir)} --app Demo.app --device-type com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`,
  );
  expect(portal.command).not.toContain(".ts");
  expect(portal.defaultPath).toBe("/");
});
