import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
/** Same fallback the server side uses for its own user scopes
 *  (src/server/systemd-scopes.ts SYSTEMD_USER_RUNTIME). Kept local because
 *  scripts/lib deliberately holds its own copies of the systemd knobs. */
const UID = process.getuid?.() ?? 1000;

/**
 * Environment for a `systemd-run --user` / `systemctl --user` spawn.
 *
 * systemd addresses the user bus through XDG_RUNTIME_DIR, and a process
 * started by a systemd SYSTEM service inherits none. That is every
 * agent-driven capture, because they run from opensession.service: each of
 * these calls died on `Failed to connect to bus: No medium found`, which
 * reads as a broken browser rig rather than one missing variable, so sessions
 * kept rediscovering it and setting the variable by hand (2026-08-19). An
 * interactive shell already exports it, so this only ever fills the gap.
 */
export function systemdUserEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`,
  };
}

export function boundedCdpSystemdArgs(): string[] {
  return [
    "--property=MemoryHigh=2G",
    "--property=MemoryMax=4G",
    "--property=MemorySwapMax=512M",
    "--property=TasksMax=256",
    "--property=CPUQuota=300%",
    "--property=RuntimeMaxSec=2h",
    "--property=OOMPolicy=stop",
    "--property=KillMode=control-group",
  ];
}

export type CdpBrowserLease = {
  port: number;
  unit?: string;
  owned: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ownerName(): string {
  const raw =
    process.env.OPENSESSION_SESSION_ID ||
    process.env.OPENSESSION_RUN_KEY ||
    process.cwd();
  return createHash("sha256").update(raw).digest("hex").slice(0, 10);
}

/**
 * Use an explicitly supplied browser unchanged. Otherwise start a private,
 * resource-bounded headful browser and return a lease that must be released.
 */
export async function acquireCdpBrowser(): Promise<CdpBrowserLease> {
  if (process.env.CDP_PORT) {
    const port = Number(process.env.CDP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`invalid CDP_PORT: ${process.env.CDP_PORT}`);
    return { port, owned: false };
  }

  const nonce = `${process.pid}-${randomBytes(3).toString("hex")}`;
  const state = `/tmp/opensession-cdp-${nonce}.json`;
  const proc = Bun.spawn(
    [
      "bun",
      join(ROOT, "scripts/cdp-browser.ts"),
      "start",
      "--owner",
      ownerName(),
      "--state",
      state,
    ],
    { stdout: "pipe", stderr: "pipe", env: systemdUserEnv() },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(
      `CDP browser failed to start: ${stderr.trim() || stdout.trim()}`,
    );
  const result = JSON.parse(stdout.trim()) as { port: number; unit: string };
  return { ...result, owned: true };
}

export async function releaseCdpBrowser(lease: CdpBrowserLease): Promise<void> {
  if (!lease.owned || !lease.unit) return;
  const proc = Bun.spawn(["systemctl", "--user", "stop", lease.unit], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: systemdUserEnv(),
  });
  await proc.exited;
}

export type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<any>;

/**
 * Correlate CDP command ids on `socket` and hand back a `send`.
 *
 * A reply carrying an `error` REJECTS rather than resolving undefined. Every
 * caller here used to drop `message.error` on the floor, so a refused command
 * looked exactly like one that returned nothing. In css-rulekill that is
 * indistinguishable from "deleting this rule changed nothing", the one verdict
 * that tool exists to produce.
 *
 * `shape` keeps each script's existing contract: "result" unwraps
 * `message.result`, "envelope" hands back the whole reply.
 */
export function cdpSender(
  socket: WebSocket,
  shape: "result" | "envelope" = "result",
): CdpSend {
  let lastId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      method: string;
    }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String((event as MessageEvent).data));
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      const { code, message: text, data } = message.error;
      entry.reject(
        new Error(
          `CDP ${entry.method} failed: ${code} ${text}${data ? ` (${data})` : ""}`,
        ),
      );
      return;
    }
    entry.resolve(shape === "envelope" ? message : message.result);
  });
  // A socket that goes away mid-command would otherwise hang the script on a
  // promise nothing can settle.
  socket.addEventListener("close", () => {
    for (const entry of pending.values())
      entry.reject(
        new Error(`CDP socket closed before ${entry.method} replied`),
      );
    pending.clear();
  });
  return (method, params = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++lastId;
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
}

export async function closeCdpTarget(
  port: number,
  targetId?: string,
): Promise<void> {
  if (!targetId) return;
  await fetch(
    `http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`,
  ).catch(() => {});
}

export async function waitForFile(
  path: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}
