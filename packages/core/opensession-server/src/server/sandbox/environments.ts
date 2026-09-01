/** Persistent per-repository sandbox environment readiness. */

import { readFileSync } from "fs";
import { stateDir } from "../paths";
import { writeJsonAtomic } from "../shared/atomic-write";
import { REPOS } from "../worktree";
import {
  sandboxConnectionReady,
  type WorkspaceSandboxProvider,
} from "./connections";
import {
  invalidateRemoteRepoTemplate,
  readRemoteRepoTemplate,
  remoteRepoTemplateNeedsRefresh,
} from "./remote-repo-template";
import { isTransientSandboxStartError } from "./reliability";
import {
  invalidatePrewarm,
  prewarmStatus,
  requestPrewarm,
  type SandboxMachineSettings,
} from "./prewarm";
import { listSandboxOperations, startSandboxOperation } from "./operations";

const invalidationTimers: Map<string, ReturnType<typeof setTimeout>> = ((
  globalThis as any
).__sandboxEnvironmentInvalidationTimers ??= new Map());
const PROVIDER_QUOTA_RETRY_MS = 60 * 60_000;

export interface SandboxEnvironment {
  repo: string;
  provider: WorkspaceSandboxProvider;
  state: "not_prepared" | "preparing" | "ready" | "failed" | "stale";
  updatedAt: string;
  preparedAt?: string;
  expiresAt?: string;
  failureCode?: string;
  failureSummary?: string;
  /** Persisted backoff for recoverable provider/setup failures. */
  retryAt?: string;
  mode?: "template" | "per_session";
  settings?: SandboxMachineSettings;
}

interface StoredEnvironments {
  version: 1;
  environments: SandboxEnvironment[];
}

function storePath(): string {
  return (
    process.env.OPENSESSION_SANDBOX_ENVIRONMENTS_STORE ||
    stateDir("sandbox-environments.json")
  );
}

function readStored(): SandboxEnvironment[] {
  try {
    const raw = JSON.parse(
      readFileSync(storePath(), "utf-8"),
    ) as StoredEnvironments;
    return Array.isArray(raw?.environments) ? raw.environments : [];
  } catch {
    return [];
  }
}

function writeEnvironment(environment: SandboxEnvironment): void {
  const all = readStored().filter(
    (candidate) =>
      candidate.repo !== environment.repo ||
      candidate.provider !== environment.provider,
  );
  all.push(environment);
  writeJsonAtomic(storePath(), {
    version: 1,
    environments: all,
  } satisfies StoredEnvironments);
}

function storedEnvironment(
  repo: string,
  provider: WorkspaceSandboxProvider,
): SandboxEnvironment | undefined {
  return readStored().find(
    (environment) =>
      environment.repo === repo && environment.provider === provider,
  );
}

export function sandboxEnvironmentSettings(
  repo: string,
  provider: string,
): SandboxMachineSettings | undefined {
  const settings = storedEnvironment(
    repo,
    provider as WorkspaceSandboxProvider,
  )?.settings;
  return settings ? { ...settings } : undefined;
}

function normalizeMachineSettings(
  provider: WorkspaceSandboxProvider,
  raw?: SandboxMachineSettings,
): SandboxMachineSettings | undefined {
  if (!raw) return undefined;
  const settings: SandboxMachineSettings = {};
  if (raw.cpu != null) {
    const validCpu =
      provider === "modal"
        ? Number.isFinite(raw.cpu) && raw.cpu >= 0.125 && raw.cpu <= 16
        : Number.isInteger(raw.cpu) && raw.cpu >= 1 && raw.cpu <= 64;
    if (!validCpu) {
      throw Object.assign(
        new Error("CPU is outside this provider's supported range"),
        { code: "MACHINE_SETTINGS_INVALID" },
      );
    }
    settings.cpu = raw.cpu;
  }
  if (raw.memoryMb != null) {
    if (
      !Number.isInteger(raw.memoryMb) ||
      raw.memoryMb < 512 ||
      raw.memoryMb > 262_144
    ) {
      throw Object.assign(
        new Error("Memory must be between 512 and 262144 MB"),
        { code: "MACHINE_SETTINGS_INVALID" },
      );
    }
    settings.memoryMb = raw.memoryMb;
  }
  if (raw.diskGb != null && provider === "daytona") {
    if (!Number.isInteger(raw.diskGb) || raw.diskGb < 1 || raw.diskGb > 1_000) {
      throw Object.assign(new Error("Disk must be between 1 and 1000 GB"), {
        code: "MACHINE_SETTINGS_INVALID",
      });
    }
    settings.diskGb = raw.diskGb;
  }
  if (provider === "box") {
    const supported = [
      { cpu: 2, memoryMb: 4_096, diskGb: 40 },
      { cpu: 4, memoryMb: 8_192, diskGb: 80 },
      { cpu: 8, memoryMb: 16_384, diskGb: 100 },
    ].some(
      (profile) =>
        profile.cpu === settings.cpu &&
        profile.memoryMb === settings.memoryMb &&
        profile.diskGb === raw.diskGb,
    );
    if (!supported) {
      throw Object.assign(
        new Error("Choose one of Box's Small, Default, or Large machine sizes"),
        {
          code: "MACHINE_SETTINGS_INVALID",
        },
      );
    }
    settings.diskGb = raw.diskGb;
  }
  return Object.keys(settings).length ? settings : undefined;
}

function interruptedPreparation(
  stored: SandboxEnvironment | undefined,
): SandboxEnvironment | undefined {
  if (!stored || stored.state !== "preparing") return stored;
  const running = listSandboxOperations().some(
    (operation) =>
      operation.kind === "environment_rebuild" &&
      operation.repo === stored.repo &&
      operation.provider === stored.provider &&
      operation.status === "running",
  );
  if (running) return stored;
  return {
    ...stored,
    state: "failed",
    failureCode: "SERVER_RESTARTED",
    failureSummary: "Preparation was interrupted. Retry when ready.",
  };
}

async function derivedEnvironment(
  repo: string,
  provider: WorkspaceSandboxProvider,
): Promise<SandboxEnvironment> {
  const stored = storedEnvironment(repo, provider);
  const now = new Date().toISOString();
  if (!sandboxConnectionReady(provider)) {
    return {
      repo,
      provider,
      state: "not_prepared",
      updatedAt: stored?.updatedAt || now,
    };
  }
  if (provider === "docker") {
    return {
      repo,
      provider,
      state: "ready",
      mode: "per_session",
      updatedAt: stored?.updatedAt || now,
      preparedAt: stored?.preparedAt || now,
    };
  }
  if (provider === "daytona" || provider === "box" || provider === "modal") {
    const template = readRemoteRepoTemplate(provider, repo);
    if (template) {
      return {
        repo,
        provider,
        state: "ready",
        mode: "template",
        updatedAt: template.createdAt,
        preparedAt: template.createdAt,
        ...(stored?.settings ? { settings: stored.settings } : {}),
      };
    }
  }
  return (
    interruptedPreparation(stored) || {
      repo,
      provider,
      state: "not_prepared",
      updatedAt: now,
    }
  );
}

export async function listSandboxEnvironments(): Promise<SandboxEnvironment[]> {
  const out: SandboxEnvironment[] = [];
  const providers: WorkspaceSandboxProvider[] = [
    "docker",
    "daytona",
    "box",
    "modal",
  ];
  for (const repo of Object.keys(REPOS)) {
    for (const provider of providers)
      out.push(await derivedEnvironment(repo, provider));
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTemplate(
  repo: string,
  provider: WorkspaceSandboxProvider,
): Promise<void> {
  if (provider === "daytona" || provider === "box" || provider === "modal") {
    const previous = invalidateRemoteRepoTemplate(provider, repo);
    if (previous?.artifactId) {
      if (provider === "daytona") {
        const { deleteDaytonaTemplateArtifact } =
          await import("./adapters/daytona");
        await deleteDaytonaTemplateArtifact(previous.artifactId);
      } else if (provider === "box") {
        const { deleteBoxTemplateArtifact } = await import("./adapters/box");
        await deleteBoxTemplateArtifact(previous.artifactId);
      } else {
        const { deleteModalTemplateArtifact } =
          await import("./adapters/modal");
        await deleteModalTemplateArtifact(previous.artifactId);
      }
    }
  }
}

/**
 * Drop warm artifacts after the repository's default branch changes. Artifact
 * deletion is best-effort, but mappings are invalidated first so a stale image
 * can never be selected while provider cleanup is retrying.
 */
export async function invalidateSandboxEnvironmentsForRepo(
  repo: string,
): Promise<void> {
  if (!(repo in REPOS)) return;
  for (const provider of ["daytona", "box", "modal"] as const) {
    const stored = storedEnvironment(repo, provider);
    if (!stored) continue;
    // Remote repo templates contain a credential-free warm clone. Adoption
    // fetches the current default branch before creating the session branch,
    // so deleting a multi-gigabyte provider snapshot on every push creates a
    // minutes-long cold-start gap without improving source freshness.
    if (provider === "daytona" || provider === "box" || provider === "modal") {
      const current = await derivedEnvironment(repo, provider);
      writeEnvironment(
        current.state === "ready"
          ? current
          : {
              repo,
              provider,
              state: "stale",
              mode: "template",
              updatedAt: new Date().toISOString(),
              ...(stored.settings ? { settings: stored.settings } : {}),
            },
      );
      continue;
    }
    await invalidatePrewarm(provider, repo).catch((error) => {
      console.warn(
        `[sandbox:${provider}] failed to release prewarm for ${repo}:`,
        error,
      );
    });
    await removeTemplate(repo, provider).catch((error) => {
      console.warn(
        `[sandbox:${provider}] failed to delete stale template for ${repo}:`,
        error,
      );
    });
    writeEnvironment({
      repo,
      provider,
      state: "stale",
      mode: "template",
      updatedAt: new Date().toISOString(),
      ...(stored.settings ? { settings: stored.settings } : {}),
    });
  }
}

/** Coalesce the webhook burst generated by one default-branch update. */
export function scheduleSandboxEnvironmentInvalidation(repo: string): void {
  if (!(repo in REPOS) || invalidationTimers.has(repo)) return;
  invalidationTimers.set(
    repo,
    setTimeout(() => {
      invalidationTimers.delete(repo);
      void invalidateSandboxEnvironmentsForRepo(repo).catch((error) => {
        console.error(
          `[sandbox] environment invalidation failed for ${repo}:`,
          error,
        );
      });
    }, 2_000),
  );
}

export async function prepareSandboxEnvironment(
  repo: string,
  provider: WorkspaceSandboxProvider,
  options: {
    rebuild?: boolean;
    refresh?: boolean;
    user?: string;
    settings?: SandboxMachineSettings;
    onProgress?: (stage: string, progress: number, detail?: string) => void;
  } = {},
): Promise<void> {
  if (!(repo in REPOS))
    throw Object.assign(new Error(`Unknown repository "${repo}"`), {
      code: "REPO_UNKNOWN",
    });
  if (!sandboxConnectionReady(provider)) {
    throw Object.assign(new Error(`${provider} is not Ready`), {
      code: "CONNECTION_NOT_READY",
    });
  }
  if (provider === "docker") {
    writeEnvironment({
      repo,
      provider,
      state: "ready",
      mode: "per_session",
      preparedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const previousSettings = storedEnvironment(repo, provider)?.settings;
  const settings = normalizeMachineSettings(
    provider,
    options.settings === undefined ? previousSettings : options.settings,
  );
  if (options.rebuild) {
    await invalidatePrewarm(provider, repo);
    await removeTemplate(repo, provider);
  }
  const now = new Date().toISOString();
  writeEnvironment({
    repo,
    provider,
    state: "preparing",
    mode: "template",
    updatedAt: now,
    ...(settings ? { settings } : {}),
  });
  options.onProgress?.("Creating sandbox", 10);
  try {
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const requested = await requestPrewarm(
        provider,
        repo,
        options.user || "workspace-setup",
        {
          refreshTemplate: options.refresh,
          // Daytona and Box can retain a stopped disk with zero compute. It
          // removes slow snapshot materialization from the first-turn path;
          // Modal has no park() and therefore keeps image-only behavior.
          standby: true,
        },
      );
      const entry = prewarmStatus(provider, repo);
      if (entry?.stage) options.onProgress?.(entry.stage, entry.progress || 10);
      else if (requested.state === "at-capacity") {
        options.onProgress?.("Waiting for provider capacity", 5);
      }
      if (requested.state === "ready" || entry?.state === "ready") {
        // Providers with a real stopped state retain one zero-compute standby
        // beside the durable artifact. Others release the build sandbox.
        if (!(entry?.standby && entry.parked)) {
          await invalidatePrewarm(provider, repo);
        }
        options.onProgress?.("Verifying template", 98);
        const derived = await derivedEnvironment(repo, provider);
        if (derived.state !== "ready") {
          throw Object.assign(
            new Error("Prepared template could not be verified"),
            {
              code: "TEMPLATE_VERIFY_FAILED",
            },
          );
        }
        writeEnvironment(derived);
        return;
      }
      if (requested.state === "failed" || entry?.state === "failed") {
        throw Object.assign(
          new Error(
            entry?.error || "Repository setup failed in the sandbox provider",
          ),
          {
            code: "ENVIRONMENT_SETUP_FAILED",
          },
        );
      }
      if (requested.state === "disabled" || requested.state === "unsupported") {
        throw Object.assign(
          new Error("This provider cannot prepare project environments"),
          {
            code: "ENVIRONMENT_UNSUPPORTED",
          },
        );
      }
      await delay(2_000);
    }
    throw Object.assign(
      new Error("Project environment preparation timed out"),
      {
        code: "ENVIRONMENT_TIMEOUT",
      },
    );
  } catch (error) {
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code)
        : "ENVIRONMENT_SETUP_FAILED";
    const failureSummary =
      code === "ENVIRONMENT_TIMEOUT"
        ? "Project setup took too long. Try rebuilding it."
        : error instanceof Error
          ? error.message.slice(0, 500)
          : "Project setup failed. Rebuild it to try again.";
    const quotaLimited = /(?:rate.?limit|quota|plan allows|per day)/i.test(
      failureSummary,
    );
    const retryDelayMs = quotaLimited
      ? PROVIDER_QUOTA_RETRY_MS
      : isTransientSandboxStartError(error)
        ? 15 * 60_000
        : 0;
    const failure: SandboxEnvironment = {
      repo,
      provider,
      state: "failed",
      mode: "template",
      updatedAt: new Date().toISOString(),
      failureCode: code,
      failureSummary,
      ...(retryDelayMs
        ? { retryAt: new Date(Date.now() + retryDelayMs).toISOString() }
        : {}),
      ...(settings ? { settings } : {}),
    };
    writeEnvironment(failure);
    throw Object.assign(new Error(failure.failureSummary), { code });
  }
}

const providerQueues: Map<string, Promise<void>> = ((
  globalThis as any
).__sandboxEnvironmentQueues ??= new Map());
let maintenanceTimer: ReturnType<typeof setInterval> | undefined = (
  globalThis as any
).__sandboxEnvironmentMaintenanceTimer;

/** Resume explicitly prepared template environments whose preparation inputs
 * changed or whose provider artifact disappeared. A stored record means a
 * human opted this repo/provider pair into transient preparation; this never
 * enables a new provider or keeps idle compute alive. */
function maintainSandboxEnvironments(): void {
  for (const environment of readStored()) {
    if (
      !["daytona", "box", "modal"].includes(environment.provider) ||
      (environment.mode !== "template" && environment.state !== "preparing") ||
      !sandboxConnectionReady(environment.provider)
    )
      continue;
    if (environment.state === "failed") {
      const retryAt = environment.retryAt
        ? Date.parse(environment.retryAt)
        : /(?:rate.?limit|quota|plan allows|per day)/i.test(
              environment.failureSummary || "",
            )
          ? Date.parse(environment.updatedAt) + PROVIDER_QUOTA_RETRY_MS
          : Number.NaN;
      if (!Number.isFinite(retryAt) || retryAt > Date.now()) continue;
    }
    const template = readRemoteRepoTemplate(
      environment.provider as "daytona" | "box" | "modal",
      environment.repo,
    );
    if (template && !remoteRepoTemplateNeedsRefresh(template)) {
      // Publication is the durable completion boundary. A coordinator may
      // restart while the disposable validation sandbox is still parking;
      // promote the recovered artifact instead of deleting it.
      void derivedEnvironment(environment.repo, environment.provider).then(
        writeEnvironment,
      );
      if (
        environment.provider === "daytona" ||
        environment.provider === "box"
      ) {
        const standby = prewarmStatus(environment.provider, environment.repo);
        if (!(standby?.standby && standby.parked)) {
          void requestPrewarm(
            environment.provider,
            environment.repo,
            "environment-standby",
            { standby: true },
          );
        }
      }
      continue;
    }
    if (template) {
      const standby = prewarmStatus(environment.provider, environment.repo);
      if (
        (environment.provider === "daytona" ||
          environment.provider === "box") &&
        standby?.standby &&
        standby.parked
      ) {
        // A stopped standby fetches the current branch when claimed. Replacing
        // it on a source-only timer creates an avoidable availability gap,
        // especially while Daytona seals or restores a large snapshot. Setup
        // input changes invalidate both the template and standby immediately.
        void derivedEnvironment(environment.repo, environment.provider).then(
          writeEnvironment,
        );
        continue;
      }
      scheduleSandboxEnvironment(environment.repo, environment.provider, {
        refresh: true,
        user: "image-registry-refresh",
        settings: environment.settings,
      });
      continue;
    }
    scheduleSandboxEnvironment(environment.repo, environment.provider, {
      rebuild: true,
      user: "template-maintenance",
      settings: environment.settings,
    });
  }
}

export function startSandboxEnvironmentMaintenance(): void {
  if (maintenanceTimer) return;
  maintainSandboxEnvironments();
  maintenanceTimer = setInterval(maintainSandboxEnvironments, 60_000);
  maintenanceTimer.unref?.();
  (globalThis as any).__sandboxEnvironmentMaintenanceTimer = maintenanceTimer;
}

export function scheduleSandboxEnvironment(
  repo: string,
  provider: WorkspaceSandboxProvider,
  options: {
    rebuild?: boolean;
    refresh?: boolean;
    user?: string;
    settings?: SandboxMachineSettings;
  } = {},
) {
  const existing = listSandboxOperations().find(
    (operation) =>
      operation.kind === "environment_rebuild" &&
      operation.repo === repo &&
      operation.provider === provider &&
      operation.status === "running",
  );
  if (existing) return existing;
  const previous = providerQueues.get(provider) || Promise.resolve();
  const operation = startSandboxOperation(
    { kind: "environment_rebuild", provider, repo },
    async (update) => {
      const run = previous
        .catch(() => {})
        .then(() =>
          prepareSandboxEnvironment(repo, provider, {
            ...options,
            onProgress: (stage, progress, detail) =>
              update({ stage, progress, detail }),
          }),
        );
      providerQueues.set(provider, run);
      try {
        await run;
      } finally {
        if (providerQueues.get(provider) === run)
          providerQueues.delete(provider);
      }
    },
  );
  return operation;
}
