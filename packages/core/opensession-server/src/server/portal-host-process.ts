import { spawn } from "node:child_process";

/** macOS has no setsid executable. Node's detached spawn creates the same
 * session/process group, so the supervisor can reap the complete tree. */
export function portalHostCommand(
  command: string,
  platform = process.platform,
): string[] {
  return platform === "darwin"
    ? ["bash", "-lc", `exec ${command}`]
    : ["setsid", "bash", "-lc", `exec ${command}`];
}

export async function spawnPortalHost(input: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  log: number;
}): Promise<number> {
  const [executable, ...args] = input.command;
  if (!executable) throw new Error("Missing Portal executable");
  const child = spawn(executable, args, {
    cwd: input.cwd,
    env: { NODE_ENV: "production", ...input.env },
    detached: process.platform === "darwin",
    stdio: ["ignore", input.log, input.log],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  if (!child.pid) throw new Error("Portal process did not start");
  return child.pid;
}
