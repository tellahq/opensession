/**
 * How a client finds and authenticates to the Claude host service
 * (src/claude-host): its WebSocket URL from pi.json and a bearer token both
 * sides read from one 0600 file.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stateDir } from "./paths";

export interface ClaudeHostEndpoint {
  url: string;
  token: string;
}

/** The shared token file. The env override lets a host that keeps its state
 *  elsewhere, or a test, name its own. */
export function claudeHostTokenPath(): string {
  return (
    process.env.OPENSESSION_CLAUDE_HOST_TOKEN_FILE ||
    stateDir("claude-host-token")
  );
}

export async function readClaudeHostToken(): Promise<string> {
  const path = claudeHostTokenPath();
  let token: string;
  try {
    token = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `The Claude host token file ${path} does not exist. Start the Claude host first.`,
      );
    throw error;
  }
  if (!token) throw new Error(`The Claude host token file ${path} is empty`);
  return token;
}

/** The host's side: reuse the token on disk, or create one on first start. */
export async function ensureClaudeHostToken(): Promise<string> {
  const path = claudeHostTokenPath();
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}
