/**
 * TartProvider — macOS Sandboxes as Tart virtual machines on a paired Mac
 * Runner (Apple silicon, Virtualization.framework). The Runner is the trusted
 * host; every session gets its own disposable VM on it.
 *
 * Shape (shared machinery in ./bootstrap.ts, guest layout "darwin"):
 *  - Control plane: `tart` on the Mac, driven through the Runner's
 *    authenticated command channel (execOnRunner). Nothing dials into the
 *    Mac; the Runner connects outbound like every Runner does.
 *  - Guest access: SSH from the Mac to the VM with a host-local key that the
 *    base image preparation installs. Commands are base64-wrapped so they
 *    survive the two shells (Runner bash, guest bash) untouched, and the
 *    Runner's audited command prefix never contains the payload.
 *  - Images: one OCI image (Cirrus Labs' macOS + Xcode image by default) is
 *    pulled once; `opensession-base` is a prepared clone of it (SSH key,
 *    sleep disabled, cliclick); session VMs are APFS clone-on-write clones
 *    of the base, so creating one takes seconds and costs no space up front.
 *  - Project snapshots are local clones too (`tpl-<repo>-<hash>`); warm
 *    prewarms adopt as on Box.
 *  - Sleep is `tart stop` (disk kept, processes gone, matching Daytona);
 *    wake is `tart run` again. Destroy is `tart delete`.
 *  - Capacity: Apple allows two macOS guests per host, and the Mac mini's
 *    memory is shared with the host. Each host's `maxVms` (default 2) is
 *    enforced before a VM starts; a full host refuses clearly instead of
 *    thrashing.
 *  - Hosts: a connection lists one or more paired Macs (Mac minis, EC2 Mac
 *    instances running the Runner client). A new VM is placed on the host
 *    with the most free slots, preferring one that already holds the repo's
 *    template; the chosen Runner id is recorded in the VM's state file so
 *    sleep, wake, desktop, and terminals return to the same Mac. Each host
 *    prepares its own base VM. More capacity is one more paired Mac.
 *  - Portals ride the same outbound relay as every remote provider (the
 *    in-guest agent dials back), so a guest-only network is enough.
 *  - Desktop: the agent drives it with the macOS control (screencapture +
 *    cliclick) over exec. A person watches and takes over through Tart's
 *    own VNC server on the Mac's loopback, relayed frame by frame over the
 *    Runner channel to the viewer in the Desktop tab (../../vm-display.ts).
 *  - Terminal tabs are Runner PTYs that SSH into the guest with the same
 *    host-local key; the Runner resolves the guest address from the VM name.
 */

import { basename, dirname } from "path";
import { getRepo, worktreePathFor } from "../../worktree";
import {
  getSandboxConnection,
  sandboxHostSettings,
  type SandboxConnectionSettings,
} from "../connections";
import type {
  ExecResult,
  PortMap,
  Sandbox,
  SandboxDesktop,
  SandboxDesktopControl,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import { macDesktopControl } from "../macos-desktop";
import type { RunnerVmTerminal } from "../../runner-ws";
import { vmDisplayStreamPath } from "../../vm-display";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  listRemoteStates,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  remoteLayout,
  removeRemoteState,
  resolveTrustPolicy,
  runResumeHook,
  setupRemoteWorkspace,
  shellQuoteWord,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  PREWARM_KEY_LABEL,
  type PrewarmAdapter,
  type SandboxMachineSettings,
} from "../prewarm";
import {
  readRemoteRepoTemplate,
  remoteRepoTemplateName,
  sealRemoteRepoTemplate,
  writeRemoteRepoTemplate,
} from "../remote-repo-template";
import { sandboxConfig } from "../config";

/** Pinned Tart release installed on the Mac host, checksum-verified. */
export const TART_VERSION = "2.37.0";
export const TART_SHA256 =
  "d531752c4dad5d4214ac7ff540cefc2647df1fca2338d413d3c01754f54b356b";
const TART_RELEASE_URL = `https://github.com/openai/tart/releases/download/${TART_VERSION}/tart.tar.gz`;
/** macOS + Xcode image. Pinned to a tag whose digest was checked live. */
export const DEFAULT_TART_IMAGE = "ghcr.io/cirruslabs/macos-tahoe-xcode:26.5";
export const TART_BASE_VM = "opensession-base";
/** Bump when the base VM preparation changes; existing bases are rebuilt. */
const BASE_PREPARATION_REVISION = "base-v3";
const VM_PREFIX = "sbx-";
const PREWARM_PREFIX = "sbx-prewarm-";
const TEMPLATE_PREFIX = "tpl-";
const GUEST_USER = "admin";
const GUEST_PASSWORD = "admin";
export const DEFAULT_TART_CPU = 4;
export const DEFAULT_TART_MEMORY_MB = 6144;
export const DEFAULT_TART_MAX_VMS = 2;
const DEFAULT_IDLE_STOP_MINUTES = 30;
const MAX_GUEST_FILE_BYTES = 512 * 1024;

// Shell fragments evaluated on the Mac host (the Runner's bash -lc).
const HOST_DIR = '"$HOME/.opensession-tart"';
const TART = '"$HOME/.opensession-tart/tart.app/Contents/MacOS/tart"';
const KEY = '"$HOME/.opensession-tart/id_ed25519"';
const HOST_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/** The Runner audits and logs the head of every command. Keep the guest
 *  payload (which may carry launch credentials) past that head. */
const AUDIT_HEAD_CHARS = 520;

const L = remoteLayout("darwin");

/** A configured Mac: which Runner, and how many guests it may run. */
export interface TartHostSpec {
  /** Runner id or name. */
  runner: string;
  maxVms: number;
}

/** A configured Mac that is paired, macOS, and connected right now. */
export interface TartHost {
  runnerId: string;
  runnerName: string;
  maxVms: number;
}

export interface TartSettings {
  hosts: TartHostSpec[];
  image: string;
  cpu: number;
  memoryMb: number;
}

export function tartSettings(
  raw: SandboxConnectionSettings | undefined = getSandboxConnection("tart")
    ?.settings,
): TartSettings {
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    hosts: sandboxHostSettings(raw).map((host) => ({
      runner: host.runner.trim(),
      maxVms: Math.round(num(host.maxVms, DEFAULT_TART_MAX_VMS)),
    })),
    image:
      typeof raw?.image === "string" && raw.image.trim()
        ? raw.image.trim()
        : DEFAULT_TART_IMAGE,
    cpu: Math.round(num(raw?.cpu, DEFAULT_TART_CPU)),
    memoryMb: Math.round(num(raw?.memoryMb, DEFAULT_TART_MEMORY_MB)),
  };
}

/** VM names are directory names under ~/.tart/vms on the host. */
export function tartVmName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+/, "");
  return `${VM_PREFIX}${safe}`.slice(0, 80);
}

export function tartTemplateVmName(
  repoId: string,
  templateName: string,
): string {
  const safe = `${repoId}-${templateName}`
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+/, "");
  return `${TEMPLATE_PREFIX}${safe}`.slice(0, 80);
}

export function isTartSessionVm(name: string): boolean {
  return name.startsWith(VM_PREFIX);
}

function q(word: string): string {
  return shellQuoteWord(word);
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

// ── Hosts (the Mac Runners) ─────────────────────────────────────────────────

/** One configured Mac as a usable host, or why it is not one right now. */
export async function resolveTartHost(spec: TartHostSpec): Promise<TartHost> {
  const { listRunners } = await import("../../runners");
  const { isRunnerConnected } = await import("../../runner-ws");
  const runner = listRunners().find(
    (candidate) =>
      candidate.id === spec.runner || candidate.name === spec.runner,
  );
  if (!runner)
    throw new Error(
      `Mac host "${spec.runner}" is not a paired Runner (Settings > Runners)`,
    );
  if (runner.platform !== "darwin")
    throw new Error(
      `Runner ${runner.name} runs ${runner.platform}; Mac VMs need a macOS Runner on Apple silicon`,
    );
  if (!isRunnerConnected(runner.id))
    throw new Error(`Mac host ${runner.name} is offline`);
  return { runnerId: runner.id, runnerName: runner.name, maxVms: spec.maxVms };
}

export interface TartHostRoster {
  online: TartHost[];
  /** Configured hosts that cannot take work now, with the reason. */
  unavailable: Array<{ runner: string; reason: string }>;
}

/** Every configured Mac, split into the ones that can take work now. */
export async function resolveTartHosts(
  settings: TartSettings = tartSettings(),
): Promise<TartHostRoster> {
  if (!settings.hosts.length)
    throw new Error(
      "No Mac host is configured: add a paired macOS Runner in Workspace > Sandboxes > Mac VM",
    );
  const roster: TartHostRoster = { online: [], unavailable: [] };
  for (const spec of settings.hosts) {
    try {
      roster.online.push(await resolveTartHost(spec));
    } catch (error) {
      roster.unavailable.push({
        runner: spec.runner,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return roster;
}

/** Hosts that can take work now; every configured Mac being unavailable is
 *  an error that names each one. */
async function onlineTartHosts(
  settings: TartSettings = tartSettings(),
): Promise<TartHost[]> {
  const roster = await resolveTartHosts(settings);
  if (!roster.online.length)
    throw new Error(
      roster.unavailable.length === 1
        ? roster.unavailable[0]!.reason
        : `No Mac host is available: ${roster.unavailable
            .map((host) => `${host.runner} (${host.reason})`)
            .join("; ")}`,
    );
  return roster.online;
}

export interface TartPlacementCandidate {
  host: TartHost;
  vms: TartVm[];
}

/** Where a new VM goes: the host with the most free slots, preferring one
 *  that holds `preferVm` (the repo's template, so the clone is warm). Ties
 *  keep the configured order. Null when every host is full. */
export function chooseTartHost(
  candidates: TartPlacementCandidate[],
  preferVm?: string,
): TartPlacementCandidate | null {
  const scored = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      free: candidate.host.maxVms - runningLocalVms(candidate.vms).length,
      warm:
        !!preferVm &&
        candidate.vms.some((vm) => vm.source !== "oci" && vm.name === preferVm),
    }))
    .filter((entry) => entry.free > 0)
    .sort(
      (a, b) =>
        Number(b.warm) - Number(a.warm) || b.free - a.free || a.index - b.index,
    );
  return scored[0]?.candidate ?? null;
}

/** Pick the Mac a new VM is created on. */
async function pickTartHost(
  settings: TartSettings,
  opts: { preferVm?: string; sessionId?: string } = {},
): Promise<TartPlacementCandidate> {
  const roster = await resolveTartHosts(settings);
  const candidates: TartPlacementCandidate[] = [];
  for (const host of roster.online) {
    try {
      candidates.push({ host, vms: await listVms(host) });
    } catch (error) {
      roster.unavailable.push({
        runner: host.runnerName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const chosen = chooseTartHost(candidates, opts.preferVm);
  if (chosen) return chosen;
  const full = candidates.map(
    ({ host, vms }) =>
      `${host.runnerName} ${runningLocalVms(vms).length}/${host.maxVms} (${
        runningLocalVms(vms)
          .map((vm) => vm.name)
          .join(", ") || "none"
      })`,
  );
  const down = roster.unavailable.map(
    (host) => `${host.runner}: ${host.reason}`,
  );
  throw new Error(
    `${candidates.length ? "Every Mac host is full" : "No Mac host is available"}: ${[
      ...full,
      ...down,
    ].join(
      "; ",
    )}. Sleep or delete another Mac Sandbox, raise a host's "Max VMs", or add another Mac in Workspace > Sandboxes.`,
  );
}

/** VM name -> Runner id, for VMs whose state file predates host tracking
 *  (and prewarms, which have none). Parked on globalThis for --hot. */
const vmHosts: Map<string, string> = ((globalThis as any).__osTartVmHosts ??=
  new Map());

/** The Mac that holds an existing VM. State files record it; older ones and
 *  prewarms are located by asking each online host once. */
export async function tartHostForVm(
  vmName: string,
  settings: TartSettings = tartSettings(),
): Promise<TartHost> {
  const state = readRemoteState("tart", vmName);
  const recorded = state?.host || vmHosts.get(vmName);
  const hosts = await onlineTartHosts(settings);
  if (recorded) {
    const known = hosts.find((host) => host.runnerId === recorded);
    if (known) return known;
    // Configured but not usable right now: say which, not "unknown VM".
    const { listRunners } = await import("../../runners");
    const runner = listRunners().find((r) => r.id === recorded);
    const spec = settings.hosts.find(
      (h) => h.runner === recorded || h.runner === runner?.name,
    );
    if (spec) return resolveTartHost(spec);
    throw new Error(
      `Mac VM ${vmName} lives on ${runner?.name || recorded}, which is no longer a Mac host of this workspace; add it back under Workspace > Sandboxes > Mac VM`,
    );
  }
  for (const host of hosts) {
    if ((await vmState(host, vmName)) !== "gone") {
      vmHosts.set(vmName, host.runnerId);
      if (state && !state.host)
        writeRemoteState({ ...state, host: host.runnerId });
      return host;
    }
  }
  throw new Error(`Unknown Mac VM ${vmName}`);
}

interface HostExecOpts {
  timeoutMs?: number;
  sessionId?: string;
  /** Free-text head for the Runner's audit line (never the payload). */
  label?: string;
}

/** One command on the Mac host through the Runner channel. Never throws on a
 *  non-zero exit; a timed-out command reports exit 124. */
export async function tartHostExec(
  host: TartHost,
  command: string,
  opts: HostExecOpts = {},
): Promise<ExecResult> {
  const { execOnRunner } = await import("../../runner-ws");
  const head = `: ${q(`opensession tart ${opts.label || "host"}`)}`;
  const padded = head.padEnd(AUDIT_HEAD_CHARS, " ");
  const result = await execOnRunner(
    host.runnerId,
    `${padded}; export PATH=${HOST_PATH}:$PATH; ${command}`,
    { timeoutMs: opts.timeoutMs ?? 120_000, sessionId: opts.sessionId },
  );
  return {
    exitCode: result.timedOut ? 124 : result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function hostNeed(result: ExecResult, what: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${what}: ${(result.stderr || result.stdout).trim().slice(0, 400) || `exit ${result.exitCode}`}`,
    );
  }
}

export interface TartVm {
  name: string;
  source: "local" | "oci" | string;
  running: boolean;
}

/** Parse `tart list --format json` (field names vary across releases). */
export function parseTartList(stdout: string): TartVm[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout || "[]");
  } catch {
    throw new Error(`tart list returned no JSON: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(raw)) return [];
  const out: TartVm[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const name = String(entry.Name ?? entry.name ?? "");
    if (!name) continue;
    const state = String(entry.State ?? entry.state ?? "").toLowerCase();
    const running =
      entry.Running === true || entry.running === true || state === "running";
    out.push({
      name,
      // tart prints "OCI" / "local"; compare case-insensitively.
      source: String(entry.Source ?? entry.source ?? "local").toLowerCase(),
      running,
    });
  }
  return out;
}

async function listVms(host: TartHost): Promise<TartVm[]> {
  const r = await tartHostExec(host, `${TART} list --format json`, {
    label: "list",
    timeoutMs: 60_000,
  });
  hostNeed(r, "tart list failed");
  return parseTartList(r.stdout);
}

async function vmState(host: TartHost, name: string): Promise<SandboxStatus> {
  const vm = (await listVms(host)).find(
    (candidate) => candidate.source !== "oci" && candidate.name === name,
  );
  if (!vm) return "gone";
  return vm.running ? "running" : "stopped";
}

function runningLocalVms(vms: TartVm[]): TartVm[] {
  return vms.filter((vm) => vm.source !== "oci" && vm.running);
}

/** Refuse to start another guest when the host is at its VM budget. */
export function assertTartCapacity(
  vms: TartVm[],
  name: string,
  maxVms: number,
  hostName: string,
): void {
  const running = runningLocalVms(vms).filter((vm) => vm.name !== name);
  if (running.length >= maxVms) {
    throw new Error(
      `Mac host ${hostName} is full: ${running.length} of ${maxVms} VMs running (${running
        .map((vm) => vm.name)
        .join(
          ", ",
        )}). Sleep or delete another Mac Sandbox first, raise "Max VMs", or add another Mac in Workspace > Sandboxes.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(
  host: TartHost,
  name: string,
  wanted: SandboxStatus,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await vmState(host, name)) === wanted) return;
    await sleep(2_000);
  }
  throw new Error(`Mac VM ${name} did not become ${wanted} in time`);
}

/** Boot a stopped VM detached from the Runner command (nohup), then wait for
 *  its DHCP lease. SSH readiness is the driver's job. */
async function launchVm(
  host: TartHost,
  name: string,
  machine: { cpu: number; memoryMb: number },
  opts: { sessionId?: string } = {},
): Promise<string> {
  const vms = await listVms(host);
  const vm = vms.find((c) => c.source !== "oci" && c.name === name);
  if (!vm) throw new Error(`Mac VM ${name} does not exist`);
  if (!vm.running) {
    assertTartCapacity(vms, name, host.maxVms, host.runnerName);
    await tartHostExec(
      host,
      `${TART} set ${q(name)} --cpu ${machine.cpu} --memory ${machine.memoryMb}`,
      { label: `set ${name}`, sessionId: opts.sessionId },
    );
    // launchd owns the VM process: a child of the Runner dies with the
    // Runner's process group when the Runner restarts or upgrades. A plist
    // rather than `launchctl submit`, whose jobs are kept alive: launchd
    // would boot the guest again the moment `tart stop` shut it down.
    const started = await tartHostExec(
      host,
      `mkdir -p ${HOST_DIR}/vms && cd ${HOST_DIR}/vms || exit 1
` +
        `${unloadVmJob(name)}; rm -f ${q(`${name}.log`)}
` +
        `cat > ${q(`${name}.plist`)} <<EOF
${launchdPlist(name)}
EOF
` +
        `launchctl bootstrap gui/$(id -u) ${q(`${name}.plist`)} || exit 1
` +
        `sleep 2; pid=$(launchctl print gui/$(id -u)/${q(launchdLabel(name))} 2>/dev/null | awk '/^\tpid = /{print $3}')
` +
        `[ -n "$pid" ] || exit 1; echo "$pid" > ${q(`${name}.pid`)}`,
      { label: `run ${name}`, sessionId: opts.sessionId, timeoutMs: 30_000 },
    );
    if (started.exitCode !== 0) {
      const log = await tartHostExec(
        host,
        `tail -20 ${HOST_DIR}/vms/${q(`${name}.log`)} 2>/dev/null`,
        { label: `log ${name}` },
      );
      throw new Error(
        `Mac VM ${name} did not start: ${(log.stdout || started.stderr).trim().slice(0, 400)}`,
      );
    }
  }
  const ip = await tartHostExec(host, `${TART} ip ${q(name)} --wait 120`, {
    label: `ip ${name}`,
    sessionId: opts.sessionId,
    timeoutMs: 150_000,
  });
  const match = ip.stdout.trim().match(/\d+\.\d+\.\d+\.\d+/);
  if (!match) {
    const log = await tartHostExec(
      host,
      `tail -20 ${HOST_DIR}/vms/${q(`${name}.log`)} 2>/dev/null`,
      { label: `log ${name}` },
    );
    throw new Error(
      `Mac VM ${name} got no IP address: ${(ip.stderr || log.stdout).trim().slice(0, 400)}`,
    );
  }
  await assertGuestReachable(host, name, match[0], opts.sessionId);
  return match[0];
}

/** The guest's sshd must answer from the Mac. macOS 15 and later gate LAN
 *  access (the vmnet bridge included) per app behind the Local Network
 *  privacy permission; the Runner's process needs it once. Name that cause
 *  instead of timing out in the SSH wait later. */
async function assertGuestReachable(
  host: TartHost,
  name: string,
  ip: string,
  sessionId?: string,
): Promise<void> {
  // A cold macOS guest holds its DHCP lease a couple of minutes before sshd
  // is up, so the wait is generous and split into short host commands. The
  // last connect error tells the two failures apart: a booting guest refuses
  // or times out, a Local Network gate answers "No route to host" although
  // the guest already has a lease.
  const deadline = Date.now() + GUEST_REACH_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    const probe = await tartHostExec(
      host,
      `for i in $(seq 1 12); do err=$(nc -z -v -w 2 ${ip} 22 2>&1) && exit 0; sleep 3; done; echo "$err" >&2; exit 1`,
      { label: `reach ${name}`, sessionId, timeoutMs: 90_000 },
    );
    if (probe.exitCode === 0) return;
    lastError = probe.stderr.trim().slice(0, 200) || lastError;
  }
  const hint = /no route to host/i.test(lastError)
    ? await localNetworkHint(host)
    : ` Check that the VM booted (its VNC URL is in ~/.opensession-tart/vms/${name}.log on the Mac).`;
  throw new Error(
    `Mac VM ${name} at ${ip} does not answer on port 22 from ${host.runnerName}${lastError ? ` (${lastError})` : ""}.${hint}`,
  );
}

const GUEST_REACH_TIMEOUT_MS = 6 * 60_000;

function launchdLabel(name: string): string {
  return `opensession-tart-${name}`;
}

/** Shell text that unloads a guest's launchd job if it is loaded. Exits 0. */
function unloadVmJob(name: string): string {
  return `launchctl bootout gui/$(id -u)/${q(launchdLabel(name))} >/dev/null 2>&1; true`;
}

/** The job runs the guest once (`KeepAlive` false) and logs next to the VM
 *  records. Written through an unquoted heredoc, so `$HOME` expands on the
 *  Mac; VM names are already restricted to `[A-Za-z0-9_.-]`. */
export function launchdPlist(name: string): string {
  const dir = "$HOME/.opensession-tart";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${launchdLabel(name)}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>${dir}/tart.app/Contents/MacOS/tart</string>`,
    "<string>run</string><string>--no-graphics</string><string>--vnc-experimental</string>",
    `<string>${name}</string>`,
    "</array>",
    `<key>WorkingDirectory</key><string>${dir}/vms</string>`,
    `<key>StandardOutPath</key><string>${dir}/vms/${name}.log</string>`,
    `<key>StandardErrorPath</key><string>${dir}/vms/${name}.log</string>`,
    "<key>EnvironmentVariables</key><dict>",
    "<key>HOME</key><string>$HOME</string>",
    "<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>",
    "</dict>",
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><false/>",
    "</dict></plist>",
  ].join("\n");
}

/** macOS keeps the Local Network decision per signed binary in the network
 *  extension preferences (world-readable). The Runner's own binary is the
 *  parent of the host shell, so its record says whether the user has denied,
 *  allowed, or never been asked. */
const LOCAL_NETWORK_STATE_SCRIPT = [
  "BUN=$(ps -o comm= -p $PPID); T=$(mktemp)",
  'plutil -p /Library/Preferences/com.apple.networkextension.plist > "$T" 2>/dev/null',
  // The archived plist lists strings by index and records reference them:
  // find the index of the binary's path, then the record whose Path is it.
  `id=$(grep -n "=> .$BUN.$" "$T" | head -1 | sed -E 's/^[0-9]+: *([0-9]+) => .*/\\1/')`,
  'L=""; [ -n "$id" ] && L=$(grep -n ".Path. => .*value = $id}" "$T" | head -1 | cut -d: -f1)',
  'if [ -z "$L" ]; then echo "unset $BUN"',
  `elif sed -n "$((L-12)),$L p" "$T" | grep -q '.DenyMulticast. => true'; then echo "denied $BUN"`,
  'else echo "allowed $BUN"; fi',
  'rm -f "$T"',
].join("\n");

export function localNetworkHintFor(state: string, runnerName: string): string {
  const [word, ...rest] = state.trim().split(/\s+/);
  const binary = rest.join(" ") || "bun";
  const where = `System Settings > Privacy & Security > Local Network on ${runnerName}`;
  switch (word) {
    case "denied":
      return ` The Runner (${binary}) is switched off under ${where}; turn it on, then test again.`;
    case "allowed":
      return ` The Runner (${binary}) is allowed under ${where} but its running process predates that decision; restart the Runner service on ${runnerName}, then test again.`;
    default:
      return ` macOS has not been told whether the Runner may use the local network: on ${runnerName}, accept the "bun would like to find and connect to devices on your local network" dialog or add ${binary} under ${where}, then test again.`;
  }
}

async function localNetworkHint(host: TartHost): Promise<string> {
  const probe = await tartHostExec(host, LOCAL_NETWORK_STATE_SCRIPT, {
    label: "local-network",
    timeoutMs: 60_000,
  });
  return localNetworkHintFor(probe.stdout, host.runnerName);
}

async function stopVm(
  host: TartHost,
  name: string,
  opts: { sessionId?: string } = {},
): Promise<void> {
  if ((await vmState(host, name)) !== "running") return;
  await tartHostExec(host, `${TART} stop ${q(name)} --timeout 60`, {
    label: `stop ${name}`,
    sessionId: opts.sessionId,
    timeoutMs: 120_000,
  });
  await waitForState(host, name, "stopped", 90_000);
  await tartHostExec(host, unloadVmJob(name), {
    label: `unload ${name}`,
    sessionId: opts.sessionId,
  });
}

async function deleteVm(
  host: TartHost,
  name: string,
  opts: { sessionId?: string } = {},
): Promise<void> {
  const state = await vmState(host, name);
  if (state === "gone") return;
  if (state === "running") await stopVm(host, name, opts);
  hostNeed(
    await tartHostExec(
      host,
      `${unloadVmJob(name)}; ${TART} delete ${q(name)} && rm -f ${HOST_DIR}/vms/${q(`${name}.log`)} ${HOST_DIR}/vms/${q(`${name}.pid`)} ${HOST_DIR}/vms/${q(`${name}.plist`)} ${HOST_DIR}/vms/${q(`${name}.labels.json`)}`,
      {
        label: `delete ${name}`,
        sessionId: opts.sessionId,
        timeoutMs: 120_000,
      },
    ),
    `could not delete Mac VM ${name}`,
  );
}

async function cloneVm(
  host: TartHost,
  from: string,
  name: string,
  opts: { sessionId?: string } = {},
): Promise<void> {
  hostNeed(
    await tartHostExec(host, `${TART} clone ${q(from)} ${q(name)}`, {
      label: `clone ${name}`,
      sessionId: opts.sessionId,
      timeoutMs: 10 * 60_000,
    }),
    `could not clone Mac VM ${from} to ${name}`,
  );
}

// ── Guest driver (SSH from the host into the VM) ─────────────────────────────

function sshCommand(ip: string, remote: string): string {
  return (
    `ssh -q -i ${KEY} -o BatchMode=yes -o StrictHostKeyChecking=no ` +
    `-o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15 ` +
    `-o ServerAliveInterval=30 ${GUEST_USER}@${ip} ${remote}`
  );
}

/** The guest script, carried as base64 so neither shell interprets it. */
export function guestRemoteArg(script: string): string {
  return `'bash -c "$(printf %s ${b64(script)} | base64 -d)"'`;
}

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

export interface TartDriverOptions {
  machine: { cpu: number; memoryMb: number };
  sessionId?: string;
}

export function tartDriver(
  host: TartHost,
  vmName: string,
  options: TartDriverOptions,
): RemoteDriver {
  let ip: string | undefined;
  const resolveIp = async (force = false): Promise<string> => {
    if (ip && !force) return ip;
    const r = await tartHostExec(host, `${TART} ip ${q(vmName)} --wait 30`, {
      label: `ip ${vmName}`,
      sessionId: options.sessionId,
      timeoutMs: 60_000,
    });
    const match = r.stdout.trim().match(/\d+\.\d+\.\d+\.\d+/);
    if (!match)
      throw new Error(
        `Mac VM ${vmName} has no IP address (is it running?): ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
      );
    ip = match[0];
    return ip;
  };
  const run = async (
    script: string,
    timeoutMs: number,
    label: string,
  ): Promise<ExecResult> => {
    let addr = await resolveIp();
    let result = await tartHostExec(
      host,
      sshCommand(addr, guestRemoteArg(script)),
      { timeoutMs, sessionId: options.sessionId, label },
    );
    if (result.exitCode === 255) {
      // SSH itself failed (lease changed after a wake, sshd still starting).
      await sleep(2_000);
      addr = await resolveIp(true);
      result = await tartHostExec(
        host,
        sshCommand(addr, guestRemoteArg(script)),
        { timeoutMs, sessionId: options.sessionId, label },
      );
    }
    return result;
  };
  const driver: RemoteDriver = {
    os: "darwin",
    async exec(cmd, opts) {
      return run(
        guestScript(cmd, opts),
        opts?.timeoutMs ?? 300_000,
        `guest ${vmName}`,
      );
    },
    async execBackground(cmd, opts) {
      const script = guestScript(
        `nohup bash -c ${q(cmd)} >/dev/null 2>&1 </dev/null & disown; echo $!`,
        opts,
      );
      const r = await run(
        script,
        opts?.timeoutMs ?? 60_000,
        `guest-bg ${vmName}`,
      );
      if (r.exitCode !== 0)
        throw new Error(
          `Mac VM ${vmName} background command failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
        );
    },
    async writeFile(path, content) {
      if (Buffer.byteLength(content) > MAX_GUEST_FILE_BYTES)
        throw new Error(
          `refusing to write ${path} into Mac VM ${vmName}: ${Buffer.byteLength(content)} bytes exceeds the command channel limit`,
        );
      const script = guestScript(
        `mkdir -p ${q(dirname(path))} && printf %s ${b64(content)} | base64 -d > ${q(path)}`,
      );
      const r = await run(script, 120_000, `guest-write ${vmName}`);
      if (r.exitCode !== 0)
        throw new Error(
          `could not write ${path} into Mac VM ${vmName}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
        );
    },
    async ensureStarted() {
      const state = await vmState(host, vmName);
      if (state === "gone")
        throw new Error(`Mac VM ${vmName} no longer exists`);
      if (state === "running" && ip) return;
      ip = await launchVm(host, vmName, options.machine, {
        sessionId: options.sessionId,
      });
      await waitForSsh(driver, vmName);
    },
  };
  return driver;
}

async function waitForSsh(
  driver: RemoteDriver,
  vmName: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const probe = await driver.exec("uname -s", { timeoutMs: 30_000 });
    if (probe.exitCode === 0 && probe.stdout.includes("Darwin")) return;
    last = (probe.stderr || probe.stdout).trim().slice(0, 200);
    await sleep(3_000);
  }
  throw new Error(
    `Mac VM ${vmName} did not accept SSH in ${Math.round(timeoutMs / 1000)}s${last ? ` (${last})` : ""}`,
  );
}

// ── Host preparation: tart, key, image, base VM ──────────────────────────────

type Progress = (stage: string, progress?: number) => void;

async function ensureTartInstalled(host: TartHost, progress: Progress) {
  const present = await tartHostExec(host, `${TART} --version`, {
    label: "version",
  });
  if (present.exitCode === 0 && present.stdout.trim() === TART_VERSION) return;
  progress(`Installing tart ${TART_VERSION}`, 5);
  hostNeed(
    await tartHostExec(
      host,
      `mkdir -p ${HOST_DIR} && cd ${HOST_DIR} && ` +
        `curl -fsSLo tart.tar.gz ${q(TART_RELEASE_URL)} && ` +
        `echo ${q(`${TART_SHA256}  tart.tar.gz`)} | shasum -a 256 -c - && ` +
        `rm -rf tart.app && tar -xzf tart.tar.gz && rm -f tart.tar.gz && ` +
        `test "$(${TART} --version)" = ${q(TART_VERSION)}`,
      { label: "install", timeoutMs: 300_000 },
    ),
    "tart install failed",
  );
}

async function ensureHostKey(host: TartHost) {
  hostNeed(
    await tartHostExec(
      host,
      `mkdir -p ${HOST_DIR} && chmod 700 ${HOST_DIR} && ` +
        `{ test -f ${KEY} || ssh-keygen -q -t ed25519 -N '' -f ${KEY} -C opensession-tart; } && test -f ${KEY}.pub`,
      { label: "key" },
    ),
    "could not prepare the host SSH key",
  );
}

/** Pull the OCI image once. The pull is detached (it can take an hour for a
 *  60 GB Xcode image); this waits on it with progress from tart's log. */
async function ensureImagePulled(
  host: TartHost,
  image: string,
  progress: Progress,
  timeoutMs = 4 * 60 * 60_000,
) {
  const present = async () =>
    (await listVms(host)).some(
      (vm) => vm.source === "oci" && vm.name === image,
    );
  if (await present()) return;
  // A pull already in flight (this or an operator's) is joined, never
  // duplicated: two pulls of one image race on the same cache directory.
  const pulling = `pgrep -f ${q(`tart pull ${image}`)} >/dev/null 2>&1`;
  const started = await tartHostExec(
    host,
    `mkdir -p ${HOST_DIR} && cd ${HOST_DIR} && ` +
      `if ${pulling}; then echo already; else ` +
      `nohup ${TART} pull ${q(image)} > pull.log 2>&1 < /dev/null & echo started; fi`,
    { label: "pull", timeoutMs: 30_000 },
  );
  hostNeed(started, "could not start the image pull");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(20_000);
    const status = await tartHostExec(
      host,
      `cd ${HOST_DIR} && if ${pulling}; then echo running; else echo done; fi; ` +
        `tail -c 400 pull.log 2>/dev/null | tr '\\r' '\\n' | grep -aE '[0-9]+%' | tail -1`,
      { label: "pull status", timeoutMs: 30_000 },
    );
    const lines = status.stdout.trim().split("\n");
    const running = lines[0] === "running";
    const percent = Number(
      (lines
        .slice(1)
        .join(" ")
        .match(/(\d+)%/) || [])[1] ?? NaN,
    );
    progress(
      `Pulling ${image}${Number.isFinite(percent) ? ` (${percent}%)` : ""}`,
      Number.isFinite(percent) ? 10 + Math.round(percent * 0.5) : 10,
    );
    if (!running) {
      if (await present()) return;
      const log = await tartHostExec(host, `tail -c 800 ${HOST_DIR}/pull.log`, {
        label: "pull log",
      });
      throw new Error(
        `image pull of ${image} ended without the image: ${log.stdout.trim().slice(-400)}`,
      );
    }
  }
  throw new Error(`image pull of ${image} did not finish in time`);
}

export function baseSignature(image: string): string {
  return `${image}|${BASE_PREPARATION_REVISION}|tart@${TART_VERSION}`;
}

const INJECT_KEY_EXPECT = String.raw`set timeout 120
set ip [lindex $argv 0]
set key [lindex $argv 1]
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive admin@$ip "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' \"$key\" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED"
expect {
  -re "(?i)password:" { send "${GUEST_PASSWORD}\r"; exp_continue }
  "KEY_INSTALLED" { }
  timeout { exit 2 }
  eof { }
}
catch wait result
exit [lindex $result 3]
`.replace("${GUEST_PASSWORD}", GUEST_PASSWORD);

/** Prepare (or refresh) the shared base VM every session VM is cloned from. */
export async function ensureTartBaseVm(
  host: TartHost,
  settings: TartSettings,
  progress: Progress = () => undefined,
): Promise<void> {
  await ensureTartInstalled(host, progress);
  await ensureHostKey(host);
  const signature = baseSignature(settings.image);
  const marker = await tartHostExec(
    host,
    `cat ${HOST_DIR}/base.json 2>/dev/null`,
    {
      label: "base marker",
    },
  );
  let recorded: { signature?: string } = {};
  try {
    recorded = JSON.parse(marker.stdout || "{}");
  } catch {}
  const vms = await listVms(host);
  const baseExists = vms.some(
    (vm) => vm.source !== "oci" && vm.name === TART_BASE_VM,
  );
  if (recorded.signature === signature && baseExists) return;

  await ensureImagePulled(host, settings.image, progress);
  progress("Preparing the base VM", 62);
  const base = vms.find(
    (vm) => vm.source !== "oci" && vm.name === TART_BASE_VM,
  );
  if (base) await deleteVm(host, TART_BASE_VM);
  await cloneVm(host, settings.image, TART_BASE_VM);
  const ip = await launchVm(host, TART_BASE_VM, { cpu: 2, memoryMb: 4096 });
  try {
    progress("Installing the host key in the base VM", 70);
    hostNeed(
      await tartHostExec(
        host,
        `cat > ${HOST_DIR}/inject-key.expect <<'OPENSESSION_EXPECT'\n${INJECT_KEY_EXPECT}OPENSESSION_EXPECT\n` +
          `for attempt in 1 2 3 4 5 6; do ` +
          `if expect ${HOST_DIR}/inject-key.expect ${ip} "$(cat ${KEY}.pub)" >/dev/null 2>&1; then exit 0; fi; sleep 10; done; ` +
          `echo "could not install the SSH key with the image password" >&2; exit 1`,
        { label: "inject key", timeoutMs: 15 * 60_000 },
      ),
      "base VM key install failed",
    );
    const driver = tartDriver(host, TART_BASE_VM, {
      machine: { cpu: 2, memoryMb: 4096 },
    });
    await waitForSsh(driver, TART_BASE_VM);
    progress("Configuring the base VM", 80);
    const prep = await driver.exec(
      [
        "set -e",
        "sudo -n true",
        "sudo -n pmset -a sleep 0 displaysleep 0 disksleep 0 >/dev/null 2>&1 || true",
        "defaults -currentHost write com.apple.screensaver idleTime 0 >/dev/null 2>&1 || true",
        "sudo -n launchctl unload -w /System/Library/LaunchDaemons/com.apple.softwareupdated.plist >/dev/null 2>&1 || true",
        // A session keeps its canonical host workspace path, which lives under
        // the Linux guest home. macOS reserves /home for the automounter, so
        // switch that map off and alias the path to the guest user's home.
        // The automounter also created the root /home entry at boot; with the
        // map off, synthetic.conf has to provide it (it takes effect on the
        // next boot, which is the first boot of every clone).
        "sudo -n sed -i '' 's#^/home[[:space:]]#\\#&#' /etc/auto_master",
        "sudo -n automount -vc >/dev/null 2>&1 || true",
        "printf 'home\\tSystem/Volumes/Data/home\\n' | sudo -n tee /etc/synthetic.conf >/dev/null",
        "sudo -n chmod 644 /etc/synthetic.conf",
        "sudo -n mkdir -p /System/Volumes/Data/home",
        `[ -e /System/Volumes/Data/home/ubuntu ] || sudo -n ln -s /Users/${GUEST_USER} /System/Volumes/Data/home/ubuntu`,
        "test -d /System/Volumes/Data/home/ubuntu/Library",
        "command -v cliclick >/dev/null 2>&1 || HOMEBREW_NO_AUTO_UPDATE=1 brew install cliclick >/dev/null 2>&1 || echo 'cliclick not installed (desktop control limited)' >&2",
        `printf %s ${q(signature)} > ~/.opensession-base`,
      ].join("\n"),
      { timeoutMs: 15 * 60_000 },
    );
    if (prep.exitCode !== 0)
      throw new Error(
        `base VM preparation failed: ${(prep.stderr || prep.stdout).trim().slice(0, 400)}`,
      );
  } finally {
    await stopVm(host, TART_BASE_VM);
  }
  hostNeed(
    await tartHostExec(
      host,
      `printf %s ${q(JSON.stringify({ signature, image: settings.image, preparedAt: new Date().toISOString() }))} > ${HOST_DIR}/base.json`,
      { label: "base marker" },
    ),
    "could not record the base VM",
  );
  progress("Base VM ready", 85);
}

// ── Provider ─────────────────────────────────────────────────────────────────

function machineFor(
  settings: TartSettings,
  resources?: SandboxMachineSettings,
): { cpu: number; memoryMb: number } {
  return {
    cpu: resources?.cpu || settings.cpu,
    memoryMb: resources?.memoryMb || settings.memoryMb,
  };
}

function guestCwd(branch: string, repoId: string): string {
  return `${L.home}/worktrees/${basename(worktreePathFor(branch, repoId, { isolated: true }))}`;
}

export class TartProvider implements SandboxProvider {
  readonly id = "tart" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    const startedAt = Date.now();
    const mark = (stage: string) =>
      console.log(
        `[sandbox:tart] ${spec.sessionId}: ${stage} (+${Date.now() - startedAt}ms)`,
      );
    if (spec.attachedDirs?.length)
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    if (spec.trustProfile === "automation")
      throw new Error(
        "Mac VM sandboxes do not enforce an outbound network policy; automations stay on Daytona",
      );
    const settings = tartSettings();
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd = spec.cwd || prevState?.cwd || guestCwd(branch, repo.id);
    const { sandboxEnvironmentSettings } = await import("../environments");
    const machine = machineFor(
      settings,
      sandboxEnvironmentSettings(repo.id, "tart"),
    );

    // The VM's Mac: the one that holds the session's VM, a prewarm's, or
    // the host with room for a new one.
    let host: TartHost | null = null;
    let vmName: string | null = null;
    if (prevState) {
      host = await locateVm(prevState.sandboxId, settings);
      if (host) vmName = prevState.sandboxId;
    }
    let resuming = false;
    if (vmName && host) {
      resuming = (await vmState(host, vmName)) !== "running";
    } else {
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        host = await locateVm(claim.sandboxId, settings);
        if (host) {
          vmName = claim.sandboxId;
          console.log(
            `[sandbox:tart] adopted prewarmed VM ${vmName} on ${host.runnerName} for ${spec.sessionId}`,
          );
        } else discardClaimedPrewarm(this.id, claim.sandboxId);
      }
    }
    let bootMode: "fresh" | "snapshot-restore" = "fresh";
    if (!vmName || !host) {
      const template = readRemoteRepoTemplate("tart", repo.id);
      const placed = await pickTartHost(settings, {
        preferVm: template?.artifactId,
        sessionId: spec.sessionId,
      });
      host = placed.host;
      await ensureTartBaseVm(host, settings);
      vmName = tartVmName(spec.sessionId);
      if ((await vmState(host, vmName)) !== "gone") {
        // A VM from an earlier life of this session whose state file is gone.
        await deleteVm(host, vmName, { sessionId: spec.sessionId });
      }
      // Templates live on the Mac that sealed them; another host clones the
      // base instead, and the template stays valid where it is.
      let from = TART_BASE_VM;
      if (
        template &&
        placed.vms.some(
          (vm) => vm.source !== "oci" && vm.name === template.artifactId,
        )
      ) {
        from = template.artifactId;
        bootMode = "snapshot-restore";
      }
      console.log(
        `[sandbox:tart] cloning ${from} to ${vmName} on ${host.runnerName}`,
      );
      await cloneVm(host, from, vmName, { sessionId: spec.sessionId });
      vmHosts.set(vmName, host.runnerId);
      mark("VM cloned");
    }

    const state = {
      sandboxId: vmName,
      provider: this.id,
      sessionId: spec.sessionId,
      host: host.runnerId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    };
    writeRemoteState(state);
    const driver = tartDriver(host, vmName, {
      machine,
      sessionId: spec.sessionId,
    });
    await driver.ensureStarted();
    mark("VM running");
    await assertDialbackReachable(driver, "tart");
    mark("dial-back verified");
    await bootstrapRemoteSandbox(driver, "tart");
    mark("runner ready");
    await setupRemoteWorkspace(
      driver,
      cwd,
      await remoteCloneUrl(repo),
      branch,
      repo.defaultBranch,
      repo.id,
      {
        sandboxId: vmName,
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
    if (resuming) {
      await runResumeHook(driver, this.id, vmName, {
        cwd,
        sessionId: spec.sessionId,
        repoId: repo.id,
        trustProfile: trust.trustProfile,
      });
      mark("resume hook ran");
    }
    writeRemoteState({ ...state, lastActivityAt: new Date().toISOString() });
    return Object.assign(
      this.makeHandle(host, vmName, spec.sessionId, cwd, machine),
      { wokeFromSleep: resuming, bootMode },
    );
  }

  private makeHandle(
    host: TartHost,
    vmName: string,
    sessionId: string,
    cwd: string,
    machine: { cpu: number; memoryMb: number },
  ): Sandbox {
    const providerId = this.id;
    const driver = tartDriver(host, vmName, { machine, sessionId });
    return makeRemoteSandbox({
      providerId,
      sandboxId: vmName,
      sessionId,
      cwd,
      driver,
      // Guest ports are reachable only from the Mac; every Portal rides the
      // outbound relay, which needs no published port.
      async ports(): Promise<PortMap> {
        return {};
      },
      status: () => vmState(host, vmName),
      touchActivity: () => touchRemoteState(providerId, vmName),
    });
  }

  private async handleFor(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const settings = tartSettings();
    const host = await locateVm(sandboxId, settings);
    if (!host) return null;
    const { sandboxEnvironmentSettings } = await import("../environments");
    const machine = machineFor(
      settings,
      state.repoId
        ? sandboxEnvironmentSettings(state.repoId, "tart")
        : undefined,
    );
    return this.makeHandle(
      host,
      sandboxId,
      state.sessionId,
      state.cwd,
      machine,
    );
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    try {
      return await this.handleFor(sandboxId);
    } catch (e) {
      console.warn(`[sandbox:tart] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  async desktopControl(sandboxId: string): Promise<SandboxDesktopControl> {
    await runningVm(sandboxId);
    const sandbox = await this.get(sandboxId);
    if (!sandbox) throw new Error("Wake the sandbox first");
    return macDesktopControl((cmd, opts) => sandbox.exec(cmd, opts));
  }

  /** The person's view: Tart's VNC server for this VM (the Mac's loopback),
   *  streamed through the Runner channel. The password is minted by Tart per
   *  boot and lives in the VM's log on the Mac. */
  async desktop(sandboxId: string): Promise<SandboxDesktop> {
    const { host, state } = await runningVm(sandboxId);
    const line = await tartHostExec(
      host,
      `grep -o 'vnc://[^ ]*' ${HOST_DIR}/vms/${q(`${sandboxId}.log`)} 2>/dev/null | tail -1`,
      { label: `desktop ${sandboxId}`, sessionId: state.sessionId },
    );
    const endpoint = parseTartVncUrl(line.stdout);
    if (!endpoint)
      throw new Error("The VM has not published its display yet; try again");
    return {
      vnc: {
        streamPath: vmDisplayStreamPath(state.sessionId),
        password: endpoint.password,
      },
    };
  }

  async pause(sandboxId: string): Promise<void> {
    const host = await tartHostForVm(sandboxId);
    const state = readRemoteState(this.id, sandboxId);
    await stopVm(host, sandboxId, { sessionId: state?.sessionId });
  }

  async resume(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const settings = tartSettings();
    const host = await locateVm(sandboxId, settings);
    if (!host) return null;
    const woke = (await vmState(host, sandboxId)) !== "running";
    const { sandboxEnvironmentSettings } = await import("../environments");
    const machine = machineFor(
      settings,
      state.repoId
        ? sandboxEnvironmentSettings(state.repoId, "tart")
        : undefined,
    );
    const driver = tartDriver(host, sandboxId, {
      machine,
      sessionId: state.sessionId,
    });
    await driver.ensureStarted();
    if (woke) await runResumeHook(driver, this.id, sandboxId, state);
    return Object.assign(
      this.makeHandle(host, sandboxId, state.sessionId, state.cwd, machine),
      { wokeFromSleep: woke },
    );
  }

  async destroy(
    sandboxId: string,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const state = readRemoteState(this.id, sandboxId);
    try {
      const host = await tartHostForVm(sandboxId);
      await deleteVm(host, sandboxId, { sessionId: state?.sessionId });
      if (options.strict && (await vmState(host, sandboxId)) !== "gone")
        throw new Error(`Mac VM ${sandboxId} still exists after deletion`);
      vmHosts.delete(sandboxId);
      removeRemoteState(this.id, sandboxId);
    } catch (error) {
      if (options.strict) throw error;
      console.warn(`[sandbox:tart] destroy(${sandboxId}):`, error);
      vmHosts.delete(sandboxId);
      removeRemoteState(this.id, sandboxId);
    }
  }
}

/** The Mac holding a VM, or null when no host has it (deleted, or the VM
 *  was never created). Host outages still throw: a VM on an offline Mac is
 *  not gone. */
async function locateVm(
  vmName: string,
  settings: TartSettings,
): Promise<TartHost | null> {
  let host: TartHost;
  try {
    host = await tartHostForVm(vmName, settings);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown Mac VM"))
      return null;
    throw error;
  }
  return (await vmState(host, vmName)) === "gone" ? null : host;
}

// ── Idle sleep ───────────────────────────────────────────────────────────────

/** Tart has no provider-side idle timer. Stop session VMs whose last
 *  activity is older than idleStopMinutes; the next turn wakes them. */
/** Tart prints `VNC server is running at vnc://:<password>@127.0.0.1:<port>`
 *  once the guest's display is up; the last line wins after a reboot. */
export function parseTartVncUrl(
  text: string,
): { port: number; password: string } | null {
  const matches = [
    ...text.matchAll(/vnc:\/\/(?:[^:@\s]*):([^@\s]*)@127\.0\.0\.1:(\d+)/g),
  ];
  const last = matches.at(-1);
  if (!last) return null;
  const port = Number(last[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { port, password: decodeURIComponent(last[1]!) };
}

async function runningVm(sandboxId: string) {
  const state = readRemoteState("tart", sandboxId);
  if (!state) throw new Error(`Unknown Mac VM ${sandboxId}`);
  const host = await tartHostForVm(sandboxId);
  if ((await vmState(host, sandboxId)) !== "running")
    throw new Error("Wake the sandbox first");
  return { host, state };
}

/** The Runner and VM a viewer's display stream attaches to. */
export async function tartDisplayHost(
  sandboxId: string,
): Promise<{ runnerId: string; vm: string }> {
  const { host } = await runningVm(sandboxId);
  return { runnerId: host.runnerId, vm: sandboxId };
}

/** A Terminal tab inside the guest: the Runner opens the PTY and SSHes in
 *  with its host-local key (../../terminals.ts). A stopped VM is woken, as a
 *  terminal is an interactive gesture. */
export async function tartTerminalTarget(sandboxId: string): Promise<{
  runnerId: string;
  sessionId: string;
  vm: RunnerVmTerminal;
}> {
  const state = readRemoteState("tart", sandboxId);
  if (!state) throw new Error(`Unknown Mac VM ${sandboxId}`);
  const host = await tartHostForVm(sandboxId);
  if ((await vmState(host, sandboxId)) !== "running") {
    const { getSandboxProvider } = await import("../index");
    const woken = await getSandboxProvider("tart").resume?.(sandboxId);
    if (!woken) throw new Error("The Mac VM could not be woken");
  }
  return {
    runnerId: host.runnerId,
    sessionId: state.sessionId,
    vm: { name: sandboxId, user: GUEST_USER, cwd: state.cwd },
  };
}

export async function sweepIdleTartVms(now = Date.now()): Promise<string[]> {
  const settings = tartSettings();
  if (!settings.hosts.length) return [];
  const idleMs =
    (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  const stale = listRemoteStates("tart").filter(
    (state) =>
      now - Date.parse(state.lastActivityAt || state.createdAt) > idleMs,
  );
  if (!stale.length) return [];
  let hosts: TartHost[];
  try {
    hosts = (await resolveTartHosts(settings)).online;
  } catch {
    return [];
  }
  // One `tart list` per host, then stop each stale VM where it runs.
  const running = new Map<string, TartHost>();
  for (const host of hosts) {
    try {
      for (const vm of runningLocalVms(await listVms(host)))
        running.set(vm.name, host);
    } catch (error) {
      console.warn(
        `[sandbox:tart] idle sweep could not list ${host.runnerName}:`,
        error,
      );
    }
  }
  const stopped: string[] = [];
  for (const state of stale) {
    const host = running.get(state.sandboxId);
    if (!host) continue;
    const { hostRunBusy } = await import("../../host-registry");
    if (hostRunBusy(state.sessionId)) continue;
    try {
      await stopVm(host, state.sandboxId, { sessionId: state.sessionId });
      stopped.push(state.sandboxId);
      console.log(
        `[sandbox:tart] stopped idle VM ${state.sandboxId} on ${host.runnerName} (${state.sessionId})`,
      );
    } catch (error) {
      console.warn(
        `[sandbox:tart] idle stop of ${state.sandboxId} failed:`,
        error,
      );
    }
  }
  return stopped;
}

const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
let idleSweep: ReturnType<typeof setInterval> | undefined;

/** Idempotent; called from boot. */
export function startTartIdleSweep(): void {
  if (idleSweep) return;
  idleSweep = setInterval(() => {
    void sweepIdleTartVms().catch((error) =>
      console.warn("[sandbox:tart] idle sweep failed:", error),
    );
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();
}

// ── Project templates + prewarm ──────────────────────────────────────────────

function templateVmName(repoId: string): string {
  return tartTemplateVmName(repoId, remoteRepoTemplateName("tart", repoId));
}

/** A template may have been sealed on more than one Mac over time; delete
 *  it everywhere it exists. */
export async function deleteTartTemplateArtifact(
  artifactId: string,
): Promise<void> {
  if (!artifactId.startsWith(TEMPLATE_PREFIX)) return;
  for (const host of await onlineTartHosts()) {
    if ((await vmState(host, artifactId)) === "gone") continue;
    await deleteVm(host, artifactId);
  }
}

async function writeLabels(
  host: TartHost,
  name: string,
  labels: Record<string, string>,
) {
  hostNeed(
    await tartHostExec(
      host,
      `mkdir -p ${HOST_DIR}/vms && printf %s ${q(JSON.stringify(labels))} > ${HOST_DIR}/vms/${q(`${name}.labels.json`)}`,
      { label: `labels ${name}` },
    ),
    "could not record VM labels",
  );
}

export const tartPrewarmAdapter: PrewarmAdapter = {
  async create(labels, opts) {
    const key = labels[PREWARM_KEY_LABEL] || "";
    const repoId = key.startsWith("tart:") ? key.slice("tart:".length) : "";
    if (!repoId)
      throw new Error(`invalid tart prewarm key: ${key || "(missing)"}`);
    const settings = tartSettings();
    const template = readRemoteRepoTemplate("tart", repoId);
    const placed = await pickTartHost(settings, {
      preferVm: template?.artifactId,
    });
    const host = placed.host;
    await ensureTartBaseVm(host, settings);
    let from = TART_BASE_VM;
    let restoredFromTemplate = false;
    if (
      template &&
      placed.vms.some(
        (vm) => vm.source !== "oci" && vm.name === template.artifactId,
      )
    ) {
      from = template.artifactId;
      restoredFromTemplate = true;
    }
    const name = `${PREWARM_PREFIX}${Bun.randomUUIDv7().slice(-12)}`;
    await cloneVm(host, from, name);
    vmHosts.set(name, host.runnerId);
    await writeLabels(host, name, labels);
    const driver = tartDriver(host, name, {
      machine: machineFor(settings, opts.resources),
    });
    await driver.ensureStarted();
    return { sandboxId: name, driver, restoredFromTemplate };
  },

  async publishTemplate(sandboxId, repo, _label, options) {
    const settings = tartSettings();
    const host = await tartHostForVm(sandboxId, settings);
    const driver = tartDriver(host, sandboxId, {
      machine: machineFor(settings),
    });
    await driver.ensureStarted();
    await sealRemoteRepoTemplate(driver, "tart", repo);
    const name = templateVmName(repo.id);
    await stopVm(host, sandboxId);
    const exists = (await listVms(host)).some(
      (vm) => vm.source !== "oci" && vm.name === name,
    );
    if (exists && options?.replace) await deleteVm(host, name);
    if (!exists || options?.replace) await cloneVm(host, sandboxId, name);
    writeRemoteRepoTemplate("tart", repo.id, name);
    console.log(
      `[sandbox:tart] published post-setup repo template ${name} on ${host.runnerName}`,
    );
  },

  async park(sandboxId) {
    const host = await tartHostForVm(sandboxId);
    await stopVm(host, sandboxId);
  },

  async destroy(sandboxId) {
    const host = await tartHostForVm(sandboxId);
    await deleteVm(host, sandboxId);
    vmHosts.delete(sandboxId);
  },

  async listPrewarmed() {
    const out: Array<{ id: string; key: string }> = [];
    for (const host of await onlineTartHosts()) {
      for (const vm of await listVms(host)) {
        if (vm.source === "oci" || !vm.name.startsWith(PREWARM_PREFIX))
          continue;
        vmHosts.set(vm.name, host.runnerId);
        const labels = await tartHostExec(
          host,
          `cat ${HOST_DIR}/vms/${q(`${vm.name}.labels.json`)} 2>/dev/null`,
          { label: `labels ${vm.name}` },
        );
        let key = "";
        try {
          key = String(
            JSON.parse(labels.stdout || "{}")[PREWARM_KEY_LABEL] || "",
          );
        } catch {}
        out.push({ id: vm.name, key });
      }
    }
    return out;
  },
};

// ── Qualification ────────────────────────────────────────────────────────────

/** Prove every host end to end: Runner, tart, image, base VM, then a
 *  disposable VM's exec semantics, file upload, stop/start persistence, and
 *  a distinct clone (the project-snapshot mechanism). Everything created is
 *  deleted. Hosts are proven one after another; the first failure names its
 *  Mac, and every configured Mac must pass. */
export async function qualifyTartConnection(
  update: (stage: string, progress?: number) => void = () => undefined,
): Promise<void> {
  const settings = tartSettings();
  if (!settings.hosts.length)
    throw Object.assign(
      new Error(
        "No Mac host is configured: add a paired macOS Runner in Workspace > Sandboxes > Mac VM",
      ),
      { code: "QUALIFICATION_FAILED" },
    );
  const many = settings.hosts.length > 1;
  for (const [index, spec] of settings.hosts.entries()) {
    // Each host owns an equal slice of the progress bar.
    const scoped = (stage: string, progress?: number) =>
      update(
        many ? `${spec.runner}: ${stage}` : stage,
        progress === undefined
          ? undefined
          : Math.round((index * 100 + progress) / settings.hosts.length),
      );
    try {
      await qualifyTartHost(spec, settings, scoped);
    } catch (error) {
      // Surface the host's own message: the generic classifier keys on words
      // like "image" and would otherwise report a snapshot problem.
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(
        new Error(many ? `${spec.runner}: ${message}` : message),
        { code: "QUALIFICATION_FAILED" },
      );
    }
  }
}

async function qualifyTartHost(
  spec: TartHostSpec,
  settings: TartSettings,
  update: (stage: string, progress?: number) => void,
): Promise<void> {
  update("Checking the Mac host", 3);
  const host = await resolveTartHost(spec);
  const arch = await tartHostExec(host, "uname -m; sw_vers -productVersion", {
    label: "qualify host",
  });
  if (arch.exitCode !== 0 || !arch.stdout.includes("arm64"))
    throw new Error(
      `Mac host ${host.runnerName} is not Apple silicon (${arch.stdout.trim() || arch.stderr.trim()})`,
    );
  await ensureTartBaseVm(host, settings, update);
  const suffix = Bun.randomUUIDv7().slice(-10);
  const source = `${VM_PREFIX}qualify-${suffix}`;
  const restored = `${VM_PREFIX}qualify-${suffix}-restore`;
  try {
    update("Starting a disposable VM", 86);
    await cloneVm(host, TART_BASE_VM, source);
    const driver = tartDriver(host, source, { machine: machineFor(settings) });
    await driver.ensureStarted();
    const probe = await driver.exec(
      "set -eu; uname -s; sudo -n true; printf opensession-qualified > ~/.opensession-qualification",
      { timeoutMs: 60_000 },
    );
    if (probe.exitCode !== 0 || !probe.stdout.includes("Darwin"))
      throw new Error(
        `Mac VM command failed: ${(probe.stderr || probe.stdout).trim().slice(0, 200)}`,
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
        "Mac VM exec stream or exit-code semantics are incompatible",
      );
    await driver.writeFile(`${L.home}/.opensession-upload`, "uploaded");
    const upload = await driver.exec(
      `test "$(cat ~/.opensession-upload)" = uploaded`,
    );
    if (upload.exitCode !== 0)
      throw new Error("Mac VM file upload check failed");
    update("Checking sleep and wake", 90);
    await stopVm(host, source);
    await driver.ensureStarted();
    const lifecycle = await driver.exec(
      'test "$(cat ~/.opensession-qualification)" = opensession-qualified',
    );
    if (lifecycle.exitCode !== 0)
      throw new Error("Mac VM stop/start lost filesystem state");
    update("Checking snapshot restore", 94);
    await stopVm(host, source);
    await cloneVm(host, source, restored);
    const restoredDriver = tartDriver(host, restored, {
      machine: machineFor(settings),
    });
    await restoredDriver.ensureStarted();
    const restoreProbe = await restoredDriver.exec(
      'test "$(cat ~/.opensession-qualification)" = opensession-qualified',
      { timeoutMs: 60_000 },
    );
    if (restoreProbe.exitCode !== 0)
      throw new Error("Mac VM clone did not carry the source filesystem");
    update("Cleaning up", 98);
  } finally {
    for (const name of [restored, source]) {
      try {
        await deleteVm(host, name);
      } catch (error) {
        console.warn(`[sandbox:tart] qualification cleanup of ${name}:`, error);
      }
    }
  }
}
