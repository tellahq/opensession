/**
 * Sandbox configuration.
 *
 * `~/.opensession/sandbox.json` holds the workspace's sandbox settings. The
 * provider connections (Daytona, Box) live in its `connections` array and are
 * managed from Workspace → Sandboxes; everything else here is small operator
 * plumbing: the dial-back URL, the clone credential, the runner pin, and the
 * warm-on-typing pool.
 *
 * Read fresh on every call so a config change applies to the next run without
 * a restart. Missing/invalid config = provider "local" = host sessions only.
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
import { workspaceSecretExists } from "../workspace-secrets";
import { sandboxAdapterSignatureCurrent } from "./adapter-signature";
import type { SandboxProviderId, SandboxProviderUsability } from "./provider";

// Env-overridable so the verify suite (and unit tests) can point a scratch
// config at a scratch setup without touching the live file (which is read
// fresh per run). Read per call, not at module load, so a test can flip the
// env var without re-importing this module.
function configPath(): string {
  return process.env.OPENSESSION_SANDBOX_CONFIG || stateDir("sandbox.json");
}

export function sandboxConfigPath(): string {
  return configPath();
}
const DISABLE_FILE = `${OPENSESSION_SESSIONS_DIR}/disable-sandboxes`;

export interface SandboxRepoOverride {
  provider?: SandboxProviderId;
}

/** How remote providers authenticate `git clone` inside the sandbox (they
 *  can't mount host creds). "none" = public clone; "https-token" injects the
 *  token into the https URL (GitHub App token / x-access-token). */
export interface SandboxCloneCredential {
  type: "none" | "https-token";
  token?: string;
}

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
  /** Stop idle sandboxes after this many minutes; unset = provider default (30). */
  idleStopMinutes?: number;
  /** Machine shape overlaid from a provider connection's settings, never read
   *  from the file (see daytona.ts's daytonaConfig). */
  cpus?: number;
  memory?: string;
  /** Per-repo overrides keyed by repo id (worktree.ts REPOS). */
  perRepo?: Record<string, SandboxRepoOverride>;
  /**
   * Base URL sandboxes dial back to for the WS transport, e.g.
   * "wss://ingress.example.com" (http(s) is normalized to ws(s)). Default is
   * derived from the server's bind (HOST:PORT env). MUST be reachable FROM the
   * sandbox: a publicly/tailnet-reachable URL (self-hosters: your Tailscale
   * ts.net URL or a tunnel).
   */
  callbackBaseUrl?: string;
  /** Public dial-back listener for remote providers (absent = disabled). */
  publicIngress?: SandboxPublicIngressConfig;
  /** Daytona adapter (provider "daytona"). */
  daytona?: SandboxDaytonaConfig;
  /** Credential-minimal unattended-run profile. */
  automation?: SandboxAutomationConfig;
  /** Clone auth for remote-provider workspaces + runner bootstrap. The selected
   *  live GitHub service credential takes precedence; App mode never falls back
   *  to a persisted token because it may be stale static authority. */
  cloneCredential?: SandboxCloneCredential;
  /** Warm-on-typing prewarm pool. Absent = defaults, with `enabled` true
   *  whenever a provider connection is configured. */
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

const PROVIDER_IDS = new Set<string>(["local", "daytona", "box"]);

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
          if (provider) perRepo[repoId] = { provider };
        }
      }
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
        idleStopMinutes:
          typeof raw?.idleStopMinutes === "number" && raw.idleStopMinutes > 0
            ? raw.idleStopMinutes
            : undefined,
        perRepo: Object.keys(perRepo).length ? perRepo : undefined,
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

/** Effective warm-on-typing prewarm settings (prewarm.ts pool). `enabled`
 *  defaults to true exactly when a provider connection is configured. */
export function sandboxPrewarmConfig(): SandboxPrewarmConfig {
  const cfg = sandboxConfig();
  const prewarmProviderConfigured =
    sandboxConfigPresent() &&
    RUNNABLE_SANDBOX_PROVIDERS.some(
      (id) => normalizedConnectionConfigured(id) === true,
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
export const RUNNABLE_SANDBOX_PROVIDERS = ["daytona", "box"] as const;
export type RunnableSandboxProviderId =
  (typeof RUNNABLE_SANDBOX_PROVIDERS)[number];

/** Provider ids Open Session once shipped. A persisted session may still name
 *  one; it can no longer be selected, woken, or recreated. */
export const RETIRED_SANDBOX_PROVIDERS = new Set<string>([
  "docker",
  "e2b",
  "modal",
  "microvm",
  "lambda-microvm",
]);

export function isRetiredSandboxProvider(v: unknown): boolean {
  return typeof v === "string" && RETIRED_SANDBOX_PROVIDERS.has(v);
}

export interface SandboxProviderCertification {
  certified: boolean;
  /** Complete engine/exec/Portal/lifecycle matrix. */
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
  daytona: certification({
    behavioralPassedAt: "2026-08-11",
    warmRestorePassedAt: "2026-08-11",
    note: "live provider snapshot restore and full remote-run matrix passed",
  }),
  box: certification({
    behavioralPassedAt: "2026-08-13",
    warmRestorePassedAt: "2026-08-13",
    note: "live remote-run, lifecycle, and named-snapshot restore matrix passed; Box serializes concurrent command admission per VM",
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
): v is RunnableSandboxProviderId {
  return isRunnableSandboxProvider(v);
}

/** Providers whose service ports cannot be reached from the Open Session host
 * and therefore need the authenticated outbound HTTP/WebSocket Portal relay.
 * Every supported Sandbox provider is remote, so this is every Sandbox. */
export function usesOutboundSandboxPortalRelay(v: unknown): boolean {
  return isRunnableSandboxProvider(v);
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
  /** True when the stored qualification matches the current adapter and the
   *  referenced workspace secret still exists: the same test Workspace >
   *  Sandboxes uses to call a connection Ready. */
  current: boolean;
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
    const credentialRef =
      typeof connection.credentialRef === "string"
        ? connection.credentialRef
        : undefined;
    const current =
      sandboxAdapterSignatureCurrent(
        id,
        connection.qualification?.adapterSignature,
      ) && Boolean(credentialRef && workspaceSecretExists(credentialRef));
    return {
      enabled: connection.enabled !== false,
      current,
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
    hint: "Codex account state stays on the host; use a pi/openai/* model for GPT in a Sandbox",
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
      `${family.label} models can't run in a Sandbox` +
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
    return `Sandbox provider "${id}" needs attention in Workspace > Sandboxes. Test the connection there first.`;
  }
  if (usability.state === "unavailable") {
    if (!sandboxProviderCertified(id)) {
      const certification = SANDBOX_PROVIDER_CERTIFICATIONS[id];
      return `Sandbox provider "${id}" is not live-certified and is unavailable for new sessions: ${certification.note || "run its complete live conformance matrix first"}.`;
    }
    return `Sandbox provider "${id}" is not currently available.`;
  }
  return `Sandbox provider "${id}" is not configured: connect ${id === "box" ? "Box" : "Daytona"} in Workspace > Sandboxes.`;
}

/** Whether the provider has enabled connection configuration. */
export function sandboxProviderConfigured(
  id: RunnableSandboxProviderId,
): boolean {
  if (!sandboxConfigPresent()) return false;
  return normalizedConnectionConfigured(id) === true;
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
  if (
    connection &&
    (connection.qualification !== "ready" || !connection.current)
  ) {
    return { state: "unqualified", configured: true, usable: false };
  }
  return { state: "usable", configured: true, usable: true };
}

/** Full provider-capability snapshot, read fresh from config + kill switch. */
export function sandboxCapabilityStatus(): SandboxCapabilityStatus {
  const enabled = sandboxConfigPresent();
  const cfg = sandboxConfig();
  // Remote sandboxes must dial back over WS: healthy = a public-ingress URL or
  // an explicit callbackBaseUrl is configured, and then the row shows no note.
  // Only an actually-missing dial-back URL surfaces a caveat.
  const remoteDialBackConfigured = Boolean(
    configuredIngress().publicBaseUrl || cfg.callbackBaseUrl,
  );
  const remoteNote = remoteDialBackConfigured
    ? undefined
    : "no public ingress configured — choose an exposure method in Settings so remote sandboxes can reach this server";
  const providers = RUNNABLE_SANDBOX_PROVIDERS.map(
    (id): SandboxProviderStatusEntry => {
      const configured = enabled && normalizedConnectionConfigured(id) === true;
      const certification = SANDBOX_PROVIDER_CERTIFICATIONS[id];
      const usability = sandboxProviderUsability(id);
      const notes = [
        configured ? remoteNote : undefined,
        usability.state === "unqualified"
          ? "needs attention in Workspace > Sandboxes"
          : undefined,
        !certification.certified && usability.configured
          ? `not available for new sessions — ${certification.note || "live matrix has not passed"}`
          : undefined,
      ].filter((note): note is string => Boolean(note));
      return {
        id,
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
 * current config. `true` means "a Sandbox": the workspace default provider,
 * or the only usable one when no default is set. A string must name a
 * configured provider or the create fails with a clear error. Returns
 * `provider: null` for "no sandbox".
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
  if (requested === true) {
    const provider = anySandboxProvider(repoId);
    if (!provider)
      return {
        ok: false,
        error:
          "No Sandbox provider is ready. Connect Daytona or Box in Workspace > Sandboxes.",
      };
    return withModelCheck(provider);
  }
  const id = String(requested).trim().toLowerCase();
  if (id === "local") return { ok: true, provider: null }; // explicit "host"
  if (isRetiredSandboxProvider(id)) {
    return {
      ok: false,
      error: `Sandbox provider "${requested}" has been retired — valid values: daytona, box (or true for the workspace's Sandbox).`,
    };
  }
  if (!isRunnableSandboxProvider(id)) {
    return {
      ok: false,
      error: `Unknown sandbox provider "${requested}" — valid values: daytona, box (or true for the workspace's Sandbox).`,
    };
  }
  return withModelCheck(id);
}

/**
 * The provider "a Sandbox" means for this workspace: the per-repo override,
 * then the workspace session default, then the config's default provider,
 * then the single usable connection. Null when nothing is usable.
 */
export function anySandboxProvider(
  repoId?: string,
): RunnableSandboxProviderId | null {
  if (!sandboxesEnabled()) return null;
  const cfg = sandboxConfig();
  const usable = (id: unknown): id is RunnableSandboxProviderId =>
    isRunnableSandboxProvider(id) &&
    sandboxProviderUsability(id).state === "usable";
  const preferred = [
    repoId ? cfg.perRepo?.[repoId]?.provider : undefined,
    cfg.sessionDefault,
    cfg.provider,
  ];
  for (const candidate of preferred) if (usable(candidate)) return candidate;
  return RUNNABLE_SANDBOX_PROVIDERS.find(usable) ?? null;
}

/**
 * The base URL sandboxes dial back to (run-ws / rpc-ws routes). Config value
 * wins; the fallback derives from the server's bind env (HOST:PORT — the same
 * defaults opensession.ts uses). http(s) schemes are normalized to ws(s).
 * NOTE: a 127.0.0.1 default is unreachable from any sandbox — set
 * callbackBaseUrl explicitly (Tailscale URL for remote providers).
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
 * where the sandbox can reach the main bind directly).
 */
export function remoteSandboxCallbackBaseUrl(): string {
  const ingress = configuredIngress().publicBaseUrl;
  if (ingress) return normalizeWsBase(ingress);
  return sandboxCallbackBaseUrl();
}
