/**
 * "Sign in with Claude" for a subscription account, without a terminal.
 *
 * A subscription account runs on the long-lived token `claude setup-token`
 * creates. Until now a person ran that command themselves and pasted the token
 * in. This runs the same command for them: the installed Claude Code opens the
 * sign-in in a browser on this machine, or the person opens the link it prints
 * and pastes back the code Claude shows. When the command prints the token,
 * the account is added exactly as a pasted one would be (addAccount).
 *
 * The command draws a terminal interface and prints nothing without one, so it
 * runs under a pseudo-terminal and its output is read as text. It gets its own
 * empty config directory: creating a token changes no existing Claude Code
 * login, and this keeps the first-run prompts of a real one out of the way.
 *
 * Attempts are parked on globalThis so a hot reload mid-flow does not orphan
 * the process. The token is never part of what a caller can read.
 */

import { mkdir, rm } from "fs/promises";
import { configuredPaths } from "./config";
import { homeDir, stateDir } from "./paths";
import {
  addAccount,
  listAccountsPublic,
  type ClaudeAccountPublic,
} from "./claude-accounts";

// Sign-in pages time out on their own; this only bounds a forgotten attempt.
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
// Prune finished attempts (the UI has long stopped polling by then).
const RETENTION_MS = 60 * 60 * 1000;
const OUTPUT_MAX = 200_000;
// Wide enough that neither the sign-in link nor the token is wrapped.
const TERMINAL_COLS = 2000;

export type ClaudeTokenLoginState =
  | "starting"
  | "awaiting_sign_in"
  | "done"
  | "error"
  | "cancelled";

interface Terminal {
  write(data: string): unknown;
  close(): void;
}

interface TokenLogin {
  id: string;
  name: string;
  owner?: string;
  dir: string;
  state: ClaudeTokenLoginState;
  url?: string;
  error?: string;
  account?: ClaudeAccountPublic;
  /** The token was read and the account is being added. */
  adding: boolean;
  add: typeof addAccount;
  output: string;
  proc: { kill(signal?: number | NodeJS.Signals): void } | null;
  terminal: Terminal | null;
  timer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  finishedAt?: number;
}

export interface ClaudeTokenLoginPublic {
  id: string;
  name: string;
  state: ClaudeTokenLoginState;
  url?: string;
  error?: string;
  account?: ClaudeAccountPublic;
}

const logins: Map<string, TokenLogin> = ((
  globalThis as any
).__claudeTokenLogins ??= new Map());

/** Terminal output as the text a person would read: no colors, cursor moves
 * or window-title sequences, and a carriage return starts a new line. */
export function readableTerminalText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n");
}

/** The sign-in link `claude setup-token` prints for a browser elsewhere. */
export function signInUrlIn(text: string): string | undefined {
  const url = text.match(/https:\/\/\S+\/oauth\/authorize\?\S+/)?.[0];
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/.test(
      parsed.hostname,
    )
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** The token it prints once the sign-in is approved. */
export function setupTokenIn(text: string): string | undefined {
  return text.match(/sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/)?.[0];
}

function toPublic(l: TokenLogin): ClaudeTokenLoginPublic {
  // Only set fields, so `"error" in result` means what it says.
  return {
    id: l.id,
    name: l.name,
    state: l.state,
    ...(l.url ? { url: l.url } : {}),
    ...(l.error ? { error: l.error } : {}),
    ...(l.account ? { account: l.account } : {}),
  };
}

function finished(l: TokenLogin): boolean {
  return l.state === "done" || l.state === "error" || l.state === "cancelled";
}

function finish(
  l: TokenLogin,
  state: ClaudeTokenLoginState,
  error?: string,
): void {
  if (finished(l)) return;
  l.state = state;
  if (error) l.error = error;
  l.finishedAt = Date.now();
  // What the command printed may hold the token.
  l.output = "";
  if (l.timer) clearTimeout(l.timer);
  l.timer = null;
  try {
    l.proc?.kill("SIGTERM");
  } catch {}
  try {
    l.terminal?.close();
  } catch {}
  l.proc = null;
  l.terminal = null;
  void rm(l.dir, { recursive: true, force: true }).catch(() => {});
}

function prune(): void {
  const now = Date.now();
  for (const [id, l] of logins) {
    if (l.finishedAt && now - l.finishedAt > RETENTION_MS) logins.delete(id);
  }
}

async function onOutput(l: TokenLogin, chunk: string): Promise<void> {
  if (finished(l) || l.adding) return;
  l.output = (l.output + chunk).slice(-OUTPUT_MAX);
  const text = readableTerminalText(l.output);
  if (!l.url) l.url = signInUrlIn(text);
  if (l.url && l.state === "starting") l.state = "awaiting_sign_in";
  const token = setupTokenIn(text);
  if (!token) {
    // A refused code or a declined sign-in. The command offers to retry in
    // its terminal; here the person starts again from the form.
    const refused = text.match(/OAuth error: ([^\n]+)/)?.[1]?.trim();
    if (refused) finish(l, "error", refused);
    return;
  }
  // One registration, however many more chunks arrive.
  l.adding = true;
  l.output = "";
  const result = await l.add(l.name, token, l.owner);
  if (finished(l)) return;
  if ("error" in result) {
    finish(
      l,
      "error",
      `Signed in, but adding the account failed: ${result.error}`,
    );
    return;
  }
  l.account = result;
  finish(l, "done");
  console.log(`[claude-token-login] ${l.name} signed in and added`);
}

/**
 * Start `claude setup-token` for a new account. Returns fast; the caller polls
 * getClaudeTokenLogin until the link appears and then until it finishes. One
 * attempt at a time per account name.
 */
export async function startClaudeTokenLogin(
  name: string,
  owner?: string,
  // Test seams; production runs the configured Claude Code.
  {
    executable,
    add = addAccount,
  }: { executable?: string; add?: typeof addAccount } = {},
): Promise<ClaudeTokenLoginPublic | { error: string }> {
  prune();
  const trimmed = name.trim();
  if (!trimmed) return { error: "Name is required" };
  if (listAccountsPublic().some((a) => a.name === trimmed))
    return { error: `An account named "${trimmed}" already exists` };
  for (const l of logins.values()) {
    if (l.name === trimmed && !finished(l)) return toPublic(l);
  }

  const id = crypto.randomUUID();
  const dir = `${stateDir("claude-token-login")}/${id}`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    return { error: `Could not create ${dir}: ${e?.message || e}` };
  }
  const l: TokenLogin = {
    id,
    name: trimmed,
    ...(owner?.trim() ? { owner: owner.trim() } : {}),
    dir,
    state: "starting",
    adding: false,
    add,
    output: "",
    proc: null,
    terminal: null,
    timer: null,
    createdAt: Date.now(),
  };
  logins.set(id, l);

  const decoder = new TextDecoder();
  try {
    const claude = executable ?? configuredPaths().claudeBin;
    const proc = Bun.spawn([claude, "setup-token"], {
      cwd: dir,
      env: {
        HOME: homeDir(),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        TERM: "xterm-256color",
        CLAUDE_CONFIG_DIR: dir,
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        // Without a display the command cannot open a browser itself; the
        // link it prints is then the way in.
        ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        ...(process.env.WAYLAND_DISPLAY
          ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }
          : {}),
      },
      terminal: {
        cols: TERMINAL_COLS,
        rows: 50,
        data: (_terminal: unknown, data: Uint8Array) =>
          void onOutput(l, decoder.decode(data, { stream: true })),
      },
    });
    l.proc = proc;
    l.terminal = (proc as unknown as { terminal: Terminal }).terminal;
    void proc.exited.then(async (code) => {
      // The last of its output can land just after the exit.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (l.adding || finished(l)) return;
      const tail = readableTerminalText(l.output)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join("\n");
      finish(
        l,
        "error",
        `Sign-in did not complete (claude exited ${code ?? "?"}).${tail ? `\n${tail}` : ""}`,
      );
    });
  } catch (e: any) {
    finish(
      l,
      "error",
      /ENOENT|not found/i.test(String(e?.message || e))
        ? "Claude Code is not installed on the server."
        : `Could not start Claude Code: ${e?.message || e}`,
    );
    return toPublic(l);
  }
  l.timer = setTimeout(
    () => finish(l, "error", "The sign-in timed out. Start again."),
    LOGIN_TIMEOUT_MS,
  );
  return toPublic(l);
}

export function getClaudeTokenLogin(id: string): ClaudeTokenLoginPublic | null {
  const l = logins.get(id);
  return l ? toPublic(l) : null;
}

/** Hand the command the code Claude showed after a sign-in in a browser on
 * another device. */
export function submitClaudeTokenLoginCode(
  id: string,
  code: string,
): ClaudeTokenLoginPublic | { error: string } | null {
  const l = logins.get(id);
  if (!l) return null;
  const trimmed = code.replace(/\s+/g, "");
  if (!trimmed) return { error: "code is required" };
  if (l.state !== "awaiting_sign_in" || !l.terminal)
    return { error: "This sign-in is no longer waiting for a code." };
  l.terminal.write(`${trimmed}\r`);
  return toPublic(l);
}

export function cancelClaudeTokenLogin(id: string): boolean {
  const l = logins.get(id);
  if (!l) return false;
  finish(l, "cancelled");
  return true;
}
