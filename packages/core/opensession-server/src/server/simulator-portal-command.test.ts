import { simulatorStorageRoot } from "../simulator-portal/storage-root";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  simulatorPortalCommand,
  simulatorStorageClearCommand,
} from "./simulator-portal-command";
import { portalHostCommand, spawnPortalHost } from "./portal-host-process";
import { open } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "simulator-portal-test-"));
  roots.push(root);
  await mkdir(join(root, "App's build.app"));
  return root;
}

test("storage reset uses explicit confirmation and a canonical workspace without a shell", async () => {
  const workspaceDir = await workspace();
  const argv = await simulatorStorageClearCommand(workspaceDir);
  expect(argv[0]).toBe(process.execPath);
  expect(argv[1]).toEndWith("/simulator-portal/main.ts");
  expect(argv.slice(2)).toEqual([
    "--storage-root",
    simulatorStorageRoot(),
    "--workspace",
    await realpath(workspaceDir),
    "--clear-storage",
    "--confirm",
  ]);
  expect(argv).not.toContain("--app");
  expect(argv).not.toContain("--udid");
});

test("agent command quotes paths and isolates the portal name by session", async () => {
  const workspaceDir = await workspace();
  const first = await simulatorPortalCommand({
    sessionId: "session-a",
    workspaceDir,
    appPath: "App's build.app",
  });
  const second = await simulatorPortalCommand({
    sessionId: "session-b",
    workspaceDir,
    appPath: "App's build.app",
  });
  expect(first.name).not.toBe(second.name);
  expect(first.command).toContain("'App'\\''s build.app'");
  expect(first.command).toContain("--session");
  expect(first.shutdownGraceMs).toBe(30_000);
});

test("absolute, traversing, symlink-escaped, and non-bundle app paths are refused", async () => {
  const workspaceDir = await workspace();
  const outside = await workspace();
  await symlink(
    join(outside, "App's build.app"),
    join(workspaceDir, "Escape.app"),
  );
  for (const appPath of [
    join(workspaceDir, "App's build.app"),
    "Escape.app",
    ".",
    "missing.app",
  ])
    await expect(
      simulatorPortalCommand({ sessionId: "a", workspaceDir, appPath }),
    ).rejects.toThrow();
});

test("host Portal launch does not require the Linux setsid utility on Mac", async () => {
  expect(portalHostCommand("bun server.ts", "darwin")).toEqual([
    "bash",
    "-lc",
    "exec bun server.ts",
  ]);
  expect(portalHostCommand("bun server.ts", "linux")).toEqual([
    "setsid",
    "bash",
    "-lc",
    "exec bun server.ts",
  ]);
  const root = await workspace();
  const log = await open(join(root, "process.log"), "w");
  try {
    await expect(
      spawnPortalHost({
        command: ["/definitely/not/a/command"],
        cwd: root,
        env: {},
        log: log.fd,
      }),
    ).rejects.toThrow();
    const pid = await spawnPortalHost({
      command: [process.execPath, "-e", "process.exit(0)"],
      cwd: root,
      env: {},
      log: log.fd,
    });
    expect(pid).toBeGreaterThan(1);
  } finally {
    await log.close();
  }
});

test("Mac listener discovery normalizes IPv4, IPv6 and wildcard ports without substring matches", async () => {
  const { macListenerRows, listenerLinesForPort } = await import("./preview");
  const rows = macListenerRows(
    "p12\nfcwd\nn127.0.0.1:4000\nn[::1]:4000\np13\nn*:14000\n",
  );
  expect(listenerLinesForPort(rows, 4000)).toHaveLength(2);
  expect(
    listenerLinesForPort(rows, 4000).every((line) => line.includes("pid=12")),
  ).toBe(true);
  expect(listenerLinesForPort(rows, 14000)).toHaveLength(1);
});

test("start and clear pin the same configured storage root despite host environment stripping", async () => {
  const previous = process.env.OPENSESSION_STATE_DIR;
  const workspaceDir = await workspace();
  try {
    process.env.OPENSESSION_STATE_DIR = join(workspaceDir, "instance state");
    const clear = await simulatorStorageClearCommand(workspaceDir);
    const start = await simulatorPortalCommand({
      sessionId: "a",
      workspaceDir,
      appPath: "App's build.app",
    });
    const root = join(workspaceDir, "instance state", "simulator-storage");
    expect(clear[clear.indexOf("--storage-root") + 1]).toBe(root);
    expect(start.command).toContain(`--storage-root '${root}'`);
  } finally {
    if (previous === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = previous;
  }
});
