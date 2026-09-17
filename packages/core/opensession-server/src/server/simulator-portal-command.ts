import { simulatorStorageRoot } from "../simulator-portal/storage-root";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";

export const simulatorPortalInput = {
  appPath: z
    .string()
    .min(1)
    .max(2_048)
    .describe(
      "Workspace-relative path to an already-built iphonesimulator .app bundle, not an IPA or device build.",
    ),
  deviceType: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Installed CoreSimulator device type identifier, for example com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro. Omit to select an available iPhone.",
    ),
  runtime: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Installed iOS runtime identifier. Omit to select an available iOS runtime.",
    ),
};

async function simulatorEntryPath() {
  const entry = resolve(import.meta.dir, "../simulator-portal/main.ts");
  if (!(await stat(entry).catch(() => null))?.isFile())
    throw new Error(
      "Simulator Portals currently require a source installation of Open Session on macOS.",
    );
  return entry;
}

/** No shell and no caller-controlled device or storage path. */
export async function simulatorStorageClearCommand(workspaceDir: string) {
  return [
    process.execPath,
    await simulatorEntryPath(),
    "--storage-root",
    simulatorStorageRoot(),
    "--workspace",
    await realpath(workspaceDir),
    "--clear-storage",
    "--confirm",
  ];
}

export async function clearSimulatorPortalStorage(workspaceDir: string) {
  const argv = await simulatorStorageClearCommand(workspaceDir);
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "OPENSESSION_STATE_DIR",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Maintenance runs outside the gateway. The helper bounds native commands;
  // do not kill its storage owner mid-delete while a simctl child is still live.
  const child = Bun.spawn(argv, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0)
    throw new Error(
      stderr.trim() || stdout.trim() || "Simulator storage cleanup failed",
    );
  return stdout.trim();
}

export async function simulatorPortalCommand(
  input: z.infer<z.ZodObject<typeof simulatorPortalInput>> & {
    sessionId: string;
    workspaceDir: string;
  },
) {
  if (isAbsolute(input.appPath) || input.appPath.includes("\0"))
    throw new Error("appPath must be relative to this session's workspace.");
  const workspace = await realpath(input.workspaceDir);
  const app = await realpath(resolve(workspace, input.appPath));
  const within = relative(workspace, app);
  if (
    !within ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within)
  )
    throw new Error("The app bundle must be inside this session's workspace.");
  if (!app.endsWith(".app") || !(await stat(app)).isDirectory())
    throw new Error(
      "appPath must be an already-built simulator .app directory.",
    );
  const entry = await simulatorEntryPath();
  const name = `ios-simulator-${createHash("sha256").update(input.sessionId).digest("hex").slice(0, 12)}`;
  const args = [
    process.execPath,
    entry,
    "--session",
    input.sessionId,
    "--storage-root",
    simulatorStorageRoot(),
    "--workspace",
    workspace,
    "--app",
    within,
  ];
  if (input.deviceType) args.push("--device-type", input.deviceType);
  if (input.runtime) args.push("--runtime", input.runtime);
  return {
    name,
    command: args.map(shellQuoteWord).join(" "),
    description: "Interactive iOS simulator powered by idb",
    defaultPath: "/",
    readyTimeoutMs: 90_000,
    shutdownGraceMs: 30_000,
  };
}
