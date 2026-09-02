/**
 * Sandbox configuration (sandbox rollout Phase 0).
 *
 * `~/.opensession-sandbox.json` (dual-read fallback to `~/.opensession-sandbox.json`)
 * picks the provider, e.g.
 *   {"provider": "docker", "image": "opensession-runner:latest",
 *    "idleStopMinutes": 30, "perRepo": {"app": {"provider": "docker"}}}
 *
 * Read fresh on every call (same pattern as codexTransport() reading
 * ~/.opensession-codex-transport.json) so a config flip applies to the next run
 * without a restart. Missing/invalid config = provider "local" = exactly
 * today's behavior.
 *
 * Kill switch: `touch <sessions-dir>/disable-sandboxes` forces "local" for
 * new runs regardless of config — mirroring host-client's disable-run-hosts.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { configuredIngress } from "../config";
import { getDefaultModel, providerFor, resolveModel } from "../models";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { stateDir } from "../paths";
import { writeJsonAtomic } from "../shared/atomic-write";
import type { SandboxProviderId, SandboxProviderUsability } from "./provider";

export const DEFAULT_SANDBOX_PREVIEW_PORTS = [3300, 3301, 3302] as const;

// Env-overridable so the verify suite (and unit tests) can point a scratch
// config at a scratch docker setup without touching the live file (which is
// read fresh per run). Read per call, not at module load, so a test can flip
// the env var without re-importing this module.
function configPath(): string {
  return process.env.OPENSESSION_SANDBOX_CONFIG || stateDir("sandbox.json");
}

export function sandboxConfigPath(): string {
  return configPath();
}
const DISABLE_FILE = `${OPENSESSION_SESSIONS_DIR}/disable-sandboxes`;

export interface SandboxRepoOverride {
  provider?: SandboxProviderId;
  image?: string;
}

/** Where a docker sandbox's workspace lives (sandbox rollout Phase 2):
 *  "bind" (default) bind-mounts the existing host worktree at its identical
 *  path; "volume" clones the repo into a per-session volume INSIDE the
 *  container — no host worktree at all, so destroy() deletes the workspace
 *  (that data loss is the mode's contract; push your work). */
export type SandboxWorkspaceMode = "bind" | "volume";

/** How a sandboxed run's host process talks to opensession (Phase 3):
 *  "socket" (default) = unix socket in a shared run dir (docker bind mounts
 *  it); "ws" = the host DIALS OUT to opensession's /run-ws route —
 *  required for remote providers (daytona/e2b force it), dogfooded by docker. */
export type SandboxTransport = "socket" | "ws";

/** How remote providers authenticate `git clone` inside the sandbox (they
 *  can't mount host creds). "none" = public clone; "https-token" injects the
 *  token into the https URL (GitHub App token / x-access-token). */
export interface SandboxCloneCredential {
  type: "none" | "https-token";
  token?: string;
}

/** Snapshot-based warm restores for the docker provider (background-agents
 *  pattern, adapted): on idle-stop the container is `docker commit`ed to a
 *  per-session image, and a later ensure() for a GONE container starts from
 *  that image instead of the base one — preserving container-layer state
 *  (installed deps/apt/global caches), NOT workspace or engine state (those
 *  live on volumes/bind mounts). See docker.ts's "Snapshots" header section. */
export interface SandboxSnapshotsConfig {
  /** Master switch. Default false — no snapshot is ever taken or restored. */
  enabled: boolean;
  /** Snapshot on the idle-stop sweep, right before the container stops. Default true. */
  onIdle: boolean;
  /** Keep at most this many snapshot images per session (older ones deleted). Default 2. */
  maxPerSession: number;
  /** After restoring a volume-mode workspace from a snapshot, freshen refs with
   *  a non-destructive `git fetch origin` + `git status` inside. Default true. */
  quickSyncOnRestore: boolean;
}

const SNAPSHOT_DEFAULTS: SandboxSnapshotsConfig = {
  enabled: false,
  onIdle: true,
  maxPerSession: 2,
  quickSyncOnRestore: true,
};

/** Advanced internal bind override for the unified public gateway. The
 * canonical public URL lives only in config.json's ingress section. */
export interface SandboxPublicIngressConfig {
  /** Master switch. The listener only starts (at boot — needs a restart) when true. */
  enabled: boolean;
  /** Listen port (default 3860). */
  port: number;
  /** Bind host (default "127.0.0.1" — a reverse proxy/tunnel fronts it). */
  host: string;
}

const PUBLIC_INGRESS_DEFAULT_PORT = 3860;

/** Warm-on-typing prewarm pool (src/server/sandbox/prewarm.ts): typing a
 *  new-session prompt starts provider-specific preparation; session create
 *  adopts the warmed sandbox. */
export interface SandboxPrewarmConfig {
  enabled: boolean;
  /** Destroy an untouched prewarm after this many minutes (default 10). */
  ttlMinutes: number;
  /** At most this many live prewarms across all keys (default 2). */
  maxLive: number;
  /** Explicit targets kept prepared even while nobody is typing. */
  keepReady: Array<{ provider: string; repoId: string }>;
}

const PREWARM_DEFAULTS: Omit<SandboxPrewarmConfig, "enabled"> = {
  ttlMinutes: 10,
  maxLive: 2,
  keepReady: [],
};

export interface SandboxDaytonaConfig {
  apiUrl?: string;
  target?: string;
  /**
   * Org snapshot to create sandboxes from (custom `resources` are rejected
   * when creating from a snapshot, so sizing lives in the snapshot itself).
   * Unset = Daytona's default snapshot: 1 vCPU / 1GB / 3GiB disk — too small
   * for real repo workspaces (the runner payload alone is ~2GB; a large repo's
   * clone died on ENOSPC). Create one via the SDK, e.g. name
   * sandbox-lg-us, image daytonaio/sandbox:0.8.0, resources {cpu:2,
   * memory:4, disk:10 (org max)}, regionId "us".
   */
  snapshot?: string;
}

export interface SandboxE2bConfig {
  /** Falls back to E2B_API_KEY. */
  apiKey?: string;
  /** Sandbox template id/name (default "base"). */
  template?: string;
}

export interface SandboxModalConfig {
  /** Optional named provider profile stored as non-secret connection metadata. */
  profile?: string;
  /** Modal App name used to group sandboxes (default opensession-sandboxes). */
  app?: string;
  /** Registry image for new sandboxes (default daytonaio/sandbox:0.8.0). */
  image?: string;
  environment?: string;
  endpoint?: string;
  region?: string;
  cloud?: string;
  /** Modal tunnel URLs are public. Require an explicit opt-in before exposing preview ports. */
  publicPreviews?: boolean;
}

export interface SandboxAwsLambdaMicrovmConfig {
  /** ARN or ID of a CREATED Lambda MicroVM image containing the control daemon. */
  imageIdentifier?: string;
  imageVersion?: string;
  executionRoleArn?: string;
  region?: string;
  ingressConnectorArn?: string;
  egressConnectorArn?: string;
  controlPort?: number;
  maximumDurationSeconds?: number;
  /** Opt-in endpoint-idle suspension. Omit for long-running agent safety. */
  idleSuspendSeconds?: number;
  suspendedDurationSeconds?: number;
  logGroup?: string;
}

export interface SandboxAutomationConfig {
  /** Unattended runs are admitted only on a provider whose outbound policy is
   *  enforced natively per sandbox. Daytona applies a per-sandbox domain
   *  allowlist on its runner, so it is the only admitted backend. */
  provider: "daytona";
  /** Extra hostnames (or URLs, or `*.example.com` wildcards) an automation may
   *  contact. Model, git, and the Open Session callback hosts are added by the
   *  launcher. IP addresses and CIDRs are refused: Daytona's domain and CIDR
   *  allowlists are mutually exclusive. */
  egressAllowlist?: string[];
}

export interface SandboxConfig {
  provider: SandboxProviderId;
  /** Shared default for NEW interactive sessions. Absent/"none" = host. */
  sessionDefault?: RunnableSandboxProviderId | "none";
  /** Container image for the docker provider (Phase 1). */
  image?: string;
  /** Stop idle sandboxes after this many minutes; unset = provider default (30). */
  idleStopMinutes?: number;
  /** CPU limit per container (docker --cpus); unset = provider default (4). */
  cpus?: number;
  /** Memory limit per container (docker --memory, e.g. "8g"); unset = default ("8g"). */
  memory?: string;
  /** Workspace mode for NEW docker sandboxes (existing sandboxes keep the mode
   *  they were created with — recorded in their state file). Default "bind". */
  workspace?: SandboxWorkspaceMode;
  /** Container ports to publish for previews (docker -p 127.0.0.1::<port>,
   *  random loopback host port, set at container create). Default none. */
  previewPorts?: number[];
  /** Snapshot-based warm restores (docker provider only). Absent = disabled. */
  snapshots?: SandboxSnapshotsConfig;
  /** Per-repo overrides keyed by repo id (worktree.ts REPOS). */
  perRepo?: Record<string, SandboxRepoOverride>;
  /** Run-stream + MCP-RPC transport for NEW sandbox launches. Default "socket".
   *  Remote providers always use "ws" regardless of this value. */
  transport?: SandboxTransport;
  /**
   * Base URL sandboxes dial back to for the WS transport, e.g.
   * "ws://100.x.y.z:3850" (or https://… — normalized to wss). Default is
   * derived from the server's bind (HOST:PORT env). MUST be reachable FROM the
   * sandbox: for remote providers that means a publicly/tailnet-reachable URL
   * (self-hosters: your Tailscale ts.net URL or a tunnel); a 127.0.0.1 bind
   * only works for host-local sandboxes.
   */
  callbackBaseUrl?: string;
  /** Public dial-back listener for remote providers (absent = disabled). */
  publicIngress?: SandboxPublicIngressConfig;
  /** Daytona adapter (provider "daytona"). */
  daytona?: SandboxDaytonaConfig;
  /** E2B adapter (provider "e2b"). */
  e2b?: SandboxE2bConfig;
  /** Modal adapter (provider "modal"). */
  modal?: SandboxModalConfig;
  /** AWS Lambda MicroVM adapter (provider "lambda-microvm"). */
  awsLambdaMicrovm?: SandboxAwsLambdaMicrovmConfig;
  /** Credential-minimal unattended-run profile. */
  automation?: SandboxAutomationConfig;
  /** Clone auth for remote-provider workspaces + runner bootstrap. The selected
   *  live GitHub service credential takes precedence; App mode never falls back
   *  to a persisted token because it may be stale static authority. */
  cloneCredential?: SandboxCloneCredential;
  /** Warm-on-typing prewarm pool. Absent = defaults, with `enabled` true
   *  whenever a provider with a prewarm adapter is configured. */
  prewarm?: Partial<SandboxPrewarmConfig>;
  /** Tarball URL of the opensession runner bundle for remote bootstrap (takes
   *  precedence over the git-clone fallback). */
  runnerBundleUrl?: string;
  /** Git URL of the opensession repo for remote bootstrap (default: this
   *  checkout's origin; a release install with no checkout falls back to the
   *  public tellahq/opensession repo). */
  runnerRepoUrl?: string;
  /** Pinned sha/ref the remote bootstrap checks out (default: origin default
   *  branch, or the installed release's tag for a release install). */
  runnerSha?: string;
}

const PROVIDER_IDS = new Set<string>([
  "local",
  "docker",
  "daytona",
  "e2b",
  "box",
  "modal",
  "lambda-microvm",
]);

function asProviderId(v: unknown): SandboxProviderId | undefined {
  return typeof v === "string" && PROVIDER_IDS.has(v)
    ? (v as SandboxProviderId)
    : undefined;
}

/** False while the kill-switch file exists — new runs must stay local. */
export function sandboxesEnabled(): boolean {
  return !existsSync(DISABLE_FILE);
}

/** Current config, read fresh per call. Never throws; falls back to local. */
export function sandboxConfig(): SandboxConfig {
  try {
    const path = configPath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const perRepo: Record<string, SandboxRepoOverride> = {};
      if (raw?.perRepo && typeof raw.perRepo === "object") {
        for (const [repoId, o] of Object.entries<any>(raw.perRepo)) {
          const provider = asProviderId(o?.provider);
          const image = typeof o?.image === "string" ? o.image : undefined;
          if (provider || image) perRepo[repoId] = { provider, image };
        }
      }
      const previewPorts = Array.isArray(raw?.previewPorts)
        ? raw.previewPorts.filter(
            (p: unknown): p is number =>
              typeof p === "number" &&
              Number.isInteger(p) &&
              p > 0 &&
              p < 65536,
          )
        : [];
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;
      return {
        provider: asProviderId(raw?.provider) || "local",
        sessionDefault:
          raw?.sessionDefault === "none"
            ? "none"
            : isRunnableSandboxProvider(raw?.sessionDefault)
              ? raw.sessionDefault
              : undefined,
        image: typeof raw?.image === "string" ? raw.image : undefined,
        idleStopMinutes:
          typeof raw?.idleStopMinutes === "number" && raw.idleStopMinutes > 0
            ? raw.idleStopMinutes
            : undefined,
        cpus:
          typeof raw?.cpus === "number" && raw.cpus > 0 ? raw.cpus : undefined,
        memory:
          typeof raw?.memory === "string" &&
          /^\d+(\.\d+)?[kmg]b?$/i.test(raw.memory.trim())
            ? raw.memory.trim()
            : undefined,
        workspace: raw?.workspace === "volume" ? "volume" : undefined,
        previewPorts: previewPorts.length ? previewPorts : undefined,
        snapshots:
          raw?.snapshots && typeof raw.snapshots === "object"
            ? {
                enabled: raw.snapshots.enabled === true,
                onIdle: raw.snapshots.onIdle !== false,
                maxPerSession:
                  typeof raw.snapshots.maxPerSession === "number" &&
                  raw.snapshots.maxPerSession >= 1
                    ? Math.floor(raw.snapshots.maxPerSession)
                    : SNAPSHOT_DEFAULTS.maxPerSession,
                quickSyncOnRestore: raw.snapshots.quickSyncOnRestore !== false,
              }
            : undefined,
        perRepo: Object.keys(perRepo).length ? perRepo : undefined,
        transport: raw?.transport === "ws" ? "ws" : undefined,
        callbackBaseUrl: str(raw?.callbackBaseUrl),
        publicIngress:
          raw?.publicIngress && typeof raw.publicIngress === "object"
            ? {
                enabled: raw.publicIngress.enabled === true,
                port:
                  typeof raw.publicIngress.port === "number" &&
                  Number.isInteger(raw.publicIngress.port) &&
                  raw.publicIngress.port > 0 &&
                  raw.publicIngress.port < 65536
                    ? raw.publicIngress.port
                    : PUBLIC_INGRESS_DEFAULT_PORT,
                host: str(raw.publicIngress.host) || "127.0.0.1",
              }
            : undefined,
        e2b:
          raw?.e2b && typeof raw.e2b === "object"
            ? { apiKey: str(raw.e2b.apiKey), template: str(raw.e2b.template) }
            : undefined,
        awsLambdaMicrovm:
          raw?.awsLambdaMicrovm && typeof raw.awsLambdaMicrovm === "object"
            ? {
                imageIdentifier: str(raw.awsLambdaMicrovm.imageIdentifier),
                imageVersion: str(raw.awsLambdaMicrovm.imageVersion),
                executionRoleArn: str(raw.awsLambdaMicrovm.executionRoleArn),
                region: str(raw.awsLambdaMicrovm.region),
                ingressConnectorArn: str(
                  raw.awsLambdaMicrovm.ingressConnectorArn,
                ),
                egressConnectorArn: str(
                  raw.awsLambdaMicrovm.egressConnectorArn,
                ),
                controlPort:
                  typeof raw.awsLambdaMicrovm.controlPort === "number" &&
                  Number.isInteger(raw.awsLambdaMicrovm.controlPort) &&
                  raw.awsLambdaMicrovm.controlPort > 0 &&
                  raw.awsLambdaMicrovm.controlPort < 65536
                    ? raw.awsLambdaMicrovm.controlPort
                    : undefined,
                maximumDurationSeconds:
                  typeof raw.awsLambdaMicrovm.maximumDurationSeconds ===
                    "number" && raw.awsLambdaMicrovm.maximumDurationSeconds > 0
                    ? Math.min(
                        28_800,
                        Math.floor(raw.awsLambdaMicrovm.maximumDurationSeconds),
                      )
                    : undefined,
                idleSuspendSeconds:
                  typeof raw.awsLambdaMicrovm.idleSuspendSeconds === "number" &&
                  raw.awsLambdaMicrovm.idleSuspendSeconds >= 60
                    ? Math.min(
                        28_800,
                        Math.floor(raw.awsLambdaMicrovm.idleSuspendSeconds),
                      )
                    : undefined,
                suspendedDurationSeconds:
                  typeof raw.awsLambdaMicrovm.suspendedDurationSeconds ===
                    "number" &&
                  raw.awsLambdaMicrovm.suspendedDurationSeconds > 0
                    ? Math.floor(raw.awsLambdaMicrovm.suspendedDurationSeconds)
                    : undefined,
                logGroup: str(raw.awsLambdaMicrovm.logGroup),
              }
            : undefined,
        automation:
          raw?.automation && typeof raw.automation === "object"
            ? {
                provider: "daytona",
                egressAllowlist: Array.isArray(raw.automation.egressAllowlist)
                  ? raw.automation.egressAllowlist
                      .filter(
                        (value: unknown): value is string =>
                          typeof value === "string" &&
                          value.trim().length > 0 &&
                          value.trim().length <= 512,
                      )
                      .map((value: string) => value.trim())
                      .slice(0, 128)
                  : undefined,
              }
            : undefined,
        cloneCredential:
          raw?.cloneCredential?.type === "https-token" ||
          raw?.cloneCredential?.type === "none"
            ? {
                type: raw.cloneCredential.type,
                token: str(raw.cloneCredential.token),
              }
            : undefined,
        prewarm:
          raw?.prewarm && typeof raw.prewarm === "object"
            ? {
                enabled:
                  typeof raw.prewarm.enabled === "boolean"
                    ? raw.prewarm.enabled
                    : undefined,
                ttlMinutes:
                  typeof raw.prewarm.ttlMinutes === "number" &&
                  raw.prewarm.ttlMinutes > 0
                    ? raw.prewarm.ttlMinutes
                    : undefined,
                maxLive:
                  typeof raw.prewarm.maxLive === "number" &&
                  raw.prewarm.maxLive >= 1
                    ? Math.floor(raw.prewarm.maxLive)
                    : undefined,
                keepReady: Array.isArray(raw.prewarm.keepReady)
                  ? raw.prewarm.keepReady
                      .filter(
                        (
                          target: unknown,
                        ): target is { provider: string; repoId: string } =>
                          Boolean(
                            target &&
                            typeof target === "object" &&
                            typeof (target as any).provider === "string" &&
                            typeof (target as any).repoId === "string",
                          ),
                      )
                      .map((target: { provider: string; repoId: string }) => ({
                        provider: target.provider.trim(),
                        repoId: target.repoId.trim(),
                      }))
                  : undefined,
              }
            : undefined,
        runnerBundleUrl: str(raw?.runnerBundleUrl),
        runnerRepoUrl: str(raw?.runnerRepoUrl),
        runnerSha: str(raw?.runnerSha),
      };
    }
  } catch {}
  return { provider: "local" };
}

/**
 * Effective provider id for a session in `repoId`, honoring the kill switch
 * and per-repo overrides. Missing config, disabled sandboxes, or garbage in
 * the file all resolve to "local".
 */
export function effectiveSandboxProvider(repoId?: string): SandboxProviderId {
  if (!sandboxesEnabled()) return "local";
  const cfg = sandboxConfig();
  return (repoId && cfg.perRepo?.[repoId]?.provider) || cfg.provider || "local";
}

/** Effective snapshot settings — the config's `snapshots` block over the
 *  defaults; a missing block = the defaults with `enabled: false`. */
export function sandboxSnapshots(): SandboxSnapshotsConfig {
  return sandboxConfig().snapshots || SNAPSHOT_DEFAULTS;
}

/** Effective warm-on-typing prewarm settings (prewarm.ts pool). `enabled`
 *  defaults to true exactly when a provider with an implemented adapter is
 *  configured — a docker-only or unconfigured setup stays inert. */
export function sandboxPrewarmConfig(): SandboxPrewarmConfig {
  const cfg = sandboxConfig();
  const prewarmProviderConfigured =
    sandboxConfigPresent() &&
    Boolean(
      normalizedConnectionConfigured("daytona") === true ||
      normalizedConnectionConfigured("box") === true ||
      cfg.e2b?.apiKey ||
      process.env.E2B_API_KEY ||
      sandboxProviderConfigured("modal"),
    );
  return {
    enabled: cfg.prewarm?.enabled ?? prewarmProviderConfigured,
    ttlMinutes: cfg.prewarm?.ttlMinutes ?? PREWARM_DEFAULTS.ttlMinutes,
    maxLive: cfg.prewarm?.maxLive ?? PREWARM_DEFAULTS.maxLive,
    keepReady: Array.isArray(cfg.prewarm?.keepReady)
      ? cfg.prewarm.keepReady.filter(
          (target): target is { provider: string; repoId: string } =>
            typeof target?.provider === "string" &&
            typeof target?.repoId === "string",
        )
      : PREWARM_DEFAULTS.keepReady,
  };
}

/** Effective run transport (docker honors the config; remote providers pass
 *  their own "ws" regardless). */
export function sandboxTransport(): SandboxTransport {
  return sandboxConfig().transport === "ws" ? "ws" : "socket";
}

/** Effective unattended-run policy. The provider is deliberately not a
 *  generic selector: Daytona is the only backend whose per-sandbox outbound
 *  policy Open Session can install and verify before a run starts. */
export function sandboxAutomationConfig(): SandboxAutomationConfig {
  return sandboxConfig().automation || { provider: "daytona" };
}

export interface SandboxAutomationAvailability {
  provider: "daytona";
  available: boolean;
  /** Operator-facing reason when unavailable. */
  reason?: string;
}

/** Whether a sandboxed automation can be created, updated, or launched right
 *  now. Fails closed on every provider gate an interactive Daytona session
 *  also passes through, plus the dial-back URL a detached run needs. */
export function sandboxAutomationAvailability(): SandboxAutomationAvailability {
  const provider = sandboxAutomationConfig().provider;
  const error = sandboxProviderSelectionError(provider);
  if (error) return { provider, available: false, reason: error };
  if (!sandboxConfig().callbackBaseUrl && !configuredIngress().publicBaseUrl) {
    return {
      provider,
      available: false,
      reason:
        "sandbox automations need a dial-back URL: set callbackBaseUrl or enable public ingress in Workspace > Sandboxes",
    };
  }
  return { provider, available: true };
}

// ── Provider capability status (per-session provider picker) ────────────────

/** The providers a session can explicitly pick ("local" = no sandbox). */
export const RUNNABLE_SANDBOX_PROVIDERS = [
  "docker",
  "daytona",
  "e2b",
  "box",
  "modal",
  "lambda-microvm",
] as const;
export type RunnableSandboxProviderId =
  (typeof RUNNABLE_SANDBOX_PROVIDERS)[number];

export interface SandboxProviderCertification {
  certified: boolean;
  /** Complete engine/exec/preview/lifecycle matrix. */
  behavioralPassedAt?: string;
  /** Provider-native post-setup warm restore, including credential scrub. */
  warmRestorePassedAt?: string;
  lastPassedAt?: string;
  note?: string;
}

/** Certification is derived, never hand-asserted: both independent live
 * evidence dates must exist before a provider can be selected or defaulted. */
function certification(
  evidence: Omit<SandboxProviderCertification, "certified" | "lastPassedAt">,
): SandboxProviderCertification {
  const passed = Boolean(
    evidence.behavioralPassedAt && evidence.warmRestorePassedAt,
  );
  const dates = [
    evidence.behavioralPassedAt,
    evidence.warmRestorePassedAt,
  ].filter((date): date is string => Boolean(date));
  return {
    ...evidence,
    certified: passed,
    ...(passed ? { lastPassedAt: dates.sort().at(-1) } : {}),
  };
}

export const SANDBOX_PROVIDER_CERTIFICATIONS: Record<
  RunnableSandboxProviderId,
  SandboxProviderCertification
> = {
  docker: certification({
    behavioralPassedAt: "2026-08-11",
    warmRestorePassedAt: "2026-08-11",
    note: "live socket/WebSocket, Portal, lifecycle, and Docker commit/restore matrices passed",
  }),
  daytona: certification({
    behavioralPassedAt: "2026-08-11",
    warmRestorePassedAt: "2026-08-11",
    note: "live provider snapshot restore and full remote-run matrix passed",
  }),
  e2b: certification({
    note: "live matrix has not run on a funded E2B account",
  }),
  box: certification({
    behavioralPassedAt: "2026-08-13",
    warmRestorePassedAt: "2026-08-13",
    note: "live remote-run, lifecycle, and named-snapshot restore matrix passed; Box serializes concurrent command admission per VM",
  }),
  modal: certification({
    behavioralPassedAt: "2026-08-11",
    warmRestorePassedAt: "2026-08-11",
    note: "live filesystem-image restore and full remote-run matrix passed",
  }),
  "lambda-microvm": certification({
    note: "live matrix has not run against a provisioned Lambda MicroVM image",
  }),
};

export function sandboxProviderCertified(
  id: RunnableSandboxProviderId,
): boolean {
  return SANDBOX_PROVIDER_CERTIFICATIONS[id].certified;
}

/** Persist the Workspace-wide default without rewriting any provider secrets
 * or other sandbox configuration. "none" is both the UI and storage default. */
export function setWorkspaceSandboxDefault(
  value: string,
): RunnableSandboxProviderId | "none" {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "none" && !isRunnableSandboxProvider(normalized)) {
    throw new Error(`Unknown sandbox provider "${value}"`);
  }
  if (
    normalized !== "none" &&
    sandboxProviderUsability(normalized).state !== "usable"
  ) {
    throw new Error(
      `Sandbox provider "${normalized}" is not currently available`,
    );
  }
  const path = configPath();
  // Absence already means None; do not create a config file merely to record
  // the default, because config-file presence is the sandbox feature gate.
  if (normalized === "none" && !existsSync(path)) return "none";
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      raw = parsed;
  } catch {}
  raw.sessionDefault = normalized;
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, raw);
  return normalized as RunnableSandboxProviderId | "none";
}

export function isRunnableSandboxProvider(
  v: unknown,
): v is RunnableSandboxProviderId {
  return (
    typeof v === "string" &&
    (RUNNABLE_SANDBOX_PROVIDERS as readonly string[]).includes(v)
  );
}

/** Remote providers have no host mounts — their workspaces are ALWAYS
 *  volume-style (cloned inside the sandbox; no host fallback for runs). */
export function isRemoteSandboxProvider(
  v: unknown,
): v is "daytona" | "e2b" | "box" | "modal" | "lambda-microvm" {
  return (
    v === "daytona" ||
    v === "e2b" ||
    v === "box" ||
    v === "modal" ||
    v === "lambda-microvm"
  );
}

/** Providers whose service ports cannot be reached from the Open Session host
 * and therefore need the authenticated outbound HTTP/WebSocket Portal relay.
 * The self-hosted MicroVM adapter has a private host path and deliberately
 * stays on the direct branch, just like Docker. */
export function usesOutboundSandboxPortalRelay(v: unknown): boolean {
  return (
    v === "daytona" ||
    v === "e2b" ||
    v === "box" ||
    v === "modal" ||
    v === "lambda-microvm"
  );
}

/** True when a sandbox config file exists and parses — the operator has set
 *  sandboxing up at all. Without it every provider is unconfigured. */
function sandboxConfigPresent(): boolean {
  try {
    const path = configPath();
    if (!existsSync(path)) return false;
    JSON.parse(readFileSync(path, "utf-8"));
    return true;
  } catch {
    return false;
  }
}

/** A normalized connection is authoritative when present. Kept as a small
 * raw read here (rather than importing connections.ts) to avoid a config ↔
 * connection parsing cycle. Secret existence is enforced by the connection
 * API/default layer and again when an SDK client is constructed. */
interface NormalizedConnectionSelection {
  enabled: boolean;
  qualification?: "checking" | "ready" | "failed";
}

function normalizedConnectionSelection(
  id: RunnableSandboxProviderId,
): NormalizedConnectionSelection | undefined {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    const values = Array.isArray(raw?.connections)
      ? raw.connections
      : raw?.connections && typeof raw.connections === "object"
        ? Object.values(raw.connections)
        : [];
    const connection = values.find(
      (value: any) => value?.provider === id,
    ) as any;
    if (!connection) return undefined;
    const qualification = connection.qualification?.status;
    return {
      enabled: connection.enabled !== false,
      ...(qualification === "checking" ||
      qualification === "ready" ||
      qualification === "failed"
        ? { qualification }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function normalizedConnectionConfigured(
  id: RunnableSandboxProviderId,
): boolean | undefined {
  return normalizedConnectionSelection(id)?.enabled;
}

export interface SandboxProviderStatusEntry {
  id: RunnableSandboxProviderId;
  configured: boolean;
  /** Authoritative selection state for new sessions. */
  usability: SandboxProviderUsability["state"];
  /** Only live-certified providers are selectable for new sessions. */
  certified: boolean;
  lastPassedAt?: string;
  /** Human caveat shown ONLY when something is actually missing (e.g. a remote
   *  provider with no dial-back URL configured). Healthy providers carry no
   *  note — the UI renders it as a dim hint line under the picker row. */
  note?: string;
}

// ── Model-family sandboxability ───────────────────────────────────────────────
//
// Every certified provider runs the same brain-inside payload. Capability is
// therefore a model-family property, never a provider matrix: native Codex is
// the sole exception because its writable rotating CODEX_HOME cannot safely be
// copied. The picker consumes this same list and create paths enforce it.

export interface SandboxModelFamily {
  id: string;
  /** Human name for warnings. */
  label: string;
  match: { provider: "claude" | "codex" | "pi" };
  sandboxable: boolean;
  hint?: string;
}

export const SANDBOX_MODEL_FAMILIES: SandboxModelFamily[] = [
  {
    id: "pi",
    label: "Pi",
    match: { provider: "pi" },
    sandboxable: true,
  },
  {
    // Native Codex runs need a writable CODEX_HOME (refresh-token rotation) —
    // deliberately never mounted or uploaded into sandboxes. GPT-in-a-sandbox
    // goes through pi/openai/* instead.
    id: "codex",
    label: "GPT (Codex)",
    match: { provider: "codex" },
    sandboxable: false,
    hint: "Codex account state stays on the host; use an pi/openai/* or pi/openai/* model for GPT in a sandbox",
  },
  {
    id: "claude",
    label: "Claude",
    match: { provider: "claude" },
    sandboxable: true,
  },
];

/** The family a model (or the current default) falls into. */
export function sandboxModelFamilyFor(
  model?: string | null,
): SandboxModelFamily {
  const raw = (model || "").trim() || getDefaultModel();
  const canonical = resolveModel(raw)?.id ?? raw;
  const provider = providerFor(canonical);
  return (
    SANDBOX_MODEL_FAMILIES.find(
      (family) => family.match.provider === provider,
    ) ?? SANDBOX_MODEL_FAMILIES[SANDBOX_MODEL_FAMILIES.length - 1]
  );
}

/** Provider-independent sandbox gate. */
export function sandboxableModelFamily(
  model: string | undefined | null,
): { ok: true } | { ok: false; error: string } {
  const family = sandboxModelFamilyFor(model);
  if (family.sandboxable) return { ok: true };
  return {
    ok: false,
    error:
      `${family.label} models can't run in a sandbox` +
      (family.hint ? ` — ${family.hint}` : "") +
      ".",
  };
}

/** Shape served by GET /api/sandbox/status (read fresh per call). */
export interface SandboxCapabilityStatus {
  /** A sandbox config file exists — the control surface is worth showing. */
  enabled: boolean;
  /** What `sandbox: true` resolves to (the config's default provider). */
  defaultProvider: SandboxProviderId;
  providers: SandboxProviderStatusEntry[];
  /** disable-sandboxes kill-switch file present — runs stay on the host. */
  killSwitch: boolean;
  /** Provider-independent family sandboxability for the NewSession picker. */
  modelFamilies: SandboxModelFamily[];
  /** Whether automations may opt into a disposable Executor right now. */
  automation: SandboxAutomationAvailability;
}

function sandboxProviderSelectionError(
  id: RunnableSandboxProviderId,
): string | undefined {
  const usability = sandboxProviderUsability(id);
  if (usability.state === "usable") return undefined;
  if (usability.state === "unqualified") {
    return `Sandbox provider "${id}" has not passed workspace qualification. Test it in Workspace > Sandboxes first.`;
  }
  if (usability.state === "unavailable") {
    if (!sandboxProviderCertified(id)) {
      const certification = SANDBOX_PROVIDER_CERTIFICATIONS[id];
      return `Sandbox provider "${id}" is not live-certified and is unavailable for new sessions: ${certification.note || "run its complete live conformance matrix first"}.`;
    }
    return `Sandbox provider "${id}" is not currently available.`;
  }
  const hint =
    id === "docker"
      ? "run opensession sandbox enable docker"
      : id === "daytona"
        ? "connect Daytona in Workspace > Sandboxes"
        : id === "box"
          ? "connect Box in Workspace > Sandboxes"
          : id === "modal"
            ? "connect Modal in Workspace > Sandboxes"
            : id === "lambda-microvm"
              ? 'set {"awsLambdaMicrovm":{"imageIdentifier":"arn:aws:lambda:...:microvm-image/..."}} in ~/.opensession-sandbox.json'
              : 'set {"e2b":{"apiKey":"..."}} in ~/.opensession-sandbox.json (or E2B_API_KEY)';
  return `Sandbox provider "${id}" is not configured: ${hint}.`;
}

/** Whether the provider has enabled connection configuration. */
export function sandboxProviderConfigured(
  id: RunnableSandboxProviderId,
): boolean {
  if (!sandboxConfigPresent()) return false;
  const normalized = normalizedConnectionConfigured(id);
  if (normalized !== undefined) return normalized;
  const cfg = sandboxConfig();
  if (id === "docker" || id === "daytona" || id === "box" || id === "modal") {
    return false;
  }
  if (id === "lambda-microvm")
    return Boolean(cfg.awsLambdaMicrovm?.imageIdentifier);
  return Boolean(cfg.e2b?.apiKey || process.env.E2B_API_KEY);
}

/** Single fail-closed authority for selecting a provider for new work. */
export function sandboxProviderUsability(
  id: RunnableSandboxProviderId,
): SandboxProviderUsability {
  const connection = normalizedConnectionSelection(id);
  if (connection && !connection.enabled) {
    return { state: "unavailable", configured: true, usable: false };
  }
  if (!sandboxProviderConfigured(id)) {
    return { state: "not_configured", configured: false, usable: false };
  }
  if (!sandboxesEnabled() || !sandboxProviderCertified(id)) {
    return { state: "unavailable", configured: true, usable: false };
  }
  if (connection && connection.qualification !== "ready") {
    return { state: "unqualified", configured: true, usable: false };
  }
  return { state: "usable", configured: true, usable: true };
}

/** Full provider-capability snapshot, read fresh from config + kill switch. */
export function sandboxCapabilityStatus(): SandboxCapabilityStatus {
  const enabled = sandboxConfigPresent();
  const cfg = sandboxConfig();
  const daytonaConfigured =
    enabled && normalizedConnectionConfigured("daytona") === true;
  const e2bConfigured =
    enabled && Boolean(cfg.e2b?.apiKey || process.env.E2B_API_KEY);
  const boxConfigured =
    enabled && normalizedConnectionConfigured("box") === true;
  const modalConfigured =
    enabled && normalizedConnectionConfigured("modal") === true;
  const lambdaMicrovmConfigured =
    enabled && Boolean(cfg.awsLambdaMicrovm?.imageIdentifier);
  // Remote sandboxes must dial back over WS: healthy = a public-ingress URL or
  // an explicit callbackBaseUrl is configured, and then the row shows no note.
  // Only an actually-missing dial-back URL surfaces a caveat (no static
  // "unverified" scare-copy — dial-back is proven in production).
  const remoteDialBackConfigured = Boolean(
    configuredIngress().publicBaseUrl || cfg.callbackBaseUrl,
  );
  const remoteNote = remoteDialBackConfigured
    ? {}
    : {
        note: "no public ingress configured — choose an exposure method in Settings so remote sandboxes can reach this server",
      };
  const providersWithoutCertification: Array<
    Omit<SandboxProviderStatusEntry, "certified" | "lastPassedAt" | "usability">
  > = [
    {
      id: "docker",
      configured: enabled && normalizedConnectionConfigured("docker") === true,
    },
    {
      id: "daytona",
      configured: daytonaConfigured,
      ...(daytonaConfigured ? remoteNote : {}),
    },
    {
      id: "e2b",
      configured: e2bConfigured,
      ...(e2bConfigured ? remoteNote : {}),
    },
    {
      id: "box",
      configured: boxConfigured,
      ...(boxConfigured ? remoteNote : {}),
    },
    {
      id: "modal",
      configured: modalConfigured,
      ...(modalConfigured ? remoteNote : {}),
    },
    {
      id: "lambda-microvm",
      configured: lambdaMicrovmConfigured,
      ...(lambdaMicrovmConfigured ? remoteNote : {}),
    },
  ];
  const providers = providersWithoutCertification.map(
    (provider): SandboxProviderStatusEntry => {
      const certification = SANDBOX_PROVIDER_CERTIFICATIONS[provider.id];
      const usability = sandboxProviderUsability(provider.id);
      const notes = [
        provider.note,
        usability.state === "unqualified"
          ? "has not passed workspace qualification"
          : undefined,
        !certification.certified && usability.configured
          ? `not available for new sessions — ${certification.note || "live matrix has not passed"}`
          : undefined,
      ].filter((note): note is string => Boolean(note));
      return {
        ...provider,
        configured: usability.configured,
        usability: usability.state,
        certified: certification.certified,
        ...(certification.lastPassedAt
          ? { lastPassedAt: certification.lastPassedAt }
          : {}),
        ...(notes.length ? { note: notes.join("; ") } : {}),
      };
    },
  );
  const configuredDefault = cfg.provider || "local";
  const defaultProvider =
    configuredDefault !== "local" &&
    isRunnableSandboxProvider(configuredDefault) &&
    sandboxProviderUsability(configuredDefault).state === "usable"
      ? configuredDefault
      : "local";
  return {
    enabled,
    defaultProvider,
    providers,
    killSwitch: !sandboxesEnabled(),
    modelFamilies: SANDBOX_MODEL_FAMILIES,
    automation: sandboxAutomationAvailability(),
  };
}

/**
 * Resolve a create-path `sandbox` request (boolean | provider string) to the
 * provider to persist on the session, validating explicit picks against the
 * current config. `true` keeps today's behavior (config default provider);
 * a string must name a configured provider or the create fails with a clear
 * error. Returns `provider: null` for "no sandbox".
 *
 * `model` (the create's model pick; ""/undefined = the current default) is
 * checked against the provider-independent family gate so native Codex fails
 * AT CREATE with the same message the UI pre-warns with.
 */
export function resolveRequestedSandbox(
  requested: boolean | string | undefined | null,
  repoId?: string,
  model?: string | null,
):
  | { ok: true; provider: SandboxProviderId | null }
  | { ok: false; error: string } {
  const withModelCheck = (
    provider: SandboxProviderId | null,
  ):
    | { ok: true; provider: SandboxProviderId | null }
    | { ok: false; error: string } => {
    if (!provider || provider === "local") return { ok: true, provider };
    if (isRunnableSandboxProvider(provider)) {
      const error = sandboxProviderSelectionError(provider);
      if (error) return { ok: false, error };
    }
    const support = sandboxableModelFamily(model);
    return support.ok ? { ok: true, provider } : support;
  };
  if (!requested) return { ok: true, provider: null };
  if (requested === true)
    return withModelCheck(effectiveSandboxProvider(repoId));
  const id = String(requested).trim().toLowerCase();
  if (id === "local") return { ok: true, provider: null }; // explicit "host"
  if (!isRunnableSandboxProvider(id)) {
    return {
      ok: false,
      error: `Unknown sandbox provider "${requested}" — valid values: docker, daytona, e2b, box, modal, microvm, lambda-microvm (or true for the configured default).`,
    };
  }
  return withModelCheck(id);
}

/**
 * The base URL sandboxes dial back to (run-ws / rpc-ws routes). Config value
 * wins; the fallback derives from the server's bind env (HOST:PORT — the same
 * defaults opensession.ts uses). http(s) schemes are normalized to ws(s).
 * NOTE: a 127.0.0.1 default is unreachable from any sandbox — ws-transport
 * setups should set callbackBaseUrl explicitly (Tailscale URL for remote
 * providers; the docker bridge can reach the host's tailnet/LAN bind).
 */
export function sandboxCallbackBaseUrl(): string {
  const cfg = sandboxConfig();
  let base =
    cfg.callbackBaseUrl ||
    `ws://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "3850"}`;
  return normalizeWsBase(base);
}

function normalizeWsBase(base: string): string {
  return base.replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "");
}

/** The publicIngress block when it's actually enabled, else null. */
export function publicIngressConfig(): SandboxPublicIngressConfig | null {
  const pi = sandboxConfig().publicIngress;
  return pi?.enabled ? pi : null;
}

/**
 * The base URL remote-provider sandboxes dial back to: the
 * public-ingress URL when the isolated public listener is enabled and has a
 * publicBaseUrl, else the plain callbackBaseUrl (tailnet/self-hosted setups
 * where the sandbox can reach the main bind directly). Docker sandboxes never
 * use this — they stay on sandboxCallbackBaseUrl (the internal bridge path).
 */
export function remoteSandboxCallbackBaseUrl(): string {
  const ingress = configuredIngress().publicBaseUrl;
  if (ingress) return normalizeWsBase(ingress);
  return sandboxCallbackBaseUrl();
}
