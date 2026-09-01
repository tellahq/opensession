/**
 * ModalProvider — remote sandbox adapter over Modal's TypeScript SDK.
 *
 * Modal sandboxes are ephemeral containers with a maximum 24-hour lifetime.
 * The workspace is cloned inside the sandbox and is lost when its idle timeout
 * or lifetime expires, so code-mode sessions must push their work. The shared
 * remote bootstrap provides the runner payload and WS dial-back transport.
 */

import type {
  App as ModalApp,
  ModalClient,
  Sandbox as ModalSandbox,
} from "modal";
import { getRepo, worktreePathFor } from "../../worktree";
import { hostRunBusy } from "../../host-registry";
import { sandboxConfig } from "../config";
import {
  getSandboxConnection,
  sandboxProviderCredential,
} from "../connections";
import type {
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  listRemoteStates,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  resolveTrustPolicy,
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
  PREWARM_LABEL,
  type PrewarmAdapter,
} from "../prewarm";
import {
  invalidateRemoteRepoTemplate,
  readRemoteRepoTemplate,
  REMOTE_REPO_TEMPLATE_TTL_MS,
  sealRemoteRepoTemplate,
  writeRemoteRepoTemplate,
} from "../remote-repo-template";

const SESSION_TAG = "opensession.session";
const DEFAULT_APP = "opensession-sandboxes";
const DEFAULT_IMAGE = "daytonaio/sandbox:0.8.0";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RECREATE_BEFORE_EXPIRY_MS = 60 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
const CHECKPOINT_WAIT_MS = 90_000;
const MAX_TAG_SCAN = 8;

function modalCheckpointLocks(): Map<string, Promise<void>> {
  const g = globalThis as typeof globalThis & {
    __opensessionModalCheckpointLocks?: Map<string, Promise<void>>;
  };
  return (g.__opensessionModalCheckpointLocks ||= new Map());
}

async function waitForModalCheckpoint(
  sandboxId: string | undefined,
): Promise<void> {
  if (!sandboxId) return;
  const checkpoint = modalCheckpointLocks().get(sandboxId);
  if (!checkpoint) return;
  await withModalControlDeadline(
    checkpoint.catch(() => {}),
    CHECKPOINT_WAIT_MS,
    `Modal checkpoint wait (${sandboxId})`,
  ).catch((error) => {
    console.warn(
      `[sandbox:modal] ${error instanceof Error ? error.message : String(error)}; continuing with the last completed checkpoint`,
    );
  });
}

function modalConfig(): ReturnType<typeof sandboxConfig> {
  const cfg = sandboxConfig();
  const settings = getSandboxConnection("modal")?.settings || {};
  return {
    ...cfg,
    cpus: settings.cpu,
    memory: settings.memoryMb ? `${settings.memoryMb}m` : undefined,
    modal: {
      profile: settings.profile,
      app: settings.app,
      image: settings.image,
      environment: settings.environment,
      endpoint: settings.endpoint,
      region: settings.region,
      cloud: settings.cloud,
      publicPreviews: settings.publicPreviews,
    },
  };
}

function modalArtifactNotFound(error: unknown): boolean {
  const detail = error as {
    name?: string;
    status?: number;
    statusCode?: number;
    message?: string;
  };
  return (
    detail?.name === "NotFoundError" ||
    detail?.status === 404 ||
    detail?.status === 410 ||
    detail?.status === 412 ||
    detail?.statusCode === 404 ||
    detail?.statusCode === 410 ||
    detail?.statusCode === 412 ||
    /(?:image|artifact).{0,30}(?:not.?found|expired|deleted|gone)/i.test(
      detail?.message || "",
    )
  );
}

function memoryMiB(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kmg])b?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "k") return Math.max(1, Math.ceil(amount / 1024));
  if (unit === "g") return Math.ceil(amount * 1024);
  return Math.ceil(amount);
}

async function modalClient(): Promise<ModalClient> {
  const cfg = modalConfig().modal || {};
  const workspaceCredential = sandboxProviderCredential("modal") as
    | { tokenId: string; tokenSecret: string }
    | undefined;
  if (!workspaceCredential)
    throw new Error("Modal workspace credentials are not configured");
  const { tokenId, tokenSecret } = workspaceCredential;
  const key = JSON.stringify([
    tokenId,
    tokenSecret,
    cfg.profile,
    cfg.environment,
    cfg.endpoint,
  ]);
  const cached = (globalThis as any).__opensessionModalClient as
    | { key: string; client: ModalClient }
    | undefined;
  if (cached?.key === key) return cached.client;
  const { ModalClient } = await import("modal");
  const client = new ModalClient({
    tokenId,
    tokenSecret,
    environment: cfg.environment,
    endpoint: cfg.endpoint,
  });
  (globalThis as any).__opensessionModalClient = { key, client };
  return client;
}

function modalApp(client: ModalClient): Promise<ModalApp> {
  const name = modalConfig().modal?.app || DEFAULT_APP;
  const global = globalThis as any;
  const cached = global.__opensessionModalApp as
    | { client: ModalClient; name: string; app: Promise<ModalApp> }
    | undefined;
  if (cached?.client === client && cached.name === name) return cached.app;
  const app = client.apps.fromName(name, { createIfMissing: true });
  const record = { client, name, app };
  global.__opensessionModalApp = record;
  app.catch(() => {
    if (global.__opensessionModalApp === record)
      delete global.__opensessionModalApp;
  });
  return app;
}

async function withModalControlDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  // Promise.race does not cancel its loser. Keep a late control-stream failure
  // from becoming a process-level unhandled rejection after our deadline won.
  operation.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function modalDriver(sandbox: ModalSandbox): RemoteDriver {
  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      const timeoutMs = opts?.timeoutMs ?? 120_000;
      let process: any;
      try {
        // A login shell runs Modal's image profile hooks, which emit OSC
        // terminal-title sequences even without a PTY. Those bytes corrupt
        // machine-readable stdout (and once poisoned a sourced `.ports.conf`).
        process = await withModalControlDeadline(
          sandbox.exec(["sh", "-c", cmd], {
            workdir: opts?.cwd,
            env: opts?.env,
            timeoutMs,
            pty: false,
          }),
          Math.min(timeoutMs, 30_000),
          "Modal exec launch",
        );
        const [stdout, stderr, exitCode] = await withModalControlDeadline(
          Promise.all([
            process.stdout.readText(),
            process.stderr.readText(),
            process.wait(),
          ]),
          timeoutMs + 5_000,
          "Modal exec stream",
        );
        return { exitCode, stdout, stderr };
      } catch (e: any) {
        // ContainerProcess has no kill API in modal@0.9. Closing stdin is the
        // supported cancellation boundary and releases commands such as `cat`
        // that would otherwise hold the wedged exec stream until its timeout.
        if (process?.closeStdin) {
          await withModalControlDeadline(
            process.closeStdin(),
            5_000,
            "Modal exec stdin close",
          ).catch(() => {});
        }
        return { exitCode: 1, stdout: "", stderr: String(e?.message || e) };
      }
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      // Modal's exec timeout is the child lifetime, while RemoteDriver's
      // timeout is the launch deadline. Keep the detached process alive for
      // the sandbox lifetime, but never let a wedged control stream block the
      // coordinator. Discard output because callers receive no process handle.
      await withModalControlDeadline(
        sandbox.exec(["sh", "-c", `( ${cmd}\n) >/dev/null 2>&1`], {
          workdir: opts?.cwd,
          env: opts?.env,
          timeoutMs: MAX_LIFETIME_MS,
          pty: false,
        }),
        opts?.timeoutMs ?? 30_000,
        "Modal background exec launch",
      );
    },

    async writeFile(path: string, content: string) {
      // modal@0.9's filesystem.writeText uses ReadableStream.from, which Bun
      // does not implement. Stream through process stdin with a local control
      // deadline so a broken stdio channel cannot wedge all later launches.
      let process: any;
      try {
        await withModalControlDeadline(
          (async () => {
            process = await sandbox.exec(
              [
                "sh",
                "-c",
                `mkdir -p $(dirname ${shellQuoteWord(path)}) && cat > ${shellQuoteWord(path)}`,
              ],
              { pty: false, timeoutMs: 60_000 },
            );
            await process.stdin.writeText(content);
            await process.stdin.close();
            const exitCode = await process.wait();
            if (exitCode !== 0) {
              throw new Error(
                `modal writeFile(${path}) failed: ${(await process.stderr.readText()).slice(0, 300)}`,
              );
            }
          })(),
          65_000,
          `Modal writeFile(${path})`,
        );
      } catch (error) {
        if (process?.closeStdin) {
          await withModalControlDeadline(
            process.closeStdin(),
            5_000,
            `Modal writeFile(${path}) stdin close`,
          ).catch(() => {});
        }
        throw error;
      }
    },

    async ensureStarted() {
      if ((await sandbox.poll()) !== null) {
        throw new Error(
          `modal sandbox ${sandbox.sandboxId} is no longer running`,
        );
      }
    },
  };
}

export class ModalProvider implements SandboxProvider {
  readonly id = "modal" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    ensureModalIdleSweep();
    if (spec.attachedDirs?.length) {
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    }
    const cfg = modalConfig();
    const client = await modalClient();
    let prevState = findRemoteStateBySession(this.id, spec.sessionId);
    let sandbox: ModalSandbox | null = null;
    let created = false;
    let adoptedPrewarmId: string | undefined;

    // The durable O(1) id is the normal follow-up path. A live sandbox does
    // not need the previous turn's filesystem image, so never serialize a
    // warm ensure behind a potentially multi-minute checkpoint.
    if (prevState) {
      try {
        const candidate = await client.sandboxes.fromId(prevState.sandboxId);
        if ((await candidate.poll()) === null) sandbox = candidate;
      } catch {}
    }
    if (!sandbox) {
      await waitForModalCheckpoint(prevState?.sandboxId);
      prevState = findRemoteStateBySession(this.id, spec.sessionId);
    }

    const trust = resolveTrustPolicy(spec, prevState);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd ||
      prevState?.cwd ||
      worktreePathFor(branch, repo.id, { isolated: true });

    // Durable state is authoritative. If its sandbox is gone, restore its
    // checkpoint rather than scanning older tag-matched siblings. The bounded
    // scan only recovers a live sandbox after coordinator state loss.
    if (!sandbox && !prevState) {
      try {
        let scanned = 0;
        const app = await modalApp(client);
        for await (const candidate of client.sandboxes.list({
          appId: app.appId,
          tags: { [SESSION_TAG]: spec.sessionId },
        })) {
          if (++scanned > MAX_TAG_SCAN) break;
          if ((await candidate.poll()) === null) {
            sandbox = candidate;
            break;
          }
        }
      } catch (e) {
        console.warn(
          "[sandbox:modal] tag lookup failed (will create/restore):",
          e,
        );
      }
    }
    if (sandbox && prevState && sandbox.sandboxId !== prevState.sandboxId) {
      removeRemoteState(this.id, prevState.sandboxId);
      prevState = null;
    }
    // Modal's absolute timeout is not extended by activity. Leave a one-hour
    // margin and rotate through a session-private image before a new turn can
    // be killed by the 24-hour deadline. This preserves uncommitted work.
    if (
      sandbox &&
      prevState &&
      Date.now() - Date.parse(prevState.createdAt) >=
        MAX_LIFETIME_MS - RECREATE_BEFORE_EXPIRY_MS
    ) {
      await withModalControlDeadline(
        this.checkpoint(sandbox.sandboxId),
        3 * 60_000,
        `Modal rotation checkpoint (${sandbox.sandboxId})`,
      ).catch((error) => {
        console.warn(
          `[sandbox:modal] rotation checkpoint failed; rotating before the hard lifetime anyway:`,
          error,
        );
      });
      prevState = findRemoteStateBySession(this.id, spec.sessionId);
      await sandbox
        .setTags({ "opensession.completed": spec.sessionId })
        .catch(() => {});
      await sandbox.terminate();
      removeRemoteState(this.id, sandbox.sandboxId);
      sandbox = null;
    }
    if (!sandbox && !prevState?.checkpointArtifactId) {
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        try {
          const candidate = await client.sandboxes.fromId(claim.sandboxId);
          if ((await candidate.poll()) === null) {
            await candidate.setTags({
              [SESSION_TAG]: spec.sessionId,
              "opensession.sandbox": "1",
              "opensession.repo": repo.id,
            });
            sandbox = candidate;
            adoptedPrewarmId = candidate.sandboxId;
            console.log(
              `[sandbox:modal] adopted prewarmed sandbox ${candidate.sandboxId} for ${spec.sessionId}`,
            );
          } else {
            discardClaimedPrewarm(this.id, claim.sandboxId);
          }
        } catch (error) {
          console.warn(
            "[sandbox:modal] prewarm adoption failed (cold-creating):",
            error,
          );
          discardClaimedPrewarm(this.id, claim.sandboxId);
          sandbox = null;
        }
      }
    }
    if (!sandbox) {
      const checkpointArtifactId = prevState?.checkpointArtifactId;
      const checkpointCreatedAt = prevState?.checkpointCreatedAt;
      if (prevState) removeRemoteState(this.id, prevState.sandboxId);
      console.log(`[sandbox:modal] creating sandbox for ${spec.sessionId}`);
      const template = readRemoteRepoTemplate("modal", repo.id);
      // The per-repo environment shape (Settings -> Sandboxes machine profile)
      // must reach session creation, not only prewarm — otherwise a 16 GB
      // profile silently launches on the connection default (measured: 8 GB).
      const { sandboxEnvironmentSettings } = await import("../environments");
      const projectResources = sandboxEnvironmentSettings(repo.id, "modal");
      const create = async (imageId?: string) => {
        const [app, image] = await Promise.all([
          modalApp(client),
          imageId
            ? client.images.fromId(imageId)
            : Promise.resolve(
                client.images.fromRegistry(cfg.modal?.image || DEFAULT_IMAGE),
              ),
        ]);
        return client.sandboxes.create(app, image, {
          tags: {
            [SESSION_TAG]: spec.sessionId,
            "opensession.sandbox": "1",
            "opensession.repo": repo.id,
          },
          timeoutMs: MAX_LIFETIME_MS,
          idleTimeoutMs:
            (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000,
          cpu: projectResources?.cpu || cfg.cpus,
          cpuLimit: projectResources?.cpu || cfg.cpus,
          memoryMiB: projectResources?.memoryMb || memoryMiB(cfg.memory),
          memoryLimitMiB: projectResources?.memoryMb || memoryMiB(cfg.memory),
          regions: cfg.modal?.region ? [cfg.modal.region] : undefined,
          cloud: cfg.modal?.cloud,
          encryptedPorts: cfg.modal?.publicPreviews
            ? cfg.previewPorts
            : undefined,
        });
      };
      let restoredCheckpoint = Boolean(checkpointArtifactId);
      try {
        sandbox = await create(checkpointArtifactId || template?.artifactId);
      } catch (error) {
        if (!modalArtifactNotFound(error)) throw error;
        if (checkpointArtifactId) {
          restoredCheckpoint = false;
          await client.images.delete(checkpointArtifactId).catch(() => {});
          console.warn(
            `[sandbox:modal] session checkpoint ${checkpointArtifactId} is unavailable; retrying from the project image`,
          );
          try {
            sandbox = await create(template?.artifactId);
          } catch (templateError) {
            if (!template || !modalArtifactNotFound(templateError))
              throw templateError;
            invalidateRemoteRepoTemplate("modal", repo.id);
            sandbox = await create();
          }
        } else if (template) {
          invalidateRemoteRepoTemplate("modal", repo.id);
          console.warn(
            `[sandbox:modal] repo template ${template.artifactId} is unavailable; retrying cold`,
          );
          sandbox = await create();
        } else {
          throw error;
        }
      }
      prevState =
        restoredCheckpoint && checkpointArtifactId
          ? {
              sandboxId: sandbox.sandboxId,
              provider: this.id,
              sessionId: spec.sessionId,
              cwd,
              repoId: repo.id,
              branch,
              checkpointArtifactId,
              checkpointCreatedAt,
              createdAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              ...trust,
            }
          : null;
      created = true;
    }

    const driver = modalDriver(sandbox);
    try {
      await driver.ensureStarted();
      await assertDialbackReachable(driver, "modal");
      await bootstrapRemoteSandbox(driver, "modal");
      await setupRemoteWorkspace(
        driver,
        cwd,
        await remoteCloneUrl(repo),
        branch,
        repo.defaultBranch,
        repo.id,
        {
          sandboxId: sandbox.sandboxId,
          provider: this.id,
          sessionId: spec.sessionId,
          repoId: repo.id,
          trustProfile: trust.trustProfile,
        },
      );
    } catch (e) {
      // A failed first bootstrap is not useful and otherwise remains paid
      // compute for up to 24 hours without a session-side sandbox id. An
      // adopted prewarm already lost its pool tags but has no state record yet,
      // so hand it back to the prewarm cleanup path explicitly.
      if (created) await sandbox.terminate().catch(() => {});
      else if (adoptedPrewarmId)
        discardClaimedPrewarm(this.id, adoptedPrewarmId);
      throw e;
    }
    const createdAt = created ? new Date().toISOString() : prevState?.createdAt;
    writeRemoteState({
      sandboxId: sandbox.sandboxId,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...(prevState?.checkpointArtifactId
        ? {
            checkpointArtifactId: prevState.checkpointArtifactId,
            checkpointCreatedAt: prevState.checkpointCreatedAt,
          }
        : {}),
      ...trust,
    });
    return this.makeHandle(sandbox, spec.sessionId, cwd);
  }

  private makeHandle(
    sandbox: ModalSandbox,
    sessionId: string,
    cwd: string,
  ): Sandbox {
    const providerId = this.id;
    return makeRemoteSandbox({
      providerId,
      sandboxId: sandbox.sandboxId,
      sessionId,
      cwd,
      driver: modalDriver(sandbox),
      async ports(): Promise<PortMap> {
        const map: PortMap = {};
        const cfg = modalConfig();
        if (!cfg.modal?.publicPreviews || !cfg.previewPorts?.length) return map;
        try {
          const tunnels = await sandbox.tunnels(60_000);
          for (const port of cfg.previewPorts) {
            const tunnel = tunnels[port];
            if (tunnel?.url) map[port] = { url: tunnel.url };
          }
        } catch (e) {
          console.warn("[sandbox:modal] tunnel lookup failed:", e);
        }
        return map;
      },
      async status(): Promise<SandboxStatus> {
        try {
          return (await sandbox.poll()) === null ? "running" : "gone";
        } catch {
          return "gone";
        }
      },
      touchActivity: () => touchRemoteState(providerId, sandbox.sandboxId),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    ensureModalIdleSweep();
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const client = await modalClient();
      const sandbox = await client.sandboxes.fromId(sandboxId);
      if ((await sandbox.poll()) !== null) return null;
      return this.makeHandle(sandbox, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:modal] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  async checkpoint(sandboxId: string): Promise<void> {
    const locks = modalCheckpointLocks();
    const existing = locks.get(sandboxId);
    if (existing) return existing;
    const task = withModalControlDeadline(
      this.checkpointInner(sandboxId),
      12 * 60_000,
      `Modal checkpoint (${sandboxId})`,
    ).finally(() => {
      if (locks.get(sandboxId) === task) locks.delete(sandboxId);
    });
    locks.set(sandboxId, task);
    return task;
  }

  private async checkpointInner(sandboxId: string): Promise<void> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state || state.sessionId.startsWith("__prewarm__:")) return;
    const client = await modalClient();
    const sandbox = await client.sandboxes.fromId(sandboxId);
    if ((await sandbox.poll()) !== null) return;
    const image = await sandbox.snapshotFilesystem({
      timeoutMs: 10 * 60_000,
      ttlMs: REMOTE_REPO_TEMPLATE_TTL_MS,
    });
    const current = readRemoteState(this.id, sandboxId);
    if (!current || current.sessionId !== state.sessionId) {
      await client.images.delete(image.imageId).catch(() => {});
      return;
    }
    const previous = current.checkpointArtifactId;
    current.checkpointArtifactId = image.imageId;
    current.checkpointCreatedAt = new Date().toISOString();
    writeRemoteState(current);
    if (previous && previous !== image.imageId) {
      await client.images.delete(previous).catch(() => {});
    }
    console.log(
      `[sandbox:modal] checkpointed ${state.sessionId} as ${image.imageId}`,
    );
  }

  async destroy(sandboxId: string): Promise<void> {
    await waitForModalCheckpoint(sandboxId);
    const state = readRemoteState(this.id, sandboxId);
    const client = await modalClient();
    try {
      const sandbox = await client.sandboxes.fromId(sandboxId);
      await sandbox
        .setTags({ "opensession.completed": state?.sessionId || sandboxId })
        .catch(() => {});
      await sandbox.terminate();
    } catch (e) {
      console.warn(`[sandbox:modal] destroy(${sandboxId}):`, e);
      if ((e as { name?: string })?.name !== "NotFoundError") throw e;
    }
    if (state?.checkpointArtifactId) {
      await client.images.delete(state.checkpointArtifactId).catch(() => {});
    }
    removeRemoteState(this.id, sandboxId);
  }
}

// ── Idle-stop sweep ──────────────────────────────────────────────────────────

/** Flip the session's workspace lifecycle to "sleeping" so the UI stops
 * reporting a terminated sandbox as awake (the checkpoint image is its
 * wake-up point). Guarded on the sandbox id so a session that already moved
 * to a new sandbox is left alone. Lazy import: session-cache sits above the
 * sandbox graph. */
async function markModalWorkspaceAsleep(
  sessionId: string,
  sandboxId: string,
): Promise<void> {
  try {
    const { updateSessionFile } = await import("../../session-cache");
    await updateSessionFile(sessionId, (data) =>
      data.sandbox?.sandboxId === sandboxId
        ? {
            ...data,
            sandbox: { ...data.sandbox, lifecycle: "sleeping" as const },
          }
        : data,
    );
  } catch (e) {
    console.warn(`[sandbox:modal] could not mark ${sessionId} asleep:`, e);
  }
}

/**
 * Server-owned idle stop, mirroring docker's sweepIdleSandboxes. Modal's
 * create-time idleTimeoutMs never fires for sessions with a live preview
 * portal or attached run host (any process activity resets it), so a session
 * that opened a dev server burned compute until the 24h hard lifetime. The
 * sweep checkpoints the filesystem, terminates the compute, and marks the
 * workspace asleep. The remote state file is KEPT — it carries the
 * checkpointArtifactId the next ensure restores from in seconds.
 *
 * `onlySandboxId` scopes the sweep to one sandbox and skips the idle-window
 * check (operator/verify use).
 */
export async function sweepIdleModalSandboxes(
  onlySandboxId?: string,
): Promise<void> {
  if (!getSandboxConnection("modal")) return;
  const cfg = modalConfig();
  const idleMs = (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  const provider = new ModalProvider();
  for (const state of listRemoteStates("modal")) {
    if (onlySandboxId && state.sandboxId !== onlySandboxId) continue;
    // The prewarm pool owns its own TTL and reaping.
    if (state.sessionId.startsWith("__prewarm__:")) continue;
    if (hostRunBusy(state.sessionId)) continue;
    const last = Date.parse(state.lastActivityAt || state.createdAt) || 0;
    if (!onlySandboxId && Date.now() - last < idleMs) continue;
    try {
      // Same per-session lock ensure holds, so a stop never races a turn
      // start materializing the same sandbox.
      await withRemoteEnsureLock("modal", state.sessionId, async () => {
        const current = readRemoteState("modal", state.sandboxId);
        if (!current || hostRunBusy(current.sessionId)) return;
        const client = await modalClient();
        let sandbox: ModalSandbox;
        try {
          sandbox = await client.sandboxes.fromId(state.sandboxId);
        } catch {
          return;
        }
        if ((await sandbox.poll()) !== null) {
          // Already dead (hard lifetime / provider stop) but still recorded
          // awake — reconcile the UI; keep state for the checkpoint restore.
          await markModalWorkspaceAsleep(current.sessionId, state.sandboxId);
          return;
        }
        // Snapshot BEFORE the stop (docker's warm-restore pattern). A failed
        // checkpoint logs and still stops — the previous checkpoint (if any)
        // remains the restore point.
        await provider.checkpoint(state.sandboxId).catch((e) => {
          console.warn(
            `[sandbox:modal] idle checkpoint of ${state.sandboxId} failed (stopping anyway):`,
            e,
          );
        });
        // A turn may have started during the (multi-minute) checkpoint.
        if (hostRunBusy(current.sessionId)) return;
        await sandbox
          .setTags({ "opensession.completed": current.sessionId })
          .catch(() => {});
        await sandbox.terminate();
        console.log(
          `[sandbox:modal] stopped idle sandbox ${state.sandboxId} ` +
            `(${current.sessionId}, idle > ${Math.round(idleMs / 60_000)}m)`,
        );
        await markModalWorkspaceAsleep(current.sessionId, state.sandboxId);
      });
    } catch (e) {
      console.warn(
        `[sandbox:modal] idle sweep failed for ${state.sandboxId}:`,
        e,
      );
    }
  }
}

/** Arm the idle sweep once per process (globalThis-parked, unref'd). Called
 * from ensure/get and from boot — never at module load. */
export function ensureModalIdleSweep(): void {
  const g = globalThis as typeof globalThis & {
    __modalIdleSweepTimer?: ReturnType<typeof setInterval>;
  };
  if (g.__modalIdleSweepTimer) return;
  const t = setInterval(() => {
    void sweepIdleModalSandboxes();
  }, IDLE_SWEEP_INTERVAL_MS);
  (t as { unref?: () => void }).unref?.();
  g.__modalIdleSweepTimer = t;
}

// ── Warm-on-typing + post-setup filesystem templates ────────────────────────

export const modalPrewarmAdapter: PrewarmAdapter = {
  async create(labels, opts) {
    const cfg = modalConfig();
    const key = labels[PREWARM_KEY_LABEL] || "";
    const repoId = key.startsWith("modal:") ? key.slice("modal:".length) : "";
    if (!repoId)
      throw new Error(`invalid Modal prewarm key: ${key || "(missing)"}`);
    const client = await modalClient();
    const app = await modalApp(client);
    const template = readRemoteRepoTemplate("modal", repoId);
    const create = async (imageId?: string) => {
      const image = imageId
        ? await client.images.fromId(imageId)
        : client.images.fromRegistry(cfg.modal?.image || DEFAULT_IMAGE);
      return client.sandboxes.create(app, image, {
        tags: labels,
        timeoutMs: MAX_LIFETIME_MS,
        // The Open Session prewarm sweep owns the short TTL. Keep Modal's
        // idle timeout session-sized so an adopted sandbox does not die five
        // minutes later with no API to extend that create-time setting.
        idleTimeoutMs:
          (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000,
        cpu: opts.resources?.cpu || cfg.cpus,
        cpuLimit: opts.resources?.cpu || cfg.cpus,
        memoryMiB: opts.resources?.memoryMb || memoryMiB(cfg.memory),
        memoryLimitMiB: opts.resources?.memoryMb || memoryMiB(cfg.memory),
        regions: cfg.modal?.region ? [cfg.modal.region] : undefined,
        cloud: cfg.modal?.cloud,
        encryptedPorts: cfg.modal?.publicPreviews
          ? cfg.previewPorts
          : undefined,
      });
    };
    let sandbox: ModalSandbox;
    let restoredFromTemplate = Boolean(template);
    try {
      sandbox = await create(template?.artifactId);
    } catch (error) {
      if (!template || !modalArtifactNotFound(error)) throw error;
      invalidateRemoteRepoTemplate("modal", repoId);
      restoredFromTemplate = false;
      sandbox = await create();
    }
    return {
      sandboxId: sandbox.sandboxId,
      driver: modalDriver(sandbox),
      restoredFromTemplate,
    };
  },

  async publishTemplate(sandboxId, repo) {
    const client = await modalClient();
    const sandbox = await client.sandboxes.fromId(sandboxId);
    await sealRemoteRepoTemplate(modalDriver(sandbox), "modal", repo);
    const image = await sandbox.snapshotFilesystem({
      timeoutMs: 10 * 60_000,
      ttlMs: REMOTE_REPO_TEMPLATE_TTL_MS,
    });
    const { previous } = writeRemoteRepoTemplate(
      "modal",
      repo.id,
      image.imageId,
    );
    if (previous?.artifactId && previous.artifactId !== image.imageId) {
      await client.images.delete(previous.artifactId).catch(() => {});
    }
    console.log(
      `[sandbox:modal] published post-setup repo template ${image.imageId} for ${repo.id}`,
    );
  },

  async destroy(sandboxId) {
    try {
      const client = await modalClient();
      const sandbox = await client.sandboxes.fromId(sandboxId);
      await sandbox
        .setTags({ "opensession.completed": sandboxId })
        .catch(() => {});
      await sandbox.terminate();
    } catch (error) {
      if ((error as { name?: string })?.name !== "NotFoundError") {
        console.warn(`[sandbox:modal] prewarm destroy(${sandboxId}):`, error);
      }
    }
  },

  async listPrewarmed() {
    const client = await modalClient();
    const app = await modalApp(client);
    const out: Array<{ id: string; key: string }> = [];
    for await (const sandbox of client.sandboxes.list({
      appId: app.appId,
      tags: { [PREWARM_LABEL]: "1" },
    })) {
      if ((await sandbox.poll()) !== null) continue;
      const tags: Record<string, string> = await sandbox
        .getTags()
        .catch(() => ({}) as Record<string, string>);
      out.push({
        id: sandbox.sandboxId,
        key: String(tags[PREWARM_KEY_LABEL] || ""),
      });
    }
    return out;
  },
};

/** Bounded account + native filesystem-image qualification used by Settings. */
export async function qualifyModalConnection(): Promise<void> {
  const cfg = modalConfig();
  const client = await modalClient();
  const suffix = crypto.randomUUID().slice(0, 12);
  const app = await modalApp(client);
  let source: ModalSandbox | undefined;
  let restored: ModalSandbox | undefined;
  let imageId: string | undefined;
  try {
    const baseImage = client.images.fromRegistry(
      cfg.modal?.image || DEFAULT_IMAGE,
    );
    source = await client.sandboxes.create(app, baseImage, {
      tags: { "opensession.qualification": suffix },
      timeoutMs: 30 * 60_000,
      idleTimeoutMs: 10 * 60_000,
      cpu: cfg.cpus,
      cpuLimit: cfg.cpus,
      memoryMiB: memoryMiB(cfg.memory),
      memoryLimitMiB: memoryMiB(cfg.memory),
      regions: cfg.modal?.region ? [cfg.modal.region] : undefined,
      cloud: cfg.modal?.cloud,
      encryptedPorts: [8765],
    });
    const probe = await modalDriver(source).exec(
      "set -eu; uname -s; printf opensession-qualified > /tmp/opensession-qualification",
      { timeoutMs: 60_000 },
    );
    if (probe.exitCode !== 0)
      throw new Error("Modal qualification command failed");
    const semantics = await modalDriver(source).exec(
      "printf qualification-out; printf qualification-err >&2; exit 7",
      { timeoutMs: 60_000 },
    );
    if (
      semantics.exitCode !== 7 ||
      !semantics.stdout.includes("qualification-out") ||
      !semantics.stderr.includes("qualification-err")
    ) {
      throw new Error(
        "Modal exec stream or exit-code semantics are incompatible",
      );
    }
    await modalDriver(source).writeFile("/tmp/opensession-upload", "uploaded");
    const upload = await modalDriver(source).exec(
      'test "$(cat /tmp/opensession-upload)" = uploaded',
    );
    if (upload.exitCode !== 0)
      throw new Error("Modal file upload check failed");
    const tunnels = await source.tunnels(60_000);
    if (!tunnels[8765]?.url.startsWith("https://")) {
      throw new Error("Modal encrypted tunnel discovery failed");
    }
    const image = await source.snapshotFilesystem({
      timeoutMs: 10 * 60_000,
      ttlMs: 60 * 60_000,
    });
    imageId = image.imageId;
    restored = await client.sandboxes.create(
      app,
      await client.images.fromId(imageId),
      {
        tags: { "opensession.qualification": `${suffix}-restore` },
        timeoutMs: 30 * 60_000,
        idleTimeoutMs: 10 * 60_000,
      },
    );
    if (restored.sandboxId === source.sandboxId) {
      throw new Error("Modal filesystem restore was not distinct");
    }
    const restoreProbe = await modalDriver(restored).exec(
      'test "$(cat /tmp/opensession-qualification)" = opensession-qualified',
      { timeoutMs: 60_000 },
    );
    if (restoreProbe.exitCode !== 0) {
      throw new Error(
        "Modal qualification image did not restore filesystem state",
      );
    }
  } finally {
    await restored?.terminate().catch(() => {});
    await source?.terminate().catch(() => {});
    if (imageId) await client.images.delete(imageId).catch(() => {});
  }
  for await (const sandbox of client.sandboxes.list({
    appId: app.appId,
    tags: { "opensession.qualification": suffix },
  })) {
    if ((await sandbox.poll()) === null) {
      throw new Error("Modal qualification cleanup left a sandbox behind");
    }
  }
}

export async function deleteModalTemplateArtifact(
  artifactId: string,
): Promise<void> {
  const client = await modalClient();
  await client.images.delete(artifactId).catch(() => {});
}
