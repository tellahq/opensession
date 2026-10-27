/**
 * UseComputerProvider — macOS Sandboxes on Mac minis reserved at use.computer
 * (https://use.computer). A hosted counterpart to the Tart provider: the same
 * Apple-silicon VMs with Xcode, but the Macs, the placement, and the warm
 * pool are the service's, reached over its REST API with an account key.
 *
 * Shape (shared machinery in ./bootstrap.ts, guest layout "darwin" under the
 * image's `lume` user):
 *  - Control plane: `POST/GET/DELETE /v1/sandboxes` inside the account's
 *    active Mac reservation. Creation claims a pre-booted VM (under a second
 *    when the warm slot is free); the service places it on whichever reserved
 *    Mac has room. Two VMs run per reserved Mac.
 *  - Guest access: `/exec` (zsh over SSH inside the service, 300 s per call)
 *    and `/files`. Commands are base64-wrapped into a bash script so the
 *    service's shell never interprets them; work longer than one call runs
 *    detached in the guest and is polled.
 *  - Disk: session sandboxes hold the workspace. Sleep captures a portable
 *    snapshot (a disk delta the service restores on any of its Macs) and
 *    deletes the VM, freeing its slot; wake restores the snapshot into a fresh
 *    VM. Because the service names VMs itself, a session's sandbox id here is
 *    stable (`uc-<session>`) and the state file maps it to the current VM.
 *  - Project snapshots are service snapshots too; warm prewarms adopt as on
 *    Daytona. A prewarm is never parked (a parked VM would still hold a
 *    slot), it is adopted or destroyed.
 *  - Desktop: the agent drives it through the service's input and screenshot
 *    API (window titles still come from AppleScript over exec). A person
 *    watches and takes over through the service's VNC WebSocket, relayed on
 *    this origin to the Desktop tab (../../vm-display.ts).
 *  - Terminal tabs are local `ssh` processes whose transport is the service's
 *    SSH WebSocket proxy (./ws-stdio-proxy.ts as ProxyCommand); the guest
 *    password comes from the API and reaches ssh through SSH_ASKPASS.
 *  - Portals ride the outbound relay like every remote provider.
 *  - Capacity: a reservation of N Macs runs 2N VMs. A full reservation
 *    refuses clearly; more capacity is a bigger reservation on the service.
 */

import { launchSandboxAgent, withSandboxAgent } from "../agent-driver";
import { revokeSandboxAgent } from "../agent-channel";
import { basename, resolve } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { getRepo, worktreePathFor } from "../../worktree";
import {
  getSandboxConnection,
  sandboxProviderCredential,
  type SandboxConnectionSettings,
} from "../connections";
import type {
  ExecResult,
  PortMap,
  Sandbox,
  SandboxDesktop,
  SandboxDesktopControl,
  SandboxDesktopWindow,
  SandboxProvider,
  SandboxScreenshot,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import { macDesktopControl } from "../macos-desktop";
import { vmDisplayStreamPath } from "../../vm-display";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  listRemoteStates,
  makeRemoteSandbox,
  type RemoteSandboxOwner,
  readRemoteState,
  remoteCloneUrl,
  remoteLayout,
  removeRemoteState,
  resolveTrustPolicy,
  runResumeHook,
  setupRemoteWorkspace,
  shellQuote,
  shellQuoteWord,
  touchRemoteState,
  USE_COMPUTER_GUEST_HOME,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
  type RemoteSandboxState,
} from "./bootstrap";
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  PREWARM_KEY_LABEL,
  type PrewarmAdapter,
} from "../prewarm";
import {
  invalidateRemoteRepoTemplate,
  readRemoteRepoTemplate,
  remoteRepoTemplateName,
  sealRemoteRepoTemplate,
  writeRemoteRepoTemplate,
} from "../remote-repo-template";
import { sandboxAgentEnabled, sandboxConfig } from "../config";
import { OPENSESSION_SESSIONS_DIR } from "../../paths";
import { REPO_ROOT } from "../../run-rpc-protocol";
import { writeJsonAtomic } from "../../shared/atomic-write";

const PROVIDER = "usecomputer" as const;
export const DEFAULT_USE_COMPUTER_API_URL = "https://api.use.computer";
/** The image's user; every sandbox logs in as it, with passwordless sudo. */
export const USE_COMPUTER_GUEST_USER = "lume";
const SANDBOX_PREFIX = "uc-";
/** Guest preparation revision; bump when GUEST_PREPARATION changes. */
const GUEST_PREPARATION_REVISION = "guest-v2";
const DEFAULT_IDLE_STOP_MINUTES = 30;
/** The service caps one exec call at 300 s; longer work is polled. */
const EXEC_DIRECT_MAX_MS = 280_000;
const EXEC_POLL_MS = 3_000;
/** Creation waits on the service's own bounded capacity wait. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** Measured live: a snapshot of a fresh VM sealed in 221 s, restored in 128 s. */
const SNAPSHOT_TIMEOUT_MS = 20 * 60_000;
const API_TIMEOUT_MS = 30_000;

const L = remoteLayout("darwin", USE_COMPUTER_GUEST_HOME);

// ── Settings and client ──────────────────────────────────────────────────────

export interface UseComputerSettings {
  apiUrl: string;
  /** The Mac reservation to use when the account holds several. */
  reservation?: string;
}

export function useComputerSettings(
  raw: SandboxConnectionSettings | undefined,
): UseComputerSettings {
  const apiUrl = (raw?.apiUrl || DEFAULT_USE_COMPUTER_API_URL)
    .trim()
    .replace(/\/+$/, "");
  const reservation = raw?.reservation?.trim();
  return { apiUrl, ...(reservation ? { reservation } : {}) };
}

interface UcClient extends UseComputerSettings {
  apiKey: string;
}

function client(): UcClient {
  const apiKey = sandboxProviderCredential(PROVIDER)?.apiKey;
  if (!apiKey)
    throw new Error("use.computer workspace credentials are not configured");
  return {
    apiKey,
    ...useComputerSettings(getSandboxConnection(PROVIDER)?.settings),
  };
}

export interface UseComputerApiError extends Error {
  status?: number;
  code?: string;
}

async function ucApi<T>(
  c: UcClient,
  method: string,
  path: string,
  options: {
    body?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
    query?: Record<string, string | undefined>;
  } = {},
): Promise<T> {
  const url = new URL(`${c.apiUrl}${path}`);
  for (const [key, value] of Object.entries(options.query || {}))
    if (value) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
  });
  if (!res.ok) throw await apiError(res, method, path);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function apiError(
  res: Response,
  method: string,
  path: string,
): Promise<UseComputerApiError> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) detail = parsed.error;
  } catch {}
  const ambiguous = reservationAmbiguous(res.status, detail);
  const error = new Error(
    ambiguous
      ? AMBIGUOUS_RESERVATION_MESSAGE
      : `use.computer API ${method} ${path} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
  ) as UseComputerApiError;
  error.status = res.status;
  if (res.status === 401) error.code = "CREDENTIAL_REJECTED";
  if (ambiguous) error.code = "RESERVATION_AMBIGUOUS";
  return error;
}

/** The service cannot list an account's reservations, so when two overlap
 *  (a new Mac booked before the old one ends) it refuses to guess and only
 *  the configured reservation id can pick one. */
export const AMBIGUOUS_RESERVATION_MESSAGE =
  "This use.computer account has more than one active Mac reservation, so Open Session must be told which one to use: enter its id under Provider settings on the use.computer sandbox connection.";

export function reservationAmbiguous(status: number, detail: string): boolean {
  return status === 409 && /reservation_id required/i.test(detail);
}

function isNotFound(error: unknown): boolean {
  return (error as UseComputerApiError)?.status === 404;
}

/** A create that named a snapshot the service no longer has, or one that
 *  does not fit the reservation's VM layout. */
function snapshotUnusable(error: unknown): boolean {
  const status = (error as UseComputerApiError)?.status;
  return status === 404 || status === 409;
}

// ── Service resources ────────────────────────────────────────────────────────

interface UcSandbox {
  sandbox_id: string;
  state?: "active" | "completing";
  vm_ip?: string;
  host?: string;
  created_at?: string;
}

interface UcReservation {
  id: string;
  status: string;
  mini_count: number;
  vm_layout?: string;
  end_at: string;
  active_macos?: number;
}

async function getSandbox(c: UcClient, id: string): Promise<UcSandbox | null> {
  try {
    return await ucApi<UcSandbox>(c, "GET", `/v1/sandboxes/${id}`);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function sandboxPath(id: string, suffix = ""): string {
  return `/v1/sandboxes/${encodeURIComponent(id)}${suffix}`;
}

async function createSandbox(
  c: UcClient,
  options: { snapshot?: string; idempotencyKey: string },
): Promise<UcSandbox> {
  try {
    return await ucApi<UcSandbox>(c, "POST", "/v1/sandboxes", {
      body: {
        type: "macos",
        ...(c.reservation ? { reservation_id: c.reservation } : {}),
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      },
      timeoutMs: CREATE_TIMEOUT_MS,
      idempotencyKey: options.idempotencyKey,
    });
  } catch (error) {
    if ((error as UseComputerApiError)?.status === 503) {
      throw Object.assign(
        new Error(
          "use.computer has no free Mac VM slot in this reservation (two per reserved Mac). Wait for a session to sleep, or reserve another Mac.",
        ),
        { code: "PROVIDER_CAPACITY" },
      );
    }
    throw error;
  }
}

async function deleteSandbox(c: UcClient, id: string): Promise<void> {
  try {
    await ucApi<void>(c, "DELETE", sandboxPath(id), {
      timeoutMs: 120_000,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function createSnapshot(
  c: UcClient,
  sandboxId: string,
  version: string,
  name: string,
): Promise<void> {
  await ucApi(c, "POST", sandboxPath(sandboxId, "/snapshots"), {
    body: { name, version },
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    idempotencyKey: `snapshot-${version}`,
  });
}

async function deleteSnapshot(c: UcClient, version: string): Promise<void> {
  try {
    await ucApi<void>(
      c,
      "DELETE",
      `/v1/snapshots/${encodeURIComponent(version)}`,
      { timeoutMs: 120_000 },
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function listSnapshotVersions(c: UcClient): Promise<string[]> {
  const listed = await ucApi<{ snapshots?: Array<{ version?: string }> }>(
    c,
    "GET",
    "/v1/snapshots",
    { query: { platform: "macos" } },
  );
  return (listed.snapshots || [])
    .map((snapshot) => snapshot.version || "")
    .filter(Boolean);
}

async function activeReservation(c: UcClient): Promise<UcReservation> {
  let reservation: UcReservation;
  try {
    reservation = await ucApi<UcReservation>(c, "GET", "/v1/reservations/me", {
      query: { reservation_id: c.reservation },
    });
  } catch (error) {
    if (isNotFound(error))
      throw new Error(
        "No active Mac reservation on this use.computer account. Reserve a Mac at use.computer (24 hours minimum), then test again.",
      );
    throw error;
  }
  if (reservation.status !== "active")
    throw new Error(
      `The use.computer reservation is ${reservation.status}; sandboxes need an active one`,
    );
  return reservation;
}

// ── Naming and state ─────────────────────────────────────────────────────────

/** A session's stable sandbox id here; the state file maps it to the VM the
 *  service currently holds for it (`remoteId`). */
export function useComputerSandboxId(sessionId: string): string {
  return `${SANDBOX_PREFIX}${sessionId.replace(/[^A-Za-z0-9_.-]+/g, "-")}`;
}

export function sleepSnapshotVersion(
  sandboxId: string,
  now = Date.now(),
): string {
  return `${sandboxId}-sleep-${now.toString(36)}`;
}

function guestCwd(branch: string, repoId: string): string {
  return `${L.home}/worktrees/${basename(worktreePathFor(branch, repoId, { isolated: true }))}`;
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

const q = shellQuoteWord;

/** The guest script: the runner layout's HOME and PATH, the caller's env and
 *  cwd, then the command. */
export function guestScript(cmd: string, opts?: RemoteExecOpts): string {
  const exports = Object.entries(opts?.env || {})
    .map(([key, value]) => `export ${key}=${q(value)}; `)
    .join("");
  return (
    `export HOME=${q(L.home)} PATH=${q(L.path)}; ${exports}` +
    (opts?.cwd ? `cd ${q(opts.cwd)} && ` : "") +
    cmd
  );
}

/** Carried as base64 so the service's zsh never interprets the script. */
export function guestCommand(script: string): string {
  return `bash -c "$(printf %s ${b64(script)} | base64 -d)"`;
}

interface UcExecResponse {
  stdout?: string;
  stderr?: string;
  return_code?: number;
  timed_out?: boolean;
  error?: string;
}

/** One detached command's status line: `<code>\n<b64 stdout>\n<b64 stderr>`
 *  once it finished, empty while it runs. */
export function parseDetachedExecStatus(stdout: string): ExecResult | null {
  const lines = stdout.split("\n");
  if (!lines[0]?.trim()) return null;
  const code = Number(lines[0].trim());
  const decode = (text: string | undefined) =>
    Buffer.from((text || "").trim(), "base64").toString("utf-8");
  return {
    exitCode: Number.isInteger(code) ? code : 1,
    stdout: decode(lines[1]),
    stderr: decode(lines[2]),
  };
}

// ── Driver ────────────────────────────────────────────────────────────────────

/** A session VM's driver: the Sandbox agent's socket while it is connected,
 *  the service's exec API otherwise (agent-driver.ts). Keyed by the stable
 *  Sandbox id: a wake restores onto a new VM, whose agent replaces the old. */
function sessionUseComputerDriver(
  c: UcClient,
  sandboxId: string,
  remoteId: string,
): RemoteDriver {
  return withSandboxAgent(useComputerDriver(c, remoteId), {
    providerId: PROVIDER,
    sandboxId,
    compose: guestScript,
  });
}

/** Start the VM's agent once the base runtime (bun) is installed. */
async function launchUseComputerAgent(
  c: UcClient,
  sandboxId: string,
  remoteId: string,
): Promise<boolean> {
  if (!sandboxAgentEnabled(PROVIDER)) return false;
  return launchSandboxAgent(useComputerDriver(c, remoteId), {
    providerId: PROVIDER,
    sandboxId,
  });
}

export function useComputerDriver(c: UcClient, remoteId: string): RemoteDriver {
  const exec = async (
    script: string,
    timeoutMs: number,
  ): Promise<ExecResult> => {
    if (!remoteId)
      return {
        exitCode: 1,
        stdout: "",
        stderr: "the use.computer sandbox is asleep; wake it first",
      };
    if (timeoutMs <= EXEC_DIRECT_MAX_MS) return direct(script, timeoutMs);
    return detached(script, timeoutMs);
  };
  const direct = async (
    script: string,
    timeoutMs: number,
  ): Promise<ExecResult> => {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    try {
      const res = await ucApi<UcExecResponse>(
        c,
        "POST",
        sandboxPath(remoteId, "/exec"),
        {
          body: { command: guestCommand(script), timeout: seconds },
          timeoutMs: timeoutMs + 30_000,
        },
      );
      return {
        exitCode: typeof res.return_code === "number" ? res.return_code : 1,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
      };
    } catch (error) {
      if ((error as UseComputerApiError)?.status === 504)
        return {
          exitCode: 124,
          stdout: "",
          stderr: `command timed out after ${seconds}s`,
        };
      return {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };
  // Longer than one service call: start the script detached in the guest,
  // then poll a status file until it finishes or the caller's deadline.
  const detached = async (
    script: string,
    timeoutMs: number,
  ): Promise<ExecResult> => {
    const dir = `/tmp/opensession-exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const started = await direct(
      `mkdir -p ${dir} && printf %s ${b64(script)} | base64 -d > ${dir}/cmd.sh && ` +
        `(nohup bash -c 'bash ${dir}/cmd.sh > ${dir}/out 2> ${dir}/err; echo $? > ${dir}/code' >/dev/null 2>&1 </dev/null &) && echo started`,
      60_000,
    );
    if (started.exitCode !== 0 || !started.stdout.includes("started"))
      return started;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Bun.sleep(EXEC_POLL_MS);
      const status = await direct(
        `if [ -f ${dir}/code ]; then cat ${dir}/code; base64 -i ${dir}/out | tr -d '\\n'; echo; base64 -i ${dir}/err | tr -d '\\n'; rm -rf ${dir}; fi`,
        60_000,
      );
      if (status.exitCode !== 0) return status;
      const finished = parseDetachedExecStatus(status.stdout);
      if (finished) return finished;
    }
    await direct(`pkill -f ${dir}/cmd.sh; rm -rf ${dir}`, 30_000);
    return {
      exitCode: 124,
      stdout: "",
      stderr: `command timed out after ${Math.round(timeoutMs / 1000)}s`,
    };
  };
  const driver: RemoteDriver = {
    os: "darwin",
    home: USE_COMPUTER_GUEST_HOME,
    async exec(cmd, opts) {
      return exec(guestScript(cmd, opts), opts?.timeoutMs ?? 300_000);
    },
    async execBackground(cmd, opts) {
      const r = await exec(
        guestScript(
          `nohup bash -c ${q(cmd)} >/dev/null 2>&1 </dev/null & disown; echo $!`,
          opts,
        ),
        opts?.timeoutMs ?? 60_000,
      );
      if (r.exitCode !== 0)
        throw new Error(
          `use.computer background command failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
        );
    },
    async writeFile(path, content) {
      if (!remoteId)
        throw new Error("the use.computer sandbox is asleep; wake it first");
      const url = new URL(`${c.apiUrl}${sandboxPath(remoteId, "/files")}`);
      url.searchParams.set("path", path);
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${c.apiKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from(content, "utf-8"),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok)
        throw await apiError(res, "PUT", sandboxPath(remoteId, "/files"));
    },
    async ensureStarted() {
      if (!remoteId)
        throw new Error("the use.computer sandbox is asleep; wake it first");
      const live = await getSandbox(c, remoteId);
      if (!live)
        throw new Error(`use.computer sandbox ${remoteId} no longer exists`);
      if (live.state === "completing")
        throw new Error(
          "The use.computer reservation is ending and this sandbox is being retired",
        );
    },
  };
  return driver;
}

/** Give the guest the session's canonical workspace path: macOS reserves
 *  /home for the automounter, so switch that map off and persist a synthetic
 *  link to the writable data volume. Without synthetic.conf, /home disappears
 *  when snapshot capture or restore reboots the guest. Idempotent. */
export const GUEST_PREPARATION = [
  "set -e",
  "sudo -n true",
  "sudo -n sed -i '' 's#^/home[[:space:]]#\\#&#' /etc/auto_master",
  "sudo -n automount -vc >/dev/null 2>&1 || true",
  "sudo -n mkdir -p /System/Volumes/Data/home",
  "if ! grep -Eq '^home([[:space:]]|$)' /etc/synthetic.conf 2>/dev/null; then printf 'home\\tSystem/Volumes/Data/home\\n' | sudo -n tee -a /etc/synthetic.conf >/dev/null; fi",
  // apfs.util may return a nonzero status even with the link present; the
  // final path check below determines whether preparation succeeded.
  "sudo -n /System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -t || true",
  `[ -e /System/Volumes/Data/home/ubuntu ] || sudo -n ln -s ${USE_COMPUTER_GUEST_HOME} /System/Volumes/Data/home/ubuntu`,
  "test -d /home/ubuntu/Library",
].join("\n");

const GUEST_MARKER = `${USE_COMPUTER_GUEST_HOME}/.opensession-guest`;

export async function prepareGuest(driver: RemoteDriver): Promise<void> {
  const marker = await driver.exec(
    `test -d /home/ubuntu/Library && cat ${GUEST_MARKER} 2>/dev/null`,
    { timeoutMs: 30_000 },
  );
  if (
    marker.exitCode === 0 &&
    marker.stdout.trim() === GUEST_PREPARATION_REVISION
  )
    return;
  const prep = await driver.exec(
    `${GUEST_PREPARATION}\nprintf %s ${q(GUEST_PREPARATION_REVISION)} > ${GUEST_MARKER}`,
    { timeoutMs: 120_000 },
  );
  if (prep.exitCode !== 0)
    throw new Error(
      `use.computer guest preparation failed: ${(prep.stderr || prep.stdout).trim().slice(0, 400)}`,
    );
}

// ── Desktop control ──────────────────────────────────────────────────────────

const KEY_ALIASES: Record<string, string> = {
  cmd: "command",
  meta: "command",
  super: "command",
  win: "command",
  ctrl: "control",
  opt: "alt",
  option: "alt",
  return: "enter",
  esc: "escape",
  del: "delete",
};

/** The service's key vocabulary for one of our chords (`cmd+shift+t`,
 *  `Return`, `ctrl+l`). */
export function useComputerChord(chord: string): string[] {
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("empty key chord");
  return parts.map((part) => {
    const lower = part.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    return part.length === 1 ? part : lower;
  });
}

export function useComputerDesktopControl(
  c: UcClient,
  remoteId: string,
  /** Window list with titles and geometry (AppleScript over exec); the
   *  service's own list carries only window ids. */
  listWindows?: () => Promise<SandboxDesktopWindow[]>,
): SandboxDesktopControl {
  const post = (path: string, body: unknown) =>
    ucApi<{ success?: boolean; error?: string }>(
      c,
      "POST",
      sandboxPath(remoteId, path),
      { body, timeoutMs: API_TIMEOUT_MS },
    ).then((result) => {
      if (result?.success === false)
        throw new Error(result.error || `use.computer ${path} failed`);
    });
  const display = async () => {
    const info = await ucApi<{ size?: { width?: number; height?: number } }>(
      c,
      "GET",
      sandboxPath(remoteId, "/display/info"),
    );
    if (!info.size?.width || !info.size.height)
      throw new Error("Could not read the display size");
    return { width: info.size.width, height: info.size.height };
  };
  return {
    async screenshot(options = {}) {
      const format = options.format ?? "png";
      const url = new URL(
        `${c.apiUrl}${sandboxPath(remoteId, "/screenshot/compressed")}`,
      );
      url.searchParams.set("format", format);
      url.searchParams.set("quality", "80");
      if (options.scale && options.scale > 0 && options.scale < 1)
        url.searchParams.set("scale", String(options.scale));
      const [size, res] = await Promise.all([
        display(),
        fetch(url, {
          headers: { Authorization: `Bearer ${c.apiKey}` },
          signal: AbortSignal.timeout(60_000),
        }),
      ]);
      if (!res.ok)
        throw await apiError(res, "GET", sandboxPath(remoteId, "/screenshot"));
      return {
        data: Buffer.from(await res.arrayBuffer()).toString("base64"),
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        width: size.width,
        height: size.height,
      } satisfies SandboxScreenshot;
    },
    display,
    async windows() {
      return (await listWindows?.().catch(() => [])) ?? [];
    },
    async move(x, y) {
      await post("/mouse/move", { x: Math.round(x), y: Math.round(y) });
    },
    async click(x, y, options = {}) {
      await post("/mouse/click", {
        x: Math.round(x),
        y: Math.round(y),
        button: options.button ?? "left",
        double: options.double ?? false,
      });
    },
    async drag(from, to, options = {}) {
      await post("/mouse/drag", {
        from_x: from.x,
        from_y: from.y,
        to_x: to.x,
        to_y: to.y,
        button: options.button ?? "left",
      });
    },
    async scroll(x, y, direction, amount = 3) {
      await post("/mouse/scroll", {
        x: Math.round(x),
        y: Math.round(y),
        direction,
        amount,
      });
    },
    async type(text) {
      if (text) await post("/keyboard/type", { text });
    },
    async key(chord) {
      const keys = useComputerChord(chord);
      if (keys.length === 1) await post("/keyboard/press", { key: keys[0] });
      else await post("/keyboard/hotkey", { keys: keys.join("+") });
    },
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

async function sandboxStatus(
  c: UcClient,
  state: RemoteSandboxState | null,
): Promise<SandboxStatus> {
  if (!state) return "gone";
  if (state.remoteId) {
    const live = await getSandbox(c, state.remoteId);
    if (live?.state === "active") return "running";
    if (live) return "gone";
  }
  return state.checkpointArtifactId ? "stopped" : "gone";
}

/** Restore a sleeping sandbox's snapshot into a fresh VM. Null when the
 *  snapshot no longer exists on the service. */
async function restoreFromSleep(
  c: UcClient,
  state: RemoteSandboxState,
): Promise<string | null> {
  if (!state.checkpointArtifactId) return null;
  try {
    const restored = await createSandbox(c, {
      snapshot: state.checkpointArtifactId,
      idempotencyKey: `wake-${state.checkpointArtifactId}-${Date.now().toString(36)}`,
    });
    return restored.sandbox_id;
  } catch (error) {
    if (!snapshotUnusable(error)) throw error;
    console.warn(
      `[sandbox:usecomputer] sleep snapshot ${state.checkpointArtifactId} of ${state.sandboxId} is unusable:`,
      error,
    );
    return null;
  }
}

function forgetSleepSnapshot(c: UcClient, version: string | undefined): void {
  if (!version) return;
  void deleteSnapshot(c, version).catch((error) =>
    console.warn(
      `[sandbox:usecomputer] could not delete sleep snapshot ${version}:`,
      error,
    ),
  );
}

async function runningRemote(
  sandboxId: string,
): Promise<{ c: UcClient; state: RemoteSandboxState; remoteId: string }> {
  const state = readRemoteState(PROVIDER, sandboxId);
  if (!state) throw new Error(`Unknown use.computer sandbox ${sandboxId}`);
  const c = client();
  if (!state.remoteId || (await sandboxStatus(c, state)) !== "running")
    throw new Error("Wake the sandbox first");
  return { c, state, remoteId: state.remoteId };
}

/** Sleep: snapshot the VM, then delete it to free its slot. */
export async function pauseUseComputerSandbox(
  sandboxId: string,
): Promise<void> {
  const state = readRemoteState(PROVIDER, sandboxId);
  if (!state?.remoteId) return;
  const c = client();
  const live = await getSandbox(c, state.remoteId);
  if (!live) {
    writeRemoteState({ ...state, remoteId: undefined });
    return;
  }
  // The agent dies with this VM; a wake restores onto a new one and launches
  // a fresh agent there. Revoke first so nothing is routed to a closing
  // socket and the snapshot never holds a live agent.
  revokeSandboxAgent(sandboxId, "asleep");
  const version = sleepSnapshotVersion(sandboxId);
  await createSnapshot(
    c,
    state.remoteId,
    version,
    `opensession-sleep-${sandboxId}`,
  );
  await deleteSandbox(c, state.remoteId);
  const previous = state.checkpointArtifactId;
  writeRemoteState({
    ...state,
    remoteId: undefined,
    checkpointArtifactId: version,
    checkpointCreatedAt: new Date().toISOString(),
  });
  forgetSleepSnapshot(c, previous);
}

export class UseComputerProvider implements SandboxProvider {
  readonly id = PROVIDER;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    const startedAt = Date.now();
    const mark = (stage: string) =>
      console.log(
        `[sandbox:usecomputer] ${spec.sessionId}: ${stage} (+${Date.now() - startedAt}ms)`,
      );
    if (spec.attachedDirs?.length)
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    if (spec.trustProfile === "automation")
      throw new Error(
        "use.computer sandboxes do not enforce an outbound network policy; automations stay on Daytona",
      );
    const c = client();
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd = spec.cwd || prevState?.cwd || guestCwd(branch, repo.id);
    const sandboxId =
      prevState?.sandboxId || useComputerSandboxId(spec.sessionId);

    let remoteId: string | undefined;
    let resuming = false;
    let preparedWorkspace = false;
    let bootMode: "fresh" | "snapshot-restore" = "fresh";
    if (prevState?.remoteId) {
      const live = await getSandbox(c, prevState.remoteId);
      if (live?.state === "active") remoteId = live.sandbox_id;
    }
    if (!remoteId && prevState?.checkpointArtifactId) {
      const restored = await restoreFromSleep(c, prevState);
      if (restored) {
        remoteId = restored;
        resuming = true;
        mark("restored from the sleep snapshot");
      }
    }
    if (!remoteId) {
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        const candidate = await getSandbox(c, claim.sandboxId);
        if (candidate?.state === "active") {
          remoteId = candidate.sandbox_id;
          preparedWorkspace = true;
          forgetPrewarm(claim.sandboxId);
          console.log(
            `[sandbox:usecomputer] adopted prewarmed sandbox ${remoteId} for ${spec.sessionId}`,
          );
        } else discardClaimedPrewarm(this.id, claim.sandboxId);
      }
    }
    if (!remoteId) {
      const template = readRemoteRepoTemplate(this.id, repo.id);
      const create = (snapshot?: string) =>
        createSandbox(c, {
          snapshot,
          idempotencyKey: `create-${sandboxId}-${Date.now().toString(36)}`,
        });
      let created: UcSandbox;
      try {
        created = await create(template?.artifactId);
        if (template) {
          preparedWorkspace = true;
          bootMode = "snapshot-restore";
        }
      } catch (error) {
        if (!template || !snapshotUnusable(error)) throw error;
        invalidateRemoteRepoTemplate(this.id, repo.id);
        console.warn(
          `[sandbox:usecomputer] repo template ${template.artifactId} is unavailable; creating from the stock image`,
        );
        created = await create();
      }
      remoteId = created.sandbox_id;
      mark("sandbox created");
    }

    const state: RemoteSandboxState = {
      sandboxId,
      remoteId,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    };
    writeRemoteState(state);
    if (resuming) forgetSleepSnapshot(c, prevState?.checkpointArtifactId);

    const driver = useComputerDriver(c, remoteId);
    await driver.ensureStarted();
    await prepareGuest(driver);
    mark("guest ready");
    await assertDialbackReachable(driver, this.id);
    mark("dial-back verified");
    const prepareRunner = async () => {
      await bootstrapRemoteSandbox(driver, this.id);
      mark("runner ready");
      if (await launchUseComputerAgent(c, sandboxId, remoteId))
        mark("agent connected");
    };
    const prepareWorkspace = async () => {
      await setupRemoteWorkspace(
        driver,
        cwd,
        await remoteCloneUrl(repo),
        branch,
        repo.defaultBranch,
        repo.id,
        {
          sandboxId,
          provider: this.id,
          sessionId: spec.sessionId,
          repoId: repo.id,
          trustProfile: trust.trustProfile,
        },
        spec.restoreCheckpoint
          ? { restoreCheckpoint: spec.restoreCheckpoint }
          : {},
      );
      mark("workspace ready");
    };
    // A restored template or adopted prewarm already carries the runner, so
    // the two lanes can overlap; a cold guest stays sequential because the
    // repo's setup hook may need the runner's workload-identity client.
    if (preparedWorkspace)
      await Promise.all([prepareRunner(), prepareWorkspace()]);
    else {
      await prepareRunner();
      await prepareWorkspace();
    }
    if (resuming) {
      await runResumeHook(driver, this.id, sandboxId, {
        cwd,
        sessionId: spec.sessionId,
        repoId: repo.id,
        trustProfile: trust.trustProfile,
      });
      mark("resume hook ran");
    }
    writeRemoteState({ ...state, lastActivityAt: new Date().toISOString() });
    return Object.assign(
      this.makeHandle(c, sandboxId, remoteId, {
        sessionId: spec.sessionId,
        cwd,
        repoId: repo.id,
        trustProfile: trust.trustProfile,
      }),
      { wokeFromSleep: resuming, bootMode },
    );
  }

  private makeHandle(
    c: UcClient,
    sandboxId: string,
    remoteId: string,
    owner: RemoteSandboxOwner,
  ): Sandbox {
    const providerId = this.id;
    return makeRemoteSandbox({
      ...owner,
      providerId,
      sandboxId,
      driver: sessionUseComputerDriver(c, sandboxId, remoteId),
      // Guest ports are reachable only inside the service; every Portal
      // rides the outbound relay, which needs no published port.
      async ports(): Promise<PortMap> {
        return {};
      },
      status: () => sandboxStatus(c, readRemoteState(providerId, sandboxId)),
      touchActivity: () => touchRemoteState(providerId, sandboxId),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const c = client();
      if ((await sandboxStatus(c, state)) === "gone") return null;
      return this.makeHandle(c, sandboxId, state.remoteId || "", state);
    } catch (e) {
      console.warn(`[sandbox:usecomputer] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  async desktopControl(sandboxId: string): Promise<SandboxDesktopControl> {
    const { c, remoteId } = await runningRemote(sandboxId);
    const sandbox = await this.get(sandboxId);
    return useComputerDesktopControl(
      c,
      remoteId,
      sandbox
        ? () =>
            macDesktopControl((cmd, opts) => sandbox.exec(cmd, opts)).windows()
        : undefined,
    );
  }

  /** The person's view: the service's VNC stream for this VM, relayed on
   *  this origin (../../vm-display.ts). The password is the VM's, minted by
   *  the service. */
  async desktop(sandboxId: string): Promise<SandboxDesktop> {
    const { c, state, remoteId } = await runningRemote(sandboxId);
    const info = await ucApi<{ vnc_password?: string }>(
      c,
      "GET",
      sandboxPath(remoteId, "/vnc"),
    );
    if (!info.vnc_password)
      throw new Error(
        "The sandbox has not published its display yet; try again",
      );
    return {
      vnc: {
        streamPath: vmDisplayStreamPath(state.sessionId),
        password: info.vnc_password,
      },
    };
  }

  async pause(sandboxId: string): Promise<void> {
    await pauseUseComputerSandbox(sandboxId);
  }

  async resume(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const c = client();
    if (state.remoteId) {
      const live = await getSandbox(c, state.remoteId);
      if (live?.state === "active")
        return Object.assign(
          this.makeHandle(c, sandboxId, live.sandbox_id, state),
          { wokeFromSleep: false },
        );
    }
    const remoteId = await restoreFromSleep(c, state);
    if (!remoteId) return null;
    const next: RemoteSandboxState = {
      ...state,
      remoteId,
      checkpointArtifactId: undefined,
      checkpointCreatedAt: undefined,
      lastActivityAt: new Date().toISOString(),
    };
    writeRemoteState(next);
    forgetSleepSnapshot(c, state.checkpointArtifactId);
    const driver = useComputerDriver(c, remoteId);
    await driver.ensureStarted();
    await prepareGuest(driver);
    await launchUseComputerAgent(c, sandboxId, remoteId);
    await runResumeHook(driver, this.id, sandboxId, next);
    return Object.assign(this.makeHandle(c, sandboxId, remoteId, state), {
      wokeFromSleep: true,
    });
  }

  /** Deletes the VM and any sleep snapshot, and with them the workspace
   *  (documented data loss: push your work). */
  async destroy(
    sandboxId: string,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const state = readRemoteState(this.id, sandboxId);
    const c = client();
    try {
      // Prewarms and qualification sandboxes carry the service's own id.
      const remoteId = state ? state.remoteId : sandboxId;
      if (remoteId) {
        await deleteSandbox(c, remoteId);
        if (options.strict && (await getSandbox(c, remoteId)))
          throw new Error(
            `use.computer sandbox ${remoteId} still exists after deletion`,
          );
      }
      if (state?.checkpointArtifactId)
        await deleteSnapshot(c, state.checkpointArtifactId);
      forgetPrewarm(sandboxId);
      removeRemoteState(this.id, sandboxId);
    } catch (error) {
      if (options.strict) throw error;
      // A refused delete may leave a VM holding a slot. Keep the mapping and
      // let the lifecycle caller retry the retirement.
      console.warn(`[sandbox:usecomputer] destroy(${sandboxId}):`, error);
      throw error;
    }
  }
}

// ── Display and terminal transports ──────────────────────────────────────────

export function websocketUrl(apiUrl: string, path: string): string {
  const url = new URL(path, `${apiUrl}/`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

/** The service socket a viewer's display stream is bridged to. */
export async function useComputerDisplayUpstream(
  sandboxId: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const { c, remoteId } = await runningRemote(sandboxId);
  return {
    url: websocketUrl(c.apiUrl, sandboxPath(remoteId, "/vnc/ws")),
    headers: { Authorization: `Bearer ${c.apiKey}` },
  };
}

const WS_STDIO_PROXY = resolve(REPO_ROOT, "scripts/ws-stdio-proxy.ts");
const SSH_ASKPASS = resolve(REPO_ROOT, "scripts/ssh-askpass-env.sh");

export interface UseComputerTerminalTarget {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

/** The `ssh` a Terminal tab runs: its transport is the service's SSH
 *  WebSocket proxy (the ProxyCommand), its login the VM's password answered
 *  through SSH_ASKPASS. Nothing secret is in argv. */
export function useComputerTerminalArgv(input: {
  wsUrl: string;
  user: string;
  cwd: string;
  bun?: string;
}): string[] {
  const proxy = shellQuote([
    input.bun || process.execPath,
    WS_STDIO_PROXY,
    input.wsUrl,
  ]);
  return [
    "ssh",
    "-tt",
    "-o",
    `ProxyCommand=${proxy}`,
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "PreferredAuthentications=password,keyboard-interactive",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=30",
    `${input.user}@use-computer-sandbox`,
    `cd ${shellQuoteWord(input.cwd)}; exec zsh -il`,
  ];
}

/** A Terminal tab inside the guest (../../terminals.ts). A sleeping sandbox
 *  is woken, as a terminal is an interactive gesture. */
export async function useComputerTerminalTarget(
  sandboxId: string,
): Promise<UseComputerTerminalTarget> {
  let state = readRemoteState(PROVIDER, sandboxId);
  if (!state) throw new Error(`Unknown use.computer sandbox ${sandboxId}`);
  const c = client();
  if ((await sandboxStatus(c, state)) !== "running") {
    const { getSandboxProvider } = await import("../index");
    const woken = await getSandboxProvider(PROVIDER).resume?.(sandboxId);
    if (!woken) throw new Error("The use.computer sandbox could not be woken");
    state = readRemoteState(PROVIDER, sandboxId) || state;
  }
  if (!state.remoteId) throw new Error("The use.computer sandbox is asleep");
  const login = await ucApi<{
    ws_url?: string;
    ssh_user?: string;
    ssh_password?: string;
  }>(c, "GET", sandboxPath(state.remoteId, "/ssh"));
  if (!login.ws_url || !login.ssh_password)
    throw new Error("use.computer did not return an SSH login for the sandbox");
  return {
    argv: useComputerTerminalArgv({
      wsUrl: websocketUrl(c.apiUrl, login.ws_url),
      user: login.ssh_user || USE_COMPUTER_GUEST_USER,
      cwd: state.cwd,
    }),
    env: {
      OPENSESSION_WS_AUTHORIZATION: `Bearer ${c.apiKey}`,
      OPENSESSION_SSH_PASSWORD: login.ssh_password,
      SSH_ASKPASS,
      SSH_ASKPASS_REQUIRE: "force",
    },
    cwd: state.cwd,
  };
}

// ── Idle sleep ───────────────────────────────────────────────────────────────

/** The service has no idle timer that keeps the disk. Sleep session
 *  sandboxes whose last activity is older than idleStopMinutes; the next
 *  turn wakes them. */
export async function sweepIdleUseComputerSandboxes(
  now = Date.now(),
): Promise<string[]> {
  try {
    client();
  } catch {
    return [];
  }
  const idleMs =
    (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  const stale = listRemoteStates(PROVIDER).filter(
    (state) =>
      state.remoteId &&
      now - Date.parse(state.lastActivityAt || state.createdAt) > idleMs,
  );
  const slept: string[] = [];
  for (const state of stale) {
    const { hostRunBusy } = await import("../../host-registry");
    if (hostRunBusy(state.sessionId)) continue;
    try {
      await pauseUseComputerSandbox(state.sandboxId);
      slept.push(state.sandboxId);
      console.log(
        `[sandbox:usecomputer] slept idle sandbox ${state.sandboxId} (${state.sessionId})`,
      );
    } catch (error) {
      console.warn(
        `[sandbox:usecomputer] idle sleep of ${state.sandboxId} failed:`,
        error,
      );
    }
  }
  return slept;
}

const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
let idleSweep: ReturnType<typeof setInterval> | undefined;

/** Idempotent; called from boot. */
export function startUseComputerIdleSweep(): void {
  if (idleSweep) return;
  idleSweep = setInterval(() => {
    void sweepIdleUseComputerSandboxes().catch((error) =>
      console.warn("[sandbox:usecomputer] idle sweep failed:", error),
    );
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();
}

// ── Project templates + prewarm ──────────────────────────────────────────────

/** Prewarms carry no service-side label, so their pool labels live here,
 *  keyed by the service's sandbox id, for the orphan audit after a restart. */
function prewarmIndexPath(): string {
  return `${process.env.OPENSESSION_SESSIONS_DIR || OPENSESSION_SESSIONS_DIR}/sandboxes/usecomputer-prewarms.json`;
}

function readPrewarmIndex(): Record<string, Record<string, string>> {
  try {
    const path = prewarmIndexPath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writePrewarmIndex(
  index: Record<string, Record<string, string>>,
): void {
  const path = prewarmIndexPath();
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeJsonAtomic(path, index);
}

function rememberPrewarm(id: string, labels: Record<string, string>): void {
  writePrewarmIndex({ ...readPrewarmIndex(), [id]: labels });
}

function forgetPrewarm(id: string): void {
  const index = readPrewarmIndex();
  if (!(id in index)) return;
  delete index[id];
  writePrewarmIndex(index);
}

export async function deleteUseComputerTemplateArtifact(
  artifactId: string,
): Promise<void> {
  await deleteSnapshot(client(), artifactId);
}

export const useComputerPrewarmAdapter: PrewarmAdapter = {
  async create(labels) {
    const key = labels[PREWARM_KEY_LABEL] || "";
    const repoId = key.startsWith(`${PROVIDER}:`)
      ? key.slice(PROVIDER.length + 1)
      : "";
    if (!repoId)
      throw new Error(
        `invalid use.computer prewarm key: ${key || "(missing)"}`,
      );
    const c = client();
    const template = readRemoteRepoTemplate(PROVIDER, repoId);
    const create = (snapshot?: string) =>
      createSandbox(c, {
        snapshot,
        idempotencyKey: `prewarm-${repoId}-${Date.now().toString(36)}`,
      });
    let created: UcSandbox;
    let restoredFromTemplate = false;
    try {
      created = await create(template?.artifactId);
      restoredFromTemplate = Boolean(template);
    } catch (error) {
      if (!template || !snapshotUnusable(error)) throw error;
      invalidateRemoteRepoTemplate(PROVIDER, repoId);
      created = await create();
    }
    rememberPrewarm(created.sandbox_id, labels);
    const driver = useComputerDriver(c, created.sandbox_id);
    await driver.ensureStarted();
    await prepareGuest(driver);
    return { sandboxId: created.sandbox_id, driver, restoredFromTemplate };
  },

  async publishTemplate(sandboxId, repo, _label, options) {
    const c = client();
    const driver = useComputerDriver(c, sandboxId);
    await driver.ensureStarted();
    await sealRemoteRepoTemplate(driver, PROVIDER, repo);
    const version = remoteRepoTemplateName(PROVIDER, repo.id);
    const exists = (await listSnapshotVersions(c)).includes(version);
    if (exists && options?.replace) await deleteSnapshot(c, version);
    if (!exists || options?.replace)
      await createSnapshot(c, sandboxId, version, `opensession-${repo.id}`);
    writeRemoteRepoTemplate(PROVIDER, repo.id, version);
    console.log(
      `[sandbox:usecomputer] published post-setup repo template ${version}`,
    );
  },

  async destroy(sandboxId) {
    await deleteSandbox(client(), sandboxId);
    forgetPrewarm(sandboxId);
  },

  async listPrewarmed() {
    const c = client();
    const index = readPrewarmIndex();
    const out: Array<{ id: string; key: string }> = [];
    let changed = false;
    for (const [id, labels] of Object.entries(index)) {
      if (!(await getSandbox(c, id))) {
        delete index[id];
        changed = true;
        continue;
      }
      out.push({ id, key: String(labels[PREWARM_KEY_LABEL] || "") });
    }
    if (changed) writePrewarmIndex(index);
    return out;
  },
};

// ── Qualification ────────────────────────────────────────────────────────────

/** Prove the account end to end: an active reservation with a free slot,
 *  then a disposable sandbox's exec semantics, file upload, guest
 *  preparation, and a snapshot restored into a distinct sandbox (the sleep,
 *  wake, and project-snapshot mechanism). Everything created is deleted. */
export async function qualifyUseComputerConnection(
  update: (stage: string, progress?: number) => void = () => undefined,
): Promise<void> {
  try {
    await qualify(update);
  } catch (error) {
    // Surface the message itself: the generic classifier keys on words like
    // "snapshot" and would otherwise report a snapshot problem.
    const code = (error as { code?: string })?.code;
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      { code: code || "QUALIFICATION_FAILED" },
    );
  }
}

async function qualify(
  update: (stage: string, progress?: number) => void,
): Promise<void> {
  const c = client();
  update("Checking the use.computer reservation", 25);
  const reservation = await activeReservation(c);
  const platforms = await ucApi<{
    macos?: { available?: boolean; capacity?: { max: number; used: number } };
  }>(c, "GET", "/v1/platforms", {
    query: { reservation_id: c.reservation || reservation.id },
  });
  if (platforms.macos?.available === false)
    throw new Error("macOS sandboxes are not available on this reservation");
  const capacity = platforms.macos?.capacity;
  if (capacity && capacity.used >= capacity.max)
    throw Object.assign(
      new Error(
        `Every VM slot of the reservation is in use (${capacity.used}/${capacity.max}); wait for a session to sleep or reserve another Mac`,
      ),
      { code: "PROVIDER_CAPACITY" },
    );
  const ends = new Date(reservation.end_at);
  update(
    `${reservation.mini_count} Mac${reservation.mini_count === 1 ? "" : "s"} reserved until ${Number.isNaN(ends.getTime()) ? reservation.end_at : ends.toUTCString()}`,
    30,
  );
  const suffix = Bun.randomUUIDv7().slice(-10);
  const version = `opensession-qualification-${suffix}`;
  const created: string[] = [];
  let snapshotted = false;
  try {
    update("Creating a disposable sandbox", 40);
    const source = await createSandbox(c, {
      idempotencyKey: `qualify-${suffix}`,
    });
    created.push(source.sandbox_id);
    const driver = useComputerDriver(c, source.sandbox_id);
    await driver.ensureStarted();
    const probe = await driver.exec(
      "set -eu; uname -s; sudo -n true; printf opensession-qualified > ~/.opensession-qualification",
      { timeoutMs: 60_000 },
    );
    if (probe.exitCode !== 0 || !probe.stdout.includes("Darwin"))
      throw new Error(
        `use.computer sandbox command failed: ${(probe.stderr || probe.stdout).trim().slice(0, 200)}`,
      );
    const semantics = await driver.exec(
      "printf qualification-out; printf qualification-err >&2; exit 7",
      { timeoutMs: 60_000 },
    );
    if (
      semantics.exitCode !== 7 ||
      !semantics.stdout.includes("qualification-out") ||
      !semantics.stderr.includes("qualification-err")
    )
      throw new Error(
        "use.computer exec stream or exit-code semantics are incompatible",
      );
    await driver.writeFile(`${L.home}/.opensession-upload`, "uploaded");
    const upload = await driver.exec(
      `test "$(cat ~/.opensession-upload)" = uploaded`,
    );
    if (upload.exitCode !== 0)
      throw new Error("use.computer file upload check failed");
    update("Preparing the guest", 50);
    await prepareGuest(driver);
    update(
      "Checking snapshot restore (sleep, wake, and project snapshots)",
      60,
    );
    await createSnapshot(
      c,
      source.sandbox_id,
      version,
      "opensession-qualification",
    );
    snapshotted = true;
    const restored = await createSandbox(c, {
      snapshot: version,
      idempotencyKey: `qualify-restore-${suffix}`,
    });
    created.push(restored.sandbox_id);
    if (restored.sandbox_id === source.sandbox_id)
      throw new Error("use.computer snapshot restore was not distinct");
    const restoreProbe = await useComputerDriver(c, restored.sandbox_id).exec(
      'test "$(cat ~/.opensession-qualification)" = opensession-qualified && test -d /home/ubuntu/Library',
      { timeoutMs: 60_000 },
    );
    if (restoreProbe.exitCode !== 0)
      throw new Error(
        "use.computer snapshot did not restore the sandbox filesystem",
      );
    update("Cleaning up", 95);
  } finally {
    for (const id of created) {
      try {
        await deleteSandbox(c, id);
      } catch (error) {
        console.warn(
          `[sandbox:usecomputer] qualification cleanup of ${id}:`,
          error,
        );
      }
    }
    if (snapshotted) {
      try {
        await deleteSnapshot(c, version);
      } catch (error) {
        console.warn(
          `[sandbox:usecomputer] qualification snapshot cleanup of ${version}:`,
          error,
        );
      }
    }
  }
}
