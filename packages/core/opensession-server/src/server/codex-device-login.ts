/**
 * Browser-free ChatGPT sign-in for the Codex account pool.
 *
 * Wraps `codex login --device-auth` (device-code OAuth, codex-cli >= 0.139):
 * we spawn it with CODEX_HOME pointed at a fresh ~/.codex-accounts/<name>
 * directory, parse the verification URL + one-time code from its output, and
 * surface them to the Models settings UI. The user completes the sign-in on
 * any device; when the CLI exits with an auth.json in place, the directory is
 * registered as a "home"-kind pool account via addCodexAccount — after which
 * refresh stays CLI-managed exactly like a VPS-side login (see
 * pi-openai-auth.ts for why the CLI must own the refresh-token family).
 *
 * Live login attempts are parked on globalThis so hot reloads don't orphan
 * the child process or lose the URL/code mid-flow.
 */

import { homeDir } from "./paths";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import {
  addCodexAccount,
  listCodexAccounts,
  type CodexAccountPublic,
} from "./codex-accounts";

const HOME = homeDir();
const ACCOUNTS_DIR = `${HOME}/.codex-accounts`;
// The device code expires in 15 minutes; give the CLI a minute of grace.
const LOGIN_TIMEOUT_MS = 16 * 60 * 1000;
// Prune finished attempts (the UI has long stopped polling by then).
const RETENTION_MS = 60 * 60 * 1000;

export type DeviceLoginState =
  | "starting"
  | "awaiting_code"
  | "done"
  | "error"
  | "cancelled";

interface DeviceLogin {
  id: string;
  name: string;
  owner?: string;
  dir: string;
  state: DeviceLoginState;
  url?: string;
  code?: string;
  error?: string;
  account?: CodexAccountPublic;
  output: string;
  proc: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  finishedAt?: number;
}

export interface DeviceLoginPublic {
  id: string;
  name: string;
  state: DeviceLoginState;
  url?: string;
  code?: string;
  error?: string;
  account?: CodexAccountPublic;
}

const logins: Map<string, DeviceLogin> = ((
  globalThis as any
).__codexDeviceLogins ??= new Map());

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function toPublic(l: DeviceLogin): DeviceLoginPublic {
  // Only include set fields — callers (and the route's error check) use
  // `"error" in result` semantics, so an ever-present undefined key is a trap.
  return {
    id: l.id,
    name: l.name,
    state: l.state,
    ...(l.url ? { url: l.url } : {}),
    ...(l.code ? { code: l.code } : {}),
    ...(l.error ? { error: l.error } : {}),
    ...(l.account ? { account: l.account } : {}),
  };
}

function finish(l: DeviceLogin, state: DeviceLoginState, error?: string): void {
  if (l.state === "done" || l.state === "error" || l.state === "cancelled")
    return;
  l.state = state;
  if (error) l.error = error;
  l.finishedAt = Date.now();
  if (l.timer) {
    clearTimeout(l.timer);
    l.timer = null;
  }
  if (l.proc && l.proc.exitCode === null) {
    try {
      l.proc.kill("SIGTERM");
    } catch {}
  }
  l.proc = null;
}

function prune(): void {
  const now = Date.now();
  for (const [id, l] of logins) {
    if (l.finishedAt && now - l.finishedAt > RETENTION_MS) logins.delete(id);
  }
}

/**
 * Kick off `codex login --device-auth` for a new pool account. Returns fast;
 * the caller polls getDeviceLogin until the URL + code appear, then until the
 * flow completes. One in-flight attempt per account name.
 */
export function startDeviceLogin(
  name = "",
  owner?: string,
): DeviceLoginPublic | { error: string } {
  prune();
  const loginId = crypto.randomUUID();
  // A subscription needs no user-authored label. The temporary value only
  // names its login directory; addCodexAccount replaces it with the email from
  // auth.json once sign-in completes. Keep accepting a name for older clients.
  const trimmed = name.trim() || `chatgpt-${loginId.slice(0, 8)}`;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return { error: "Name must contain letters or digits" };
  if (listCodexAccounts().some((a) => a.name === trimmed)) {
    return { error: `An account named "${trimmed}" already exists` };
  }
  for (const l of logins.values()) {
    if (
      l.name === trimmed &&
      (l.state === "starting" || l.state === "awaiting_code")
    ) {
      return toPublic(l); // already in flight — hand back the same attempt
    }
  }
  const dir = `${ACCOUNTS_DIR}/${slug}`;
  if (existsSync(`${dir}/auth.json`)) {
    return {
      error: `${dir} already holds a login — register it directly as a CODEX_HOME account instead.`,
    };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    return { error: `Could not create ${dir}: ${e?.message || e}` };
  }

  const l: DeviceLogin = {
    id: loginId,
    name: trimmed,
    ...(owner?.trim() ? { owner: owner.trim() } : {}),
    dir,
    state: "starting",
    output: "",
    proc: null,
    timer: null,
    createdAt: Date.now(),
  };
  logins.set(l.id, l);

  // The installer adds Codex by default, but CLI installs are best-effort and
  // can be opted out of. Keep a missing binary actionable rather than surfacing
  // ENOENT from spawn.
  if (!Bun.which("codex")) {
    finish(
      l,
      "error",
      "The codex CLI is not installed. Run `curl -fsSL https://chatgpt.com/codex/install.sh | sh` on the server, then try again.",
    );
    return toPublic(l);
  }

  let proc: ChildProcess;
  try {
    proc = spawn("codex", ["login", "--device-auth"], {
      env: {
        HOME,
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        CODEX_HOME: dir,
        NODE_ENV: process.env.NODE_ENV || "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    finish(l, "error", `Failed to spawn codex: ${e?.message || e}`);
    return toPublic(l);
  }
  l.proc = proc;
  l.timer = setTimeout(
    () => finish(l, "error", "Device code expired (15 min) — start again."),
    LOGIN_TIMEOUT_MS,
  );

  const onChunk = (chunk: Buffer) => {
    l.output += chunk.toString();
    if (l.output.length > 20_000) l.output = l.output.slice(-20_000);
    const clean = stripAnsi(l.output);
    if (!l.url) l.url = clean.match(/https:\/\/\S*auth\.openai\.com\S*/)?.[0];
    if (!l.code) {
      // One-time code on its own line, e.g. "   MJTZ-DGQK8"
      l.code = clean.match(/^\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\s*$/m)?.[1];
    }
    if (l.url && l.code && l.state === "starting") l.state = "awaiting_code";
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);

  proc.on("error", (e) =>
    finish(l, "error", `codex login failed to run: ${e.message}`),
  );
  proc.on("exit", (exitCode) => {
    if (l.state === "cancelled") return;
    if (existsSync(`${dir}/auth.json`)) {
      const result = addCodexAccount(l.name, "home", dir, l.owner);
      if ("error" in result) {
        finish(
          l,
          "error",
          `Signed in, but registering failed: ${result.error}`,
        );
      } else {
        l.account = result;
        finish(l, "done");
        console.log(
          `[codex-device-login] ${l.name} signed in and registered (${dir})`,
        );
      }
    } else {
      const tail = stripAnsi(l.output).trim().split("\n").slice(-4).join("\n");
      finish(
        l,
        "error",
        `Sign-in did not complete (codex exited ${exitCode ?? "?"}).${tail ? `\n${tail}` : ""}`,
      );
    }
  });

  return toPublic(l);
}

export function getDeviceLogin(id: string): DeviceLoginPublic | null {
  const l = logins.get(id);
  return l ? toPublic(l) : null;
}

export function cancelDeviceLogin(id: string): boolean {
  const l = logins.get(id);
  if (!l) return false;
  finish(l, "cancelled");
  return true;
}
