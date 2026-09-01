/**
 * Warm-on-typing sandbox PREWARM pool for sandbox providers (Daytona, Box,
 * Modal, and the local Firecracker MicroVM) — the background-agents pattern:
 * sandbox provisioning starts when the user begins typing.
 *
 * Preparation is provider-specific. Daytona warms its sandbox runner; the
 * local MicroVM restores the credential-free workspace golden and pre-clones
 * the selected repo without installing dependencies. The branch need not
 * exist yet: adoption moves the default-branch clone into the session cwd,
 * refreshes it, then creates the requested branch. The frontend POSTs
 * /api/sandbox/prewarm on first input; session creation atomically adopts the
 * prepared sandbox instead of creating a racing sibling.
 *
 * Paid-compute discipline (this pool creates real remote sandboxes):
 *  - keyed by `provider:repoId`; a live prewarm per key is reused, never
 *    doubled (repeat POSTs while typing just extend the TTL)
 *  - `maxLive` (default 2) caps concurrent and ready prewarms together;
 *    excess requests answer "at-capacity" and stay cold
 *  - TTL (default 10 min) from the last touch; the sweep destroys expired
 *    prewarms provider-side, except explicit `keepReady` targets
 *  - provider-side backstops ensure a crashed Open Session cannot leak paid
 *    compute, and the sweep audits the provider by label for unknown entries
 *  - ready state survives a coordinator restart and is safe to adopt after
 *    its signature and TTL are revalidated; interrupted bootstraps are reaped
 *
 * Claiming is atomic: the in-process Map flip is synchronous (single-threaded
 * — no await between check and set) and the state file is renameSync'd to
 * `*.claimed` as the on-disk arbiter, so two simultaneous session creates
 * can never adopt the same sandbox. A claim whose bootstrap signature
 * (runnerSha/runnerBundleUrl) no longer matches the current config is
 * refused and the stale sandbox destroyed — the caller cold-creates.
 *
 * Docker is deliberately NOT pooled here: its mounts (workspace bind/volume,
 * per-session state volumes) are fixed at `docker create` time so a
 * pre-session container couldn't get them, and a cold docker ensure is
 * ~2-3s anyway. See the note in docker.ts.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { isDevInstance } from "../dev-mode";
import { REPOS } from "../worktree";
import { writeJsonAtomic } from "../shared/atomic-write";
import {
  sandboxConfig,
  sandboxesEnabled,
  sandboxPrewarmConfig,
  sandboxProviderConfigured,
  sandboxProviderCertified,
  isRemoteSandboxProvider,
} from "./config";
import {
  getSandboxConnection,
  isWorkspaceSandboxProvider,
  sandboxConnectionReady,
} from "./connections";
import { projectPreparationSignature } from "./remote-repo-template";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  bootstrapSignature,
  listRemoteStates,
  remoteCloneUrl,
  remoteWarmWorkspaceDir,
  resetRemoteSetupLifecycleStamp,
  runRemoteLifecycleHook,
  scrubRemoteWarmWorkspaceAuthority,
  shellQuoteWord,
  type RemoteDriver,
} from "./adapters/bootstrap";

/** Marks a sandbox as pool-owned (no session yet). Adoption REPLACES the
 *  whole label map with the session labels, so an adopted sandbox stops
 *  matching this immediately — the orphan audit only ever sees unclaimed
 *  pool sandboxes. */
export const PREWARM_LABEL = "opensession.prewarm";
export const PREWARM_KEY_LABEL = "opensession.prewarm.key";

export type PrewarmEntryState =
  | "bootstrapping"
  | "ready"
  | "claimed"
  | "destroying"
  | "failed";

export interface SandboxMachineSettings {
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
}

export interface PrewarmEntry {
  key: string; // `${provider}:${repoId}`
  provider: string;
  repoId: string;
  state: PrewarmEntryState;
  /** prewarmSignature() at prewarm time (runner pin + the provider's
   *  create-shape, e.g. daytona.snapshot); a claim with a different current
   *  signature is refused — stale payload or wrong-sized sandbox. */
  signature: string;
  sandboxId?: string;
  user?: string;
  resources?: SandboxMachineSettings;
  stage?: string;
  progress?: number;
  error?: string;
  createdAt: string;
  lastTouchedAt: string;
  claimedAt?: string;
  claimedBy?: string;
  /** Refresh an existing project image in place before publishing replacement. */
  refreshTemplate?: boolean;
  /** Prepared compute was stopped while its reusable disk remains available. */
  parked?: boolean;
  /** Zero-compute standby retained beside the image for providers whose
   * snapshot restore is too slow for an interactive first turn. */
  standby?: boolean;
  /** Setup/dependency input signature captured by a retained standby. */
  projectSignature?: string;
}

/** What the adapters implement so the pool stays provider-agnostic (e2b
 *  registers here later). Loaded lazily — a static import of an adapter
 *  would cycle (daytona.ts imports claimPrewarm from this module). */
export interface PrewarmAdapter {
  /** Create a remote sandbox carrying `labels`, with provider-side
   *  autoStop/autoDelete backstops so a crashed opensession can't leak it. */
  create(
    labels: Record<string, string>,
    opts: {
      autoStopMinutes: number;
      autoDeleteMinutes: number;
      resources?: SandboxMachineSettings;
    },
  ): Promise<{
    sandboxId: string;
    driver: RemoteDriver;
    /** The provider created this sandbox from the current repo template. */
    restoredFromTemplate?: boolean;
  }>;
  destroy(sandboxId: string): Promise<void>;
  /** Provider-side sandboxes still carrying PREWARM_LABEL, with their
   *  PREWARM_KEY_LABEL (orphan audit — the key scopes who may reap). */
  listPrewarmed(): Promise<Array<{ id: string; key: string }>>;
  /** Provider-specific preparation. Omitted means the legacy full-runner
   * bootstrap, followed by the optional warm-preview workspace clone. */
  prepare?(
    driver: RemoteDriver,
    repo: (typeof REPOS)[string],
    label: string,
  ): Promise<void>;
  /** Publish the fully bootstrapped, post-setup, credential-scrubbed
   * filesystem as the provider's shared repo template. Called only when
   * create() did not already restore the current template. */
  publishTemplate?(
    sandboxId: string,
    repo: (typeof REPOS)[string],
    label: string,
    options?: { replace?: boolean },
  ): Promise<void>;
  /** Release compute after preparation while retaining the prepared disk.
   * Providers without a durable stopped state simply omit this. */
  park?(sandboxId: string): Promise<void>;
  /** Refresh provider-side stop/delete backstops for an explicit keep-ready target. */
  keepAlive?(
    sandboxId: string,
    opts: { autoStopMinutes: number; autoDeleteMinutes: number },
  ): Promise<void>;
}

const SWEEP_INTERVAL_MS = 60_000;
const KEEP_READY_KEEPALIVE_MS = 5 * 60_000;
const STANDBY_KEEPALIVE_MS = 6 * 60 * 60_000;
const STANDBY_DELETE_MIN = 30 * 24 * 60;
/** Don't hammer a broken provider while the user keeps typing. */
const FAILED_RETRY_MS = 90_000;
/** How long a claimed tombstone protects the adopted sandbox from the orphan
 *  audit (covers the claim→relabel window in the adopting ensure()). */
const CLAIMED_GRACE_MS = 15 * 60_000;
const ORPHAN_AUDIT_INTERVAL_MS = 10 * 60_000;
/** Provider-side backstops relative to the pool TTL (crash insurance only —
 *  the sweep normally destroys expired prewarms well before these fire). */
const BACKSTOP_STOP_EXTRA_MIN = 5;
const BACKSTOP_DELETE_MIN = 60;

// ── State (globalThis for --hot survival; files for restart reaping) ────────

interface PrewarmRecord {
  entry: PrewarmEntry;
  /** Runtime-only completion owned by the same record as the lifecycle state. */
  bootstrapDone?: Promise<void>;
  /** Sessions waiting to adopt this exact bootstrap. Preparation hands the
   * sandbox to them before an optional multi-minute template seal. */
  waiters?: number;
  /** A provider template publication has begun and cannot be interrupted. A
   * new session should cold-create immediately instead of waiting first. */
  sealing?: boolean;
  /** Runtime-only provider cleanup, shared by every overlapping cleanup path. */
  destroyDone?: Promise<void>;
  /** Last provider-side lifecycle refresh for an explicit keep-ready target. */
  keptAliveAt?: number;
}

function pool(): Map<string, PrewarmRecord> {
  const g = globalThis as unknown as {
    __sandboxPrewarmPool?: Map<string, PrewarmRecord | PrewarmEntry>;
    __sandboxPrewarmDone?: Map<string, Promise<void>>;
  };
  const records = (g.__sandboxPrewarmPool ??= new Map());
  for (const [key, value] of records) {
    if ("entry" in value) continue;
    records.set(key, {
      entry: value,
      bootstrapDone: g.__sandboxPrewarmDone?.get(key),
    });
  }
  delete g.__sandboxPrewarmDone;
  return records as Map<string, PrewarmRecord>;
}

function prewarmDir(): string {
  return `${OPENSESSION_SESSIONS_DIR}/sandbox-prewarm`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function fileFor(entry: Pick<PrewarmEntry, "provider" | "repoId">): string {
  return `${prewarmDir()}/${sanitize(entry.provider)}-${sanitize(entry.repoId)}.json`;
}

function persist(entry: PrewarmEntry): void {
  try {
    mkdirSync(prewarmDir(), { recursive: true });
    writeJsonAtomic(fileFor(entry), entry);
  } catch (e) {
    console.warn(`[sandbox-prewarm] persist(${entry.key}) failed:`, e);
  }
}

function removeFile(entry: Pick<PrewarmEntry, "provider" | "repoId">): void {
  try {
    unlinkSync(fileFor(entry));
  } catch {}
}

/** What must match between prewarm time and claim time for adoption to be
 *  safe: the runner-payload pin (bootstrapSignature) PLUS the provider's
 *  create-shape — daytona's org snapshot decides the sandbox's cpu/mem/disk
 *  and e2b's template its image, neither changeable after create. */
function prewarmSignature(
  provider: string,
  resources?: SandboxMachineSettings,
): string {
  const cfg = sandboxConfig();
  const shape =
    provider === "daytona"
      ? getSandboxConnection("daytona")?.settings.snapshot || "default"
      : provider === "box"
        ? "named-snapshot"
        : provider === "e2b"
          ? cfg.e2b?.template || "base"
          : "";
  return `${bootstrapSignature()}|${shape}|${JSON.stringify(resources || {})}`;
}

// 429 is intentionally excluded: a blind 0.5–1s retry cannot clear provider
// start quotas and can consume more of them. Environment maintenance owns the
// persisted, provider-aware backoff instead.
const TRANSIENT_PREWARM_ERROR =
  /HTTP 5\d\d|timed? ?out|timeout|temporar|connection|socket|transport|ECONNRESET|EPIPE/i;

async function retryTransientPrewarmStep<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (
        !TRANSIENT_PREWARM_ERROR.test(
          error instanceof Error ? error.message : String(error),
        ) ||
        attempt === 3
      )
        throw error;
      console.warn(
        `[sandbox-prewarm] ${label} transient failure; retrying (${attempt}/3):`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw last;
}

function setPrewarmStage(
  entry: PrewarmEntry,
  stage: string,
  progress: number,
): void {
  entry.stage = stage;
  entry.progress = progress;
  entry.lastTouchedAt = new Date().toISOString();
  persist(entry);
}

function keepReadyTargets(): Array<{ provider: string; repoId: string }> {
  const seen = new Set<string>();
  return sandboxPrewarmConfig().keepReady.filter(({ provider, repoId }) => {
    const key = `${provider}:${repoId}`;
    if (
      seen.has(key) ||
      !isRemoteSandboxProvider(provider) ||
      !(repoId in REPOS)
    )
      return false;
    seen.add(key);
    return true;
  });
}

function isKeepReady(provider: string, repoId: string): boolean {
  return keepReadyTargets().some(
    (target) => target.provider === provider && target.repoId === repoId,
  );
}

// ── Adapters (lazy; test-injectable) ────────────────────────────────────────

const testAdapters = new Map<string, PrewarmAdapter | null>();

async function adapterFor(provider: string): Promise<PrewarmAdapter | null> {
  if (testAdapters.has(provider)) return testAdapters.get(provider) ?? null;
  if (provider === "daytona") {
    const { daytonaPrewarmAdapter } = await import("./adapters/daytona");
    return daytonaPrewarmAdapter;
  }
  if (provider === "box") {
    const { boxPrewarmAdapter } = await import("./adapters/box");
    return boxPrewarmAdapter;
  }
  if (provider === "modal") {
    const { modalPrewarmAdapter } = await import("./adapters/modal");
    return modalPrewarmAdapter;
  }
  // e2b: no prewarm adapter yet — requests answer "unsupported" until one
  // registers here (the pool itself is already provider-agnostic).
  return null;
}

function destroyRecord(record: PrewarmRecord, why: string): Promise<void> {
  const { provider, sandboxId } = record.entry;
  if (!sandboxId) return Promise.resolve();
  if (record.destroyDone) return record.destroyDone;
  const done = (async () => {
    try {
      const adapter = await adapterFor(provider);
      await adapter?.destroy(sandboxId);
      console.log(
        `[sandbox-prewarm] destroyed ${provider} prewarm ${sandboxId} (${why})`,
      );
    } catch (e) {
      console.warn(
        `[sandbox-prewarm] destroy of ${sandboxId} (${why}) failed:`,
        e,
      );
    }
  })();
  record.destroyDone = done;
  return done;
}

/** Restart orphans have no in-memory owner to transition. Give cleanup a
 * short-lived owner so it still uses the same one-shot destruction path. */
function destroyUntrackedLater(
  provider: string,
  sandboxId: string,
  why: string,
): void {
  void destroyRecord(
    {
      entry: {
        key: `${provider}:untracked:${sandboxId}`,
        provider,
        repoId: "untracked",
        state: "failed",
        signature: "",
        sandboxId,
        createdAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
      },
    },
    why,
  );
}

// ── Requesting (the typing-driven entry point) ──────────────────────────────

export type PrewarmRequestState =
  | "disabled"
  | "unsupported"
  | "bootstrapping"
  | "ready"
  | "failed"
  | "at-capacity";

/**
 * Idempotent + cheap: called on the first keystroke and every ~60s while
 * typing continues. Reuses (and TTL-touches) a live prewarm for the key,
 * starts one when capacity allows, and NEVER awaits the bootstrap — the
 * response is immediate, the work detached.
 */
export async function requestPrewarm(
  provider: string,
  repoId: string,
  user?: string,
  options: { refreshTemplate?: boolean; standby?: boolean } = {},
): Promise<{ state: PrewarmRequestState; sandboxId?: string }> {
  if (!isRemoteSandboxProvider(provider) || !(repoId in REPOS)) {
    return { state: "unsupported" };
  }
  if (!sandboxesEnabled()) return { state: "disabled" };
  if (
    isWorkspaceSandboxProvider(provider) &&
    getSandboxConnection(provider) &&
    !sandboxConnectionReady(provider)
  ) {
    return { state: "disabled" };
  }
  const cfg = sandboxPrewarmConfig();
  if (
    !cfg.enabled ||
    !sandboxProviderConfigured(provider) ||
    (!sandboxProviderCertified(provider) &&
      process.env.OPENSESSION_SANDBOX_CERTIFICATION_RUN !== "1" &&
      !testAdapters.has(provider))
  )
    return { state: "disabled" };
  ensurePrewarmSweep();

  const key = `${provider}:${repoId}`;
  const { sandboxEnvironmentSettings } = await import("./environments");
  const resources = sandboxEnvironmentSettings(repoId, provider);
  const p = pool();
  let record = p.get(key);
  let entry = record?.entry;
  if (
    entry &&
    (entry.signature !== prewarmSignature(provider, resources) ||
      (entry.standby &&
        entry.projectSignature !== projectPreparationSignature(repoId)))
  ) {
    await invalidatePrewarm(provider, repoId);
    record = undefined;
    entry = undefined;
  }
  if (entry && (entry.state === "bootstrapping" || entry.state === "ready")) {
    if (options.refreshTemplate && !entry.refreshTemplate) {
      await invalidatePrewarm(provider, repoId);
      record = undefined;
      entry = undefined;
    } else {
      touchPrewarm(provider, repoId);
      return { state: entry.state, sandboxId: entry.sandboxId };
    }
  }
  if (entry?.state === "failed") {
    if (Date.now() - Date.parse(entry.lastTouchedAt) < FAILED_RETRY_MS) {
      return { state: "failed" };
    }
    p.delete(key);
    removeFile(entry);
  }

  // Caps — this is paid compute.
  const live = [...p.values()].filter(
    ({ entry: e }) =>
      e.state === "bootstrapping" || (e.state === "ready" && !e.parked),
  );
  if (live.length >= cfg.maxLive) return { state: "at-capacity" };

  const adapter = await adapterFor(provider);
  if (!adapter) return { state: "unsupported" };

  const now = new Date().toISOString();
  const standby = Boolean(options.standby && adapter.park);
  const fresh: PrewarmEntry = {
    key,
    provider,
    repoId,
    state: "bootstrapping",
    signature: prewarmSignature(provider, resources),
    user,
    ...(options.refreshTemplate ? { refreshTemplate: true } : {}),
    ...(standby
      ? { standby: true, projectSignature: projectPreparationSignature(repoId) }
      : {}),
    ...(resources ? { resources } : {}),
    stage: "Creating sandbox",
    progress: 10,
    createdAt: now,
    lastTouchedAt: now,
  };
  const freshRecord: PrewarmRecord = { entry: fresh };
  p.set(key, freshRecord);
  persist(fresh);
  const done = runPrewarmBootstrap(freshRecord, adapter);
  freshRecord.bootstrapDone = done;
  void done.finally(() => {
    if (freshRecord.bootstrapDone === done)
      freshRecord.bootstrapDone = undefined;
  });
  return { state: "bootstrapping" };
}

/** Extend a live prewarm's TTL (requestPrewarm calls it; exported for
 *  callers that only want to keep an existing prewarm alive). */
export function touchPrewarm(provider: string, repoId: string): void {
  const entry = pool().get(`${provider}:${repoId}`)?.entry;
  if (!entry || (entry.state !== "bootstrapping" && entry.state !== "ready"))
    return;
  entry.lastTouchedAt = new Date().toISOString();
  persist(entry);
}

export function prewarmStatus(
  provider: string,
  repoId: string,
): PrewarmEntry | undefined {
  const entry = pool().get(`${provider}:${repoId}`)?.entry;
  return entry ? { ...entry } : undefined;
}

/** Remove a provider/repo prewarm before an explicit environment rebuild. */
export async function invalidatePrewarm(
  provider: string,
  repoId: string,
): Promise<void> {
  const key = `${provider}:${repoId}`;
  const record = pool().get(key);
  if (!record) return;
  const { entry } = record;
  pool().delete(key);
  removeFile(entry);
  if (entry.sandboxId && entry.state !== "claimed") {
    await destroyRecord(record, "invalidated");
  }
}

async function runPrewarmBootstrap(
  record: PrewarmRecord,
  adapter: PrewarmAdapter,
): Promise<void> {
  const { entry } = record;
  const current = () => pool().get(entry.key) === record;
  try {
    const ttl = sandboxPrewarmConfig().ttlMinutes;
    console.log(
      `[sandbox-prewarm] starting ${entry.key} prewarm (user ${entry.user || "?"})`,
    );
    setPrewarmStage(entry, "Creating sandbox", 10);
    const { sandboxId, driver, restoredFromTemplate } = await adapter.create(
      {
        [PREWARM_LABEL]: "1",
        [PREWARM_KEY_LABEL]: entry.key,
        "opensession.sandbox": "1",
      },
      {
        autoStopMinutes: ttl + BACKSTOP_STOP_EXTRA_MIN,
        autoDeleteMinutes: entry.standby
          ? STANDBY_DELETE_MIN
          : BACKSTOP_DELETE_MIN,
        resources: entry.resources,
      },
    );
    entry.sandboxId = sandboxId;
    if (!current()) {
      // Reaped (TTL) or reset while creating — don't leak the sandbox.
      void destroyRecord(record, "superseded mid-create");
      return;
    }
    persist(entry);
    const repo = REPOS[entry.repoId];
    if (!repo) throw new Error(`unknown prewarm repo ${entry.repoId}`);
    if (restoredFromTemplate && adapter.publishTemplate) {
      setPrewarmStage(entry, "Validating existing template", 65);
      await retryTransientPrewarmStep(`${entry.key} bootstrap`, async () => {
        await assertDialbackReachable(driver, `${entry.provider}-prewarm`);
        await bootstrapRemoteSandbox(driver, `${entry.provider}-prewarm`);
      });
      const { validateRemoteRepoTemplate } =
        await import("./remote-repo-template");
      await validateRemoteRepoTemplate(
        driver,
        entry.provider as "daytona" | "box" | "modal",
        repo,
      );
      if (entry.refreshTemplate) {
        setPrewarmStage(entry, "Syncing the latest project image", 72);
        const warmDir = remoteWarmWorkspaceDir(repo.id);
        const cloneUrl = await remoteCloneUrl(repo);
        await retryTransientPrewarmStep(
          `${entry.key} image refresh`,
          async () => {
            // A refresh that timed out mid-git (or a snapshot published while
            // one ran) leaves stale .git lock files that fail every later
            // refresh with "index.lock: File exists". This prewarm sandbox is
            // the clone's only writer, so clearing dead locks before syncing
            // is safe.
            try {
              const refreshed = await driver.exec(
                `find .git -name "*.lock" -type f -delete 2>/dev/null; ` +
                  `git remote set-url origin ${shellQuoteWord(cloneUrl)} && ` +
                  `git fetch origin ${shellQuoteWord(repo.defaultBranch)} --quiet && ` +
                  `git reset --hard ${shellQuoteWord(`origin/${repo.defaultBranch}`)}`,
                { cwd: warmDir, timeoutMs: 10 * 60_000 },
              );
              if (refreshed.exitCode !== 0) {
                throw new Error(
                  `could not refresh ${repo.id} project image: ${(refreshed.stderr || refreshed.stdout).trim().slice(0, 300)}`,
                );
              }
            } finally {
              // A retained checkout must be safe both before repository setup
              // runs and between transient refresh retries.
              await scrubRemoteWarmWorkspaceAuthority(driver, repo, warmDir);
            }
          },
        );
        // Updating source without rerunning setup republishes stale generated
        // output. For tella-fusion that turns the user's first Portal start
        // into an 80–100s ReScript rebuild, defeating the prepared image.
        setPrewarmStage(entry, "Rebuilding prepared project image", 76);
        await resetRemoteSetupLifecycleStamp(driver, repo.id);
        await runRemoteLifecycleHook(
          driver,
          warmDir,
          "setup",
          "fresh",
          repo.id,
          {
            sandboxId: entry.sandboxId || `prewarm:${entry.key}`,
            provider: entry.provider,
            repoId: repo.id,
          },
        );
      }
    } else if (adapter.prepare) {
      setPrewarmStage(entry, "Preparing project workspace", 40);
      await adapter.prepare(driver, repo, `${entry.provider}-prewarm`);
    } else {
      setPrewarmStage(entry, "Installing runner tools", 25);
      await retryTransientPrewarmStep(`${entry.key} bootstrap`, async () => {
        await assertDialbackReachable(driver, `${entry.provider}-prewarm`);
        await bootstrapRemoteSandbox(driver, `${entry.provider}-prewarm`);
      });
      if (!current()) {
        void destroyRecord(record, "superseded mid-bootstrap");
        return;
      }
      // Repo-template providers ALWAYS pre-clone and run `.agents/setup`
      // before publishing their filesystem snapshot. Providers without a
      // template publisher retain the old optional warm-deps behavior.
      try {
        const { warmTemplateConfig } = await import("../warm-template");
        const warm = warmTemplateConfig(entry.repoId).enabled;
        if (warm || adapter.publishTemplate) {
          setPrewarmStage(entry, "Cloning project and running setup", 55);
          const { warmRemoteWorkspace } = await import("./adapters/bootstrap");
          const prepared = await warmRemoteWorkspace(
            driver,
            repo,
            `${entry.provider}-prewarm`,
            {
              // A repository setup hook owns the exact dependency/build recipe
              // for reusable templates. Running a second generic root install
              // can rewrite bun.lock after setup and makes the sealed workspace
              // dirty. Legacy non-template prewarms keep their old behavior.
              installDeps: adapter.publishTemplate ? false : warm,
              runSetup: true,
              identity: {
                sandboxId: entry.sandboxId || `prewarm:${entry.key}`,
                provider: entry.provider,
                repoId: repo.id,
              },
            },
          );
          if (!prepared && adapter.publishTemplate) {
            throw new Error(`could not prepare ${repo.id} for a repo template`);
          }
        }
      } catch (e) {
        if (adapter.publishTemplate) throw e;
        console.warn(
          `[sandbox-prewarm] ${entry.key} warm workspace failed (non-fatal):`,
          e,
        );
      }
    }
    if (!current()) {
      void destroyRecord(record, "superseded mid-warm");
      return;
    }
    // A waiting session or keep-ready target needs the prepared sandbox now.
    // Hand it over before optional publication or parking work. Repository
    // templates can take minutes to seal, while adoption is immediate.
    const releaseToWaiter = () => (record.waiters || 0) > 0;
    if (
      adapter.publishTemplate &&
      (!restoredFromTemplate || entry.refreshTemplate) &&
      !releaseToWaiter() &&
      !isKeepReady(entry.provider, entry.repoId)
    ) {
      record.sealing = true;
      setPrewarmStage(entry, "Sealing reusable template", 82);
      try {
        await adapter.publishTemplate(
          sandboxId,
          repo,
          `${entry.provider}-prewarm`,
          { replace: entry.refreshTemplate },
        );
      } finally {
        record.sealing = false;
      }
    }
    if (!releaseToWaiter() && adapter.park) {
      setPrewarmStage(entry, "Finalizing", 95);
      await adapter.park(sandboxId);
      entry.parked = true;
      persist(entry);
    }
    if (!current()) {
      void destroyRecord(record, "superseded mid-park");
      return;
    }
    entry.state = "ready";
    entry.stage = "Ready";
    entry.progress = 100;
    entry.lastTouchedAt = new Date().toISOString();
    persist(entry);
    console.log(
      releaseToWaiter()
        ? `[sandbox-prewarm] ${entry.key} ready for waiting session (${sandboxId})`
        : `[sandbox-prewarm] ${entry.key} ready (${sandboxId})`,
    );
  } catch (e) {
    console.warn(`[sandbox-prewarm] ${entry.key} bootstrap failed:`, e);
    void destroyRecord(record, "bootstrap failed");
    if (current()) {
      entry.state = "failed";
      entry.error = String((e as any)?.message || e).slice(0, 300);
      entry.stage = "Needs attention";
      entry.sandboxId = undefined;
      entry.lastTouchedAt = new Date().toISOString();
      persist(entry);
    }
  }
}

// ── Claiming (adoption — called from the provider's ensure()) ───────────────

/**
 * Atomically claim the ready prewarm for (provider, repoId), or null when
 * there isn't one worth adopting. On success the caller OWNS the sandbox:
 * relabel it to the session and continue with the workspace clone. A stale
 * bootstrap signature refuses the claim and destroys the sandbox (the
 * caller cold-creates). Synchronous — the Map flip plus a state-file rename
 * are the whole arbitration, so two concurrent ensures can't both win.
 */
export function claimPrewarm(
  provider: string,
  repoId: string,
  sessionId: string,
): { sandboxId: string } | null {
  const key = `${provider}:${repoId}`;
  const p = pool();
  const record = p.get(key);
  const entry = record?.entry;
  if (
    !entry ||
    entry.refreshTemplate ||
    entry.state !== "ready" ||
    !entry.sandboxId
  )
    return null;
  if (
    entry.signature !== prewarmSignature(provider, entry.resources) ||
    (entry.standby &&
      entry.projectSignature !== projectPreparationSignature(repoId))
  ) {
    // Runner pin, provider create-shape, or project setup input changed since
    // this was warmed — never adopt stale payload or a wrong-sized sandbox.
    p.delete(key);
    removeFile(entry);
    void destroyRecord(record, "stale bootstrap signature");
    return null;
  }
  // On-disk arbiter: the rename fails for everyone but the first claimant
  // (and for a process whose in-memory state is somehow ahead of disk).
  try {
    renameSync(fileFor(entry), `${fileFor(entry)}.claimed`);
  } catch {
    p.delete(key);
    return null;
  }
  entry.state = "claimed";
  entry.claimedAt = new Date().toISOString();
  entry.claimedBy = sessionId;
  // Tombstone key: frees `key` for a fresh prewarm while still protecting
  // the adopted sandbox from the orphan audit until the grace passes.
  p.delete(key);
  p.set(`${key}#${entry.sandboxId}`, record);
  if (isKeepReady(provider, repoId) || entry.standby) {
    void requestPrewarm(provider, repoId, entry.user, {
      standby: entry.standby,
    }).catch((error) => {
      console.warn(`[sandbox-prewarm] could not replenish ${key}:`, error);
    });
  }
  return { sandboxId: entry.sandboxId };
}

/**
 * Claim a ready prewarm, or — when one for this key is MID-BOOTSTRAP and
 * young — WAIT for it to finish and then claim. Warm-on-typing reality: the
 * typing→send gap is seconds while the bootstrap is ~20-60s, so a plain
 * claimPrewarm at send time virtually never adopts — ensure() cold-created a
 * RACING SIBLING next to the warming sandbox (2× paid compute, zero benefit;
 * bks-019f4729, 2026-07-09). Waiting the remaining ~15-40s is both faster
 * than a fresh cold create and halves the sandbox count.
 *
 *  - Demand/typing entries older than `maxAgeMs` (default 60s) are skipped: an
 *    old bootstrap is probably a pathological cold install. Project standbys
 *    are zero-compute prepared capacity and remain worth the bounded wait; a
 *    maintenance refill often finishes seconds after a session asks for it.
 *  - The wait itself is bounded by `maxWaitMs` (default 180s) as a backstop;
 *    a finished-but-failed bootstrap resolves immediately and claims null.
 *  - Two concurrent ensures can both wait; claimPrewarm's atomic arbitration
 *    still lets exactly one adopt — the loser cold-creates.
 */
export async function claimPrewarmOrWait(
  provider: string,
  repoId: string,
  sessionId: string,
  opts?: { maxAgeMs?: number; maxWaitMs?: number },
): Promise<{ sandboxId: string } | null> {
  const claimed = claimPrewarm(provider, repoId, sessionId);
  if (claimed) return claimed;
  const key = `${provider}:${repoId}`;
  const record = pool().get(key);
  const entry = record?.entry;
  if (!entry || entry.refreshTemplate || entry.state !== "bootstrapping")
    return null;
  // Provider snapshot creation cannot be interrupted. Starting the user's
  // cold fallback now is faster than waiting two minutes and then doing the
  // same cold create, which was the five-minute startup failure this guards.
  if (record.sealing) {
    console.log(
      `[sandbox-prewarm] ensure(${sessionId.slice(0, 20)}…) skipping ${key} wait; template seal already started`,
    );
    return null;
  }
  const age = Date.now() - Date.parse(entry.createdAt);
  if (
    !Number.isFinite(age) ||
    (!entry.standby && age > (opts?.maxAgeMs ?? 60_000))
  ) {
    console.log(
      `[sandbox-prewarm] ensure(${sessionId.slice(0, 20)}…) skipping old ${key} prewarm (${Math.round(age / 1000)}s old)`,
    );
    return null;
  }
  const done = record.bootstrapDone;
  if (!done) return null; // not ours to await (restarted process)
  console.log(
    `[sandbox-prewarm] ensure(${sessionId.slice(0, 20)}…) waiting for in-flight ${key} prewarm (${Math.round(age / 1000)}s old)…`,
  );
  record.waiters = (record.waiters || 0) + 1;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise<void>((r) => {
        timeout = setTimeout(() => {
          timedOut = true;
          r();
        }, opts?.maxWaitMs ?? 180_000);
        (timeout as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    record.waiters = Math.max(0, (record.waiters || 1) - 1);
  }
  if (timedOut) {
    console.log(
      `[sandbox-prewarm] ensure(${sessionId.slice(0, 20)}…) timed out waiting for ${key}`,
    );
  }
  return claimPrewarm(provider, repoId, sessionId);
}

/** Release and destroy a claimed sandbox the adopter found unusable. The owner
 *  moves to destroying until provider cleanup settles, so status and orphan
 *  auditing cannot disagree about who owns the sandbox. */
export function discardClaimedPrewarm(
  provider: string,
  sandboxId: string,
): void {
  const found = [...pool().entries()].find(
    ([, { entry }]) =>
      entry.provider === provider &&
      entry.sandboxId === sandboxId &&
      (entry.state === "claimed" || entry.state === "destroying"),
  );
  if (found) {
    const [key, record] = found;
    const wasClaimed = record.entry.state === "claimed";
    record.entry.state = "destroying";
    if (wasClaimed) {
      try {
        renameSync(
          `${fileFor(record.entry)}.claimed`,
          `${fileFor(record.entry)}.destroying`,
        );
      } catch {}
    }
    void destroyRecord(record, "claimed but unusable").finally(() => {
      if (pool().get(key) === record) pool().delete(key);
      try {
        unlinkSync(`${fileFor(record.entry)}.destroying`);
      } catch {}
    });
    return;
  }
  destroyUntrackedLater(provider, sandboxId, "claimed but unusable");
}

// ── Sweep (TTL + restart recovery + provider-side orphan audit) ─────────────

/** Restore only completed, current prewarms. An interrupted bootstrap still
 * lacks a resumable promise and is reaped by the sweep below. */
export function restoreReadyPrewarms(now = Date.now()): number {
  const dir = prewarmDir();
  if (!existsSync(dir)) return 0;
  const ttlMs = sandboxPrewarmConfig().ttlMinutes * 60_000;
  const p = pool();
  let restored = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(
        readFileSync(`${dir}/${name}`, "utf-8"),
      ) as PrewarmEntry;
      if (
        entry.state !== "ready" ||
        !entry.sandboxId ||
        entry.key !== `${entry.provider}:${entry.repoId}` ||
        !(entry.repoId in REPOS) ||
        fileFor(entry) !== `${dir}/${name}` ||
        entry.signature !== prewarmSignature(entry.provider, entry.resources) ||
        (entry.standby &&
          entry.projectSignature !==
            projectPreparationSignature(entry.repoId)) ||
        (!isKeepReady(entry.provider, entry.repoId) &&
          !(entry.standby && entry.parked) &&
          now - Date.parse(entry.lastTouchedAt) > ttlMs) ||
        p.has(entry.key)
      )
        continue;
      p.set(entry.key, { entry });
      restored++;
      console.log(
        `[sandbox-prewarm] restored ready ${entry.key} prewarm (${entry.sandboxId})`,
      );
    } catch {}
  }
  return restored;
}

export function sessionOwnedSandboxIds(
  states: Array<
    Pick<ReturnType<typeof listRemoteStates>[number], "sessionId" | "sandboxId">
  >,
): Set<string> {
  return new Set(
    states
      .filter(
        (state) =>
          !state.sessionId.startsWith("__prewarm__:") && state.sandboxId,
      )
      .map((state) => state.sandboxId),
  );
}

function knownSandboxIds(provider: string): Set<string> {
  const known = new Set<string>();
  for (const { entry: e } of pool().values()) {
    if (e.provider === provider && e.sandboxId) known.add(e.sandboxId);
  }
  // Provider labels are not an authority boundary. Daytona has returned an
  // adopted session Sandbox from its prewarm-label query after setLabels(),
  // and the orphan audit subsequently deleted live session compute once the
  // claim tombstone expired. A durable session mapping is stronger evidence:
  // never reap an id that an ordinary remote-session state file still owns.
  for (const sandboxId of sessionOwnedSandboxIds(listRemoteStates(provider)))
    known.add(sandboxId);
  try {
    const dir = prewarmDir();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(`${sanitize(provider)}-`)) continue;
        try {
          const s = JSON.parse(readFileSync(`${dir}/${f}`, "utf-8"));
          if (s?.sandboxId) known.add(String(s.sandboxId));
        } catch {}
      }
    }
  } catch {}
  return known;
}

/** One sweep pass; exported for tests (inject `now`) and armed on an
 *  interval by ensurePrewarmSweep. Reaps: TTL-expired live prewarms
 *  (provider-side destroy), stale failed/claimed bookkeeping, on-disk
 *  entries a restart orphaned, and — throttled — provider-side sandboxes
 *  still labeled as prewarms that nothing tracks. */
export async function sweepPrewarms(now = Date.now()): Promise<void> {
  restoreReadyPrewarms(now);
  const cfg = sandboxPrewarmConfig();
  const ttlMs = cfg.ttlMinutes * 60_000;
  const p = pool();

  for (const [key, record] of [...p.entries()]) {
    const { entry } = record;
    if (entry.state === "bootstrapping" || entry.state === "ready") {
      if (
        isKeepReady(entry.provider, entry.repoId) ||
        (entry.standby && entry.parked)
      ) {
        entry.lastTouchedAt = new Date(now).toISOString();
        persist(entry);
        if (entry.state === "ready" && entry.sandboxId) {
          try {
            const adapter = await adapterFor(entry.provider);
            if (!entry.parked && adapter?.park) {
              await adapter.park(entry.sandboxId);
              entry.parked = true;
              persist(entry);
            }
            const keepAliveMs = entry.standby
              ? STANDBY_KEEPALIVE_MS
              : KEEP_READY_KEEPALIVE_MS;
            if (now - (record.keptAliveAt || 0) >= keepAliveMs) {
              record.keptAliveAt = now;
              await adapter?.keepAlive?.(entry.sandboxId, {
                autoStopMinutes: cfg.ttlMinutes + BACKSTOP_STOP_EXTRA_MIN,
                autoDeleteMinutes: entry.standby
                  ? STANDBY_DELETE_MIN
                  : BACKSTOP_DELETE_MIN,
              });
            }
          } catch (error) {
            console.warn(
              `[sandbox-prewarm] parked keep-alive failed for ${entry.key}:`,
              error,
            );
          }
        }
      } else if (now - Date.parse(entry.lastTouchedAt) > ttlMs) {
        p.delete(key);
        removeFile(entry);
        if (entry.sandboxId) void destroyRecord(record, "ttl expired");
        else
          console.log(
            `[sandbox-prewarm] dropped ${key} (ttl expired before create)`,
          );
      }
    } else if (entry.state === "failed") {
      if (now - Date.parse(entry.lastTouchedAt) > FAILED_RETRY_MS) {
        p.delete(key);
        removeFile(entry);
      }
    } else if (entry.state === "claimed") {
      // Adopted — session-owned now; never destroy. Just retire the tombstone.
      if (
        now - Date.parse(entry.claimedAt || entry.lastTouchedAt) >
        CLAIMED_GRACE_MS
      ) {
        p.delete(key);
        try {
          unlinkSync(`${fileFor(entry)}.claimed`);
        } catch {}
      }
    }
  }

  // Restart reaping: ready entries were restored above. A restarted process
  // cannot resume an interrupted bootstrap, so every other unowned entry is
  // destroyed rather than adopted.
  try {
    const dir = prewarmDir();
    if (existsSync(dir)) {
      const owned = new Set(
        [...p.values()].map(({ entry }) => {
          const base = fileFor(entry).split("/").pop()!;
          if (entry.state === "claimed") return `${base}.claimed`;
          if (entry.state === "destroying") return `${base}.destroying`;
          return base;
        }),
      );
      for (const f of readdirSync(dir)) {
        const full = `${dir}/${f}`;
        if (owned.has(f)) continue;
        if (f.endsWith(".json.destroying")) {
          try {
            const s = JSON.parse(readFileSync(full, "utf-8"));
            if (s?.sandboxId && typeof s.provider === "string") {
              destroyUntrackedLater(
                String(s.provider),
                String(s.sandboxId),
                "destroy interrupted by restart",
              );
            }
          } catch {}
          try {
            unlinkSync(full);
          } catch {}
          continue;
        }
        if (f.endsWith(".json.claimed")) {
          // Adopted before a restart — the session owns the sandbox. Unlink
          // the tombstone once its orphan-audit protection window passed.
          try {
            if (now - statSync(full).mtimeMs > CLAIMED_GRACE_MS)
              unlinkSync(full);
          } catch {}
          continue;
        }
        if (!f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(readFileSync(full, "utf-8"));
          if (s?.sandboxId && typeof s.provider === "string") {
            destroyUntrackedLater(
              String(s.provider),
              String(s.sandboxId),
              "orphaned by restart",
            );
          }
        } catch {}
        try {
          unlinkSync(full);
        } catch {}
      }
    }
  } catch {}

  for (const { provider, repoId } of keepReadyTargets()) {
    if (p.has(`${provider}:${repoId}`)) continue;
    void requestPrewarm(provider, repoId).catch((error) => {
      console.warn(
        `[sandbox-prewarm] could not maintain ${provider}:${repoId}:`,
        error,
      );
    });
  }

  await auditProviderOrphans(now);
}

/** Throttled provider-side audit: list sandboxes still carrying
 *  PREWARM_LABEL and destroy any this process doesn't track — closes the
 *  crash window between `create` returning and the id being persisted. */
async function auditProviderOrphans(now: number): Promise<void> {
  const g = globalThis as unknown as { __prewarmOrphanAuditAt?: number };
  if (now - (g.__prewarmOrphanAuditAt || 0) < ORPHAN_AUDIT_INTERVAL_MS) return;
  g.__prewarmOrphanAuditAt = now;
  for (const provider of ["daytona", "box", "e2b", "modal"] as const) {
    if (!sandboxProviderConfigured(provider)) continue;
    // A create in flight has a live sandbox with no recorded id yet — skip
    // this provider's audit round rather than destroy it mid-bootstrap.
    const creating = [...pool().values()].some(
      ({ entry: e }) =>
        e.provider === provider && e.state === "bootstrapping" && !e.sandboxId,
    );
    if (creating) continue;
    const adapter = await adapterFor(provider);
    if (!adapter) continue;
    let listed: Array<{ id: string; key: string }> = [];
    try {
      listed = await adapter.listPrewarmed();
    } catch {
      continue;
    }
    if (!listed.length) continue;
    const known = knownSandboxIds(provider);
    for (const { id, key } of listed) {
      if (known.has(id)) continue;
      // Only reap keys whose repo THIS process's registry knows: a
      // conformance/verify run (scratch registry) can never destroy the live
      // server's prewarms, and the live server never touches sbxtest ones —
      // each side's own audit cleans its own. Unlabeled/malformed keys have
      // no owner and are fair game.
      const repoId = key.includes(":") ? key.slice(key.indexOf(":") + 1) : "";
      if (repoId && !(repoId in REPOS)) continue;
      console.warn(
        `[sandbox-prewarm] destroying untracked ${provider} prewarm ${id} (${key || "no key"})`,
      );
      try {
        await adapter.destroy(id);
      } catch (e) {
        console.warn(`[sandbox-prewarm] orphan destroy of ${id} failed:`, e);
      }
    }
  }
}

/** Arm the sweep once per process (globalThis-parked like the other
 *  schedulers, so --hot reloads don't stack timers). Unref'd, so it never
 *  keeps a test or CLI process alive on its own. */
export function ensurePrewarmSweep(): void {
  // Dev instances: the sweep destroys sandboxes via live providers shared
  // with production, so it never arms there.
  if (isDevInstance()) return;
  const g = globalThis as unknown as {
    __sandboxPrewarmSweepTimer?: ReturnType<typeof setInterval>;
  };
  if (g.__sandboxPrewarmSweepTimer) return;
  const t = setInterval(() => {
    sweepPrewarms().catch((e) =>
      console.warn("[sandbox-prewarm] sweep failed:", e),
    );
  }, SWEEP_INTERVAL_MS);
  (t as { unref?: () => void }).unref?.();
  g.__sandboxPrewarmSweepTimer = t;
}

// ── Per-user rate limit for the POST route (typing events are client-side
//    debounced, but the server enforces its own ceiling) ────────────────────

export function prewarmRateLimited(
  user: string,
  limit = 6,
  windowMs = 60_000,
): boolean {
  const g = globalThis as unknown as {
    __sandboxPrewarmRate?: Map<string, number[]>;
  };
  const m = (g.__sandboxPrewarmRate ??= new Map<string, number[]>());
  const now = Date.now();
  const recent = (m.get(user) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    m.set(user, recent);
    return true;
  }
  recent.push(now);
  m.set(user, recent);
  return false;
}

// ── Test seams ───────────────────────────────────────────────────────────────

export function _setPrewarmAdapterForTest(
  provider: string,
  adapter: PrewarmAdapter | null,
): void {
  testAdapters.set(provider, adapter);
}

export function _resetPrewarmForTest(): void {
  testAdapters.clear();
  pool().clear();
  const g = globalThis as unknown as {
    __prewarmOrphanAuditAt?: number;
    __sandboxPrewarmRate?: Map<string, number[]>;
  };
  g.__prewarmOrphanAuditAt = 0;
  g.__sandboxPrewarmRate?.clear();
}

export function _prewarmPoolForTest(): Map<string, PrewarmEntry> {
  return new Map([...pool()].map(([key, record]) => [key, record.entry]));
}

/** Stop the sweep interval (test teardown — a leaked timer in a test process
 *  could otherwise run the provider orphan audit against live config). */
export function _stopPrewarmSweepForTest(): void {
  const g = globalThis as unknown as {
    __sandboxPrewarmSweepTimer?: ReturnType<typeof setInterval>;
  };
  if (g.__sandboxPrewarmSweepTimer) {
    clearInterval(g.__sandboxPrewarmSweepTimer);
    g.__sandboxPrewarmSweepTimer = undefined;
  }
}

/** Coordinator boot hook. Resource acquisition stays out of module scope so
 * importing a sandbox helper from a test or script cannot start a live sweep. */
export async function startPrewarmPool(): Promise<void> {
  if (isDevInstance()) return;
  restoreReadyPrewarms();
  ensurePrewarmSweep();
  await sweepPrewarms();
}
