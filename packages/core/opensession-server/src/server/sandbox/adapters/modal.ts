/**
 * ModalProvider: Linux Sandboxes on Modal (https://modal.com), optionally
 * with an NVIDIA GPU (T4 or L4) for work that needs one, such as GPU render
 * tests.
 *
 * Shape (shared machinery in ./bootstrap.ts, the Linux guest layout):
 *  - Control plane: Modal's TypeScript SDK with the workspace's token. Every
 *    machine is a Modal Sandbox in one Modal App, created from a base image
 *    built here (Ubuntu with build tools, Rust, and the Vulkan and GL
 *    runtime the NVIDIA driver needs) or from a project snapshot.
 *  - Guest access: `exec` over Modal's command router, and the Sandbox agent
 *    once it dials out (agent-driver.ts). Commands run as root with
 *    HOME=/home/ubuntu.
 *  - Disk: a Modal Sandbox cannot be stopped and started. Sleep saves the
 *    whole filesystem as an image and terminates the container; wake creates
 *    a new container from that image. The session's Sandbox id is therefore
 *    stable (`md-<session>`) and the state file's `remoteId` names the
 *    current container. A container lives at most 24 hours; one close to
 *    that is cycled through a sleep on its next start.
 *  - GPU: chosen when a container is created (`resources.gpu` in the state
 *    file), so a wake keeps it and a project snapshot serves any GPU. Modal
 *    injects the NVIDIA driver with CUDA and Vulkan; the base image carries
 *    the GL dispatch libraries Vulkan's NVIDIA driver loads through.
 *  - Project snapshots are filesystem images too. Prewarms never carry a
 *    GPU: a GPU session starts from the project snapshot instead.
 *  - Terminal tabs are an exec with a PTY. Portals ride the outbound relay
 *    like every remote provider.
 */

import type {
  App as ModalApp,
  ContainerProcess,
  Image as ModalImage,
  ModalClient,
  Sandbox as ModalSandbox,
} from "modal";
import { getRepo, worktreePathFor } from "../../worktree";
import {
  getSandboxConnection,
  sandboxProviderCredential,
  type SandboxConnectionSettings,
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
  type RemoteSandboxOwner,
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
  type RemoteSandboxState,
} from "./bootstrap";
import { launchSandboxAgent, withSandboxAgent } from "../agent-driver";
import { revokeSandboxAgent } from "../agent-channel";
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  PREWARM_KEY_LABEL,
  PREWARM_LABEL,
  type PrewarmAdapter,
  type SandboxMachineSettings,
} from "../prewarm";
import {
  invalidateRemoteRepoTemplate,
  readRemoteRepoTemplate,
  sealRemoteRepoTemplate,
  writeRemoteRepoTemplate,
} from "../remote-repo-template";
import {
  sandboxAgentEnabled,
  sandboxConfig,
  sandboxGpu,
  type SandboxGpu,
} from "../config";
import { MODAL_BASE_IMAGE_COMMANDS } from "./modal-image";

const PROVIDER = "modal" as const;
const SANDBOX_PREFIX = "md-";
export const DEFAULT_MODAL_APP = "opensession-sandboxes";
export const DEFAULT_MODAL_BASE_IMAGE = "ubuntu:24.04";
export type ModalGpu = SandboxGpu;
/** Modal's ceiling for one container's life. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** A container this old is cycled through a sleep before it is used again,
 *  so a turn never runs into the 24-hour ceiling. */
const RECYCLE_AFTER_MS = 22 * 60 * 60_000;
const DEFAULT_IDLE_STOP_MINUTES = 30;
/** Modal's own idle timer: the last backstop, for a container whose agent
 *  exited and that nothing else touches (Open Session sleeps it sooner). */
const MODAL_IDLE_BACKSTOP_MS = 90 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 20 * 60_000;
/** Sleep images expire on Modal after this long; a later wake falls back to
 *  the session's last checkpoint. */
const SLEEP_IMAGE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Project snapshots are replaced when their inputs change; the expiry only
 *  catches one whose deletion was lost to a restart. */
const TEMPLATE_IMAGE_TTL_MS = 90 * 24 * 60 * 60_000;
/** A replaced project snapshot is deleted this much later, so a container
 *  being created from it at that moment still starts. */
const TEMPLATE_RETIRE_DELAY_MS = 10 * 60_000;
const CONTROL_TIMEOUT_MS = 30_000;
/** How long a new container may wait for a machine (a GPU) before it runs
 *  its first command. */
const START_TIMEOUT_MS = 10 * 60_000;

const L = remoteLayout("linux");

/** A GPU Sandbox's floor: the work that needs a GPU (native render builds)
 *  is also compile-heavy, so it never gets less than this. */
const GPU_MIN_CPU = 8;
const GPU_MIN_MEMORY_MIB = 32_768;

/** The container's shape: the project's Modal size (Medium by default),
 *  raised to the GPU floor when the session carries a GPU. */
export function modalMachineShape(
  resources: SandboxMachineSettings | undefined,
): { cpu: number; memoryMiB: number; gpu?: ModalGpu } {
  const gpu = modalGpu(resources?.gpu);
  const cpu = resources?.cpu || 4;
  const memoryMiB = resources?.memoryMb || 16_384;
  return gpu
    ? {
        cpu: Math.max(cpu, GPU_MIN_CPU),
        memoryMiB: Math.max(memoryMiB, GPU_MIN_MEMORY_MIB),
        gpu,
      }
    : { cpu, memoryMiB };
}

export const modalGpu = sandboxGpu;

// ── Base image ───────────────────────────────────────────────────────────────

function baseImage(c: ModalClient): ModalImage {
  const settings = modalSettings(getSandboxConnection(PROVIDER)?.settings);
  return c.images
    .fromRegistry(settings.image || DEFAULT_MODAL_BASE_IMAGE)
    .dockerfileCommands([...MODAL_BASE_IMAGE_COMMANDS]);
}

// ── Settings and client ──────────────────────────────────────────────────────

export interface ModalSettings {
  tokenId?: string;
  app: string;
  environment?: string;
  image?: string;
  region?: string;
  cloud?: string;
}

export function modalSettings(
  raw: SandboxConnectionSettings | undefined,
): ModalSettings {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    app: text(raw?.app) || DEFAULT_MODAL_APP,
    ...(text(raw?.tokenId) ? { tokenId: text(raw?.tokenId) } : {}),
    ...(text(raw?.environment) ? { environment: text(raw?.environment) } : {}),
    ...(text(raw?.image) ? { image: text(raw?.image) } : {}),
    ...(text(raw?.region) ? { region: text(raw?.region) } : {}),
    ...(text(raw?.cloud) ? { cloud: text(raw?.cloud) } : {}),
  };
}

/** The stored secret is the token secret; `tokenId:tokenSecret` in one
 *  value also works (what `modal token new` prints, pasted as one line). */
export function modalCredentials(
  secret: string | undefined,
  tokenId: string | undefined,
): { tokenId: string; tokenSecret: string } | null {
  const value = secret?.trim();
  if (!value) return null;
  const pair = value.match(/^(ak-[A-Za-z0-9]+)\s*[:\s]\s*(as-[A-Za-z0-9]+)$/);
  if (pair) return { tokenId: pair[1]!, tokenSecret: pair[2]! };
  return tokenId ? { tokenId, tokenSecret: value } : null;
}

type ClientCache = { key: string; client: ModalClient };
type AppCache = { client: ModalClient; name: string; app: Promise<ModalApp> };
const cache = globalThis as typeof globalThis & {
  __opensessionModalClient?: ClientCache;
  __opensessionModalApp?: AppCache;
};

async function modalClient(): Promise<ModalClient> {
  const settings = modalSettings(getSandboxConnection(PROVIDER)?.settings);
  const credentials = modalCredentials(
    sandboxProviderCredential(PROVIDER)?.apiKey,
    settings.tokenId,
  );
  if (!credentials)
    throw new Error(
      "Modal is not connected: add a token id and secret in Workspace > Sandboxes",
    );
  const key = JSON.stringify([
    credentials.tokenId,
    credentials.tokenSecret,
    settings.environment,
  ]);
  if (cache.__opensessionModalClient?.key === key)
    return cache.__opensessionModalClient.client;
  const { ModalClient } = await import("modal");
  const client = new ModalClient({
    tokenId: credentials.tokenId,
    tokenSecret: credentials.tokenSecret,
    ...(settings.environment ? { environment: settings.environment } : {}),
  });
  cache.__opensessionModalClient = { key, client };
  return client;
}

function modalApp(client: ModalClient): Promise<ModalApp> {
  const name = modalSettings(getSandboxConnection(PROVIDER)?.settings).app;
  const cached = cache.__opensessionModalApp;
  if (cached?.client === client && cached.name === name) return cached.app;
  const app = client.apps.fromName(name, { createIfMissing: true });
  const record = { client, name, app };
  cache.__opensessionModalApp = record;
  app.catch(() => {
    if (cache.__opensessionModalApp === record)
      delete cache.__opensessionModalApp;
  });
  return app;
}

/** Promise.race that keeps a late failure from becoming an unhandled
 *  rejection after the deadline won. */
async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
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

function notFound(error: unknown): boolean {
  const detail = error as { name?: string; message?: string; code?: unknown };
  return (
    detail?.name === "NotFoundError" ||
    detail?.code === 5 ||
    /not.?found|no longer exists|expired|deleted/i.test(detail?.message || "")
  );
}

// ── Containers ───────────────────────────────────────────────────────────────

export function modalSandboxId(sessionId: string): string {
  return `${SANDBOX_PREFIX}${sessionId}`;
}

/** Only states this adapter wrote. Files from the retired Modal provider
 *  name a container id (`sb-…`) and point at images two providers old: they
 *  read as gone, and the session continues from its last checkpoint. */
function readState(sandboxId: string): RemoteSandboxState | null {
  if (!sandboxId.startsWith(SANDBOX_PREFIX)) return null;
  return readRemoteState(PROVIDER, sandboxId);
}

function findState(sessionId: string): RemoteSandboxState | null {
  const state = findRemoteStateBySession(PROVIDER, sessionId);
  return state?.sandboxId.startsWith(SANDBOX_PREFIX) ? state : null;
}

async function createContainer(
  c: ModalClient,
  options: {
    image: ModalImage;
    resources?: SandboxMachineSettings;
    tags?: Record<string, string>;
  },
): Promise<ModalSandbox> {
  const settings = modalSettings(getSandboxConnection(PROVIDER)?.settings);
  const shape = modalMachineShape(options.resources);
  const app = await modalApp(c);
  return c.sandboxes.create(app, options.image, {
    cpu: shape.cpu,
    memoryMiB: shape.memoryMiB,
    ...(shape.gpu ? { gpu: shape.gpu } : {}),
    timeoutMs: MAX_LIFETIME_MS,
    idleTimeoutMs: MODAL_IDLE_BACKSTOP_MS,
    // Every exec inherits these: the Linux guest layout's home and PATH.
    env: { HOME: L.home, PATH: L.path },
    workdir: L.home,
    ...(settings.region ? { regions: [settings.region] } : {}),
    ...(settings.cloud ? { cloud: settings.cloud } : {}),
    ...(options.tags ? { tags: options.tags } : {}),
  });
}

/** The container behind `remoteId` while it runs, else null. */
async function liveContainer(
  c: ModalClient,
  remoteId: string | undefined,
): Promise<ModalSandbox | null> {
  if (!remoteId) return null;
  try {
    const sandbox = await withDeadline(
      c.sandboxes.fromId(remoteId),
      CONTROL_TIMEOUT_MS,
      `Modal lookup of ${remoteId}`,
    );
    const exit = await withDeadline(
      sandbox.poll(),
      CONTROL_TIMEOUT_MS,
      `Modal poll of ${remoteId}`,
    );
    return exit === null ? sandbox : null;
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function terminateContainer(
  c: ModalClient,
  remoteId: string | undefined,
): Promise<void> {
  if (!remoteId) return;
  try {
    const sandbox = await c.sandboxes.fromId(remoteId);
    await withDeadline(
      sandbox.terminate(),
      CONTROL_TIMEOUT_MS,
      `Modal terminate of ${remoteId}`,
    );
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

function deleteImage(c: ModalClient, imageId: string | undefined): void {
  if (!imageId) return;
  void c.images.delete(imageId).catch((error) => {
    if (!notFound(error))
      console.warn(`[sandbox:modal] could not delete image ${imageId}:`, error);
  });
}

// ── Driver ───────────────────────────────────────────────────────────────────

/** A RemoteDriver over one container. Resolves the container lazily, so a
 *  handle can be built without a round trip. */
export function modalDriver(
  c: ModalClient,
  remoteId: string | undefined,
): RemoteDriver {
  let container: Promise<ModalSandbox> | undefined;
  const resolveContainer = () => {
    if (!remoteId)
      return Promise.reject(
        new Error("the Modal Sandbox is asleep; wake it first"),
      );
    container ??= c.sandboxes.fromId(remoteId).catch((error) => {
      container = undefined;
      throw error;
    });
    return container;
  };
  const driver: RemoteDriver = {
    os: "linux",
    home: L.home,
    async exec(cmd: string, opts?: RemoteExecOpts) {
      const timeoutMs = opts?.timeoutMs ?? 120_000;
      // ContainerProcess has no kill in modal@0.9; closing stdin is the
      // cancellation boundary that releases a wedged stream.
      let process: ContainerProcess<string> | undefined;
      try {
        const sandbox = await resolveContainer();
        const running: ContainerProcess<string> = await withDeadline(
          sandbox.exec(["bash", "-c", cmd], {
            ...(opts?.cwd ? { workdir: opts.cwd } : {}),
            ...(opts?.env ? { env: opts.env } : {}),
            timeoutMs,
            stdout: "pipe",
            stderr: "pipe",
          }),
          Math.min(timeoutMs, CONTROL_TIMEOUT_MS),
          "Modal exec launch",
        );
        process = running;
        const [stdout, stderr, exitCode] = await withDeadline(
          Promise.all([
            running.stdout.readText(),
            running.stderr.readText(),
            running.wait(),
          ]),
          timeoutMs + 5_000,
          "Modal exec",
        );
        return { exitCode, stdout, stderr };
      } catch (error) {
        await process?.closeStdin().catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        return {
          exitCode: /did not settle/.test(message) ? 124 : 1,
          stdout: "",
          stderr: message,
        };
      }
    },
    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      // Modal's exec timeout is the child's lifetime; the RemoteDriver
      // timeout is only the launch deadline. Output is discarded: callers get
      // no process handle.
      const sandbox = await resolveContainer();
      await withDeadline(
        sandbox.exec(["bash", "-c", `( ${cmd}\n) >/dev/null 2>&1`], {
          ...(opts?.cwd ? { workdir: opts.cwd } : {}),
          ...(opts?.env ? { env: opts.env } : {}),
          stdout: "ignore",
          stderr: "ignore",
        }),
        opts?.timeoutMs ?? CONTROL_TIMEOUT_MS,
        "Modal background exec launch",
      );
    },
    async writeFile(path: string, content: string) {
      // Streamed through stdin: the SDK's filesystem writer relies on
      // ReadableStream.from, which Bun lacks.
      const sandbox = await resolveContainer();
      let process: ContainerProcess<string> | undefined;
      try {
        await withDeadline(
          (async () => {
            const writer: ContainerProcess<string> = await sandbox.exec(
              [
                "bash",
                "-c",
                `mkdir -p "$(dirname ${shellQuoteWord(path)})" && cat > ${shellQuoteWord(path)}`,
              ],
              { timeoutMs: 120_000, stdout: "ignore", stderr: "pipe" },
            );
            process = writer;
            await writer.stdin.writeText(content);
            await writer.stdin.close();
            const exitCode = await writer.wait();
            if (exitCode !== 0)
              throw new Error(
                `Modal writeFile(${path}) failed: ${(await writer.stderr.readText()).slice(0, 300)}`,
              );
          })(),
          125_000,
          `Modal writeFile(${path})`,
        );
      } catch (error) {
        await process?.closeStdin().catch(() => {});
        throw error;
      }
    },
    async ensureStarted() {
      // A container that has not exited may still be waiting for a machine:
      // a GPU can take minutes to schedule. It is started once it runs a
      // command; until then every exec launch times out.
      const sandbox = await resolveContainer();
      const deadline = Date.now() + START_TIMEOUT_MS;
      let lastError = "";
      while (true) {
        const exit = await withDeadline(
          sandbox.poll(),
          CONTROL_TIMEOUT_MS,
          "Modal poll",
        );
        if (exit !== null)
          throw new Error(
            `Modal Sandbox ${remoteId} is not running (exit ${exit})`,
          );
        const probe = await driver.exec("true", { timeoutMs: 20_000 });
        if (probe.exitCode === 0) return;
        lastError = probe.stderr.trim().slice(0, 200);
        if (Date.now() >= deadline)
          throw new Error(
            `Modal Sandbox ${remoteId} did not start within ${START_TIMEOUT_MS / 60_000} minutes: ${lastError}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    },
  };
  return driver;
}

/** A session container's driver: the Sandbox agent's socket while it is
 *  connected, Modal's exec otherwise (agent-driver.ts). Keyed by the stable
 *  Sandbox id: a wake lands on a new container, whose agent replaces the
 *  old. */
function sessionModalDriver(
  c: ModalClient,
  sandboxId: string,
  remoteId: string | undefined,
): RemoteDriver {
  return withSandboxAgent(modalDriver(c, remoteId), {
    providerId: PROVIDER,
    sandboxId,
  });
}

async function launchModalAgent(
  c: ModalClient,
  sandboxId: string,
  remoteId: string,
): Promise<boolean> {
  if (!sandboxAgentEnabled(PROVIDER)) return false;
  return launchSandboxAgent(modalDriver(c, remoteId), {
    providerId: PROVIDER,
    sandboxId,
  });
}

/** One line on what the GPU looks like from inside, for the start log:
 *  the device and whether Vulkan sees it (render engines need both). */
async function describeGpu(driver: RemoteDriver): Promise<string> {
  const probe = await driver.exec(
    "nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1 | head -1; " +
      "vulkaninfo --summary 2>/dev/null | grep -m1 -E 'deviceType' | sed 's/.*= *//'",
    { timeoutMs: 60_000 },
  );
  return probe.stdout.trim().replace(/\n/g, ", ") || probe.stderr.trim();
}

// ── Sleep and wake ───────────────────────────────────────────────────────────

async function sandboxStatus(
  c: ModalClient,
  state: RemoteSandboxState | null,
): Promise<SandboxStatus> {
  if (!state) return "gone";
  if (state.remoteId && (await liveContainer(c, state.remoteId)))
    return "running";
  return state.checkpointArtifactId ? "stopped" : "gone";
}

/** Sleep: save the filesystem as an image, then terminate the container. */
export async function pauseModalSandbox(sandboxId: string): Promise<void> {
  const state = readState(sandboxId);
  if (!state?.remoteId) return;
  const c = await modalClient();
  const container = await liveContainer(c, state.remoteId);
  if (!container) {
    writeRemoteState({ ...state, remoteId: undefined });
    return;
  }
  // The agent dies with the container; a wake launches a fresh one on the
  // next. Revoke first so nothing is routed to a closing socket.
  revokeSandboxAgent(sandboxId, "asleep");
  const image = await container.snapshotFilesystem({
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    ttlMs: SLEEP_IMAGE_TTL_MS,
  });
  await terminateContainer(c, state.remoteId);
  const previous = state.checkpointArtifactId;
  writeRemoteState({
    ...state,
    remoteId: undefined,
    remoteStartedAt: undefined,
    checkpointArtifactId: image.imageId,
    checkpointCreatedAt: new Date().toISOString(),
  });
  if (previous !== image.imageId) deleteImage(c, previous);
}

/** Sleep a container whose preparation failed, so it stops billing; if the
 *  snapshot fails too, terminate it (the session continues from its last
 *  checkpoint, as after any lost machine). */
async function releaseFailedContainer(
  c: ModalClient,
  sandboxId: string,
  remoteId: string,
  mark: (stage: string) => void,
): Promise<void> {
  try {
    await pauseModalSandbox(sandboxId);
    mark("preparation failed; container asleep");
  } catch (error) {
    console.warn(
      `[sandbox:modal] could not sleep ${sandboxId} after a failed start; terminating it:`,
      error instanceof Error ? error.message : String(error),
    );
    await terminateContainer(c, remoteId).catch((terminateError) =>
      console.error(
        `[sandbox:modal] could not terminate ${remoteId}:`,
        terminateError,
      ),
    );
    const state = readState(sandboxId);
    if (state)
      writeRemoteState({
        ...state,
        remoteId: undefined,
        remoteStartedAt: undefined,
      });
    mark("preparation failed; container terminated");
  }
}

/** A new container from the sleep image, or null when the image is gone. */
async function restoreFromSleep(
  c: ModalClient,
  state: RemoteSandboxState,
): Promise<ModalSandbox | null> {
  if (!state.checkpointArtifactId) return null;
  try {
    const image = await c.images.fromId(state.checkpointArtifactId);
    return await createContainer(c, {
      image,
      resources: state.resources,
    });
  } catch (error) {
    if (!notFound(error)) throw error;
    console.warn(
      `[sandbox:modal] sleep image ${state.checkpointArtifactId} of ${state.sandboxId} is gone:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class ModalProvider implements SandboxProvider {
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
        `[sandbox:modal] ${spec.sessionId}: ${stage} (+${Date.now() - startedAt}ms)`,
      );
    if (spec.attachedDirs?.length)
      throw new Error(
        "attached repos are not supported in remote sandboxes; detach them or run on this machine",
      );
    if (spec.trustProfile === "automation")
      throw new Error(
        "Modal Sandboxes do not run automations yet; automations stay on Daytona",
      );
    const c = await modalClient();
    let prevState = findState(spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd ||
      prevState?.cwd ||
      worktreePathFor(branch, repo.id, { isolated: true });
    const sandboxId = prevState?.sandboxId || modalSandboxId(spec.sessionId);
    // The machine a session asked for: its GPU choice, else the one its
    // container was created with, else the project's Modal machine size.
    const { sandboxEnvironmentSettings } = await import("../environments");
    const project = sandboxEnvironmentSettings(repo.id, PROVIDER);
    const resources: SandboxMachineSettings = {
      ...(project || {}),
      ...(prevState?.resources || {}),
    };
    const gpu = modalGpu(spec.gpu) ?? modalGpu(resources.gpu);
    if (gpu) resources.gpu = gpu;
    else delete resources.gpu;

    // A container near Modal's 24-hour ceiling, or created with another
    // GPU, is cycled through a sleep so the disk carries over.
    if (prevState?.remoteId) {
      const tooOld =
        prevState.remoteStartedAt &&
        Date.now() - Date.parse(prevState.remoteStartedAt) > RECYCLE_AFTER_MS;
      const otherGpu =
        modalGpu(prevState.resources?.gpu) !== gpu && spec.gpu !== undefined;
      if (tooOld || otherGpu) {
        mark(tooOld ? "recycling a container near 24 hours" : "changing GPU");
        await pauseModalSandbox(sandboxId);
        prevState = readState(sandboxId);
      }
    }

    let container: ModalSandbox | null = null;
    let resuming = false;
    let bootMode: "fresh" | "snapshot-restore" = "fresh";
    if (prevState?.remoteId)
      container = await liveContainer(c, prevState.remoteId);
    if (!container && prevState?.checkpointArtifactId) {
      container = await restoreFromSleep(c, { ...prevState, resources });
      if (container) {
        resuming = true;
        mark("restored from the sleep image");
      }
    }
    // Prewarms carry no GPU; a GPU session starts from the project snapshot.
    if (!container && !gpu) {
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        const candidate = await liveContainer(c, claim.sandboxId);
        if (candidate) {
          container = candidate;
          await candidate
            .setTags({ [PREWARM_LABEL]: "adopted" })
            .catch(() => {});
          console.log(
            `[sandbox:modal] adopted prewarmed container ${candidate.sandboxId} for ${spec.sessionId}`,
          );
        } else discardClaimedPrewarm(this.id, claim.sandboxId);
      }
    }
    if (!container) {
      const template = readRemoteRepoTemplate(this.id, repo.id);
      if (template) {
        try {
          container = await createContainer(c, {
            image: await c.images.fromId(template.artifactId),
            resources,
          });
          bootMode = "snapshot-restore";
        } catch (error) {
          if (!notFound(error)) throw error;
          invalidateRemoteRepoTemplate(this.id, repo.id);
          console.warn(
            `[sandbox:modal] project snapshot ${template.artifactId} is gone; starting from the base image`,
          );
        }
      }
      container ??= await createContainer(c, {
        image: baseImage(c),
        resources,
      });
      mark(`container created${gpu ? ` with an ${gpu}` : ""}`);
    }

    const remoteId = container.sandboxId;
    const sameContainer = prevState?.remoteId === remoteId;
    const state: RemoteSandboxState = {
      sandboxId,
      remoteId,
      remoteStartedAt:
        sameContainer && prevState?.remoteStartedAt
          ? prevState.remoteStartedAt
          : new Date().toISOString(),
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      resources,
      ...(resuming || !prevState?.checkpointArtifactId
        ? {}
        : {
            checkpointArtifactId: prevState.checkpointArtifactId,
            checkpointCreatedAt: prevState.checkpointCreatedAt,
          }),
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    };
    writeRemoteState(state);

    try {
      return await this.prepareContainer(c, spec, {
        sandboxId,
        remoteId,
        sameContainer,
        resuming,
        bootMode,
        prevState,
        repo,
        branch,
        cwd,
        gpu,
        trust,
        mark,
      });
    } catch (error) {
      // A GPU bills by the second. A container whose preparation failed
      // (a repository setup script, a dial-back) does no work, so it sleeps
      // now instead of holding the GPU until the idle sweep.
      if (gpu) await releaseFailedContainer(c, sandboxId, remoteId, mark);
      throw error;
    }
  }

  private async prepareContainer(
    c: ModalClient,
    spec: SandboxSessionSpec,
    ctx: {
      sandboxId: string;
      remoteId: string;
      sameContainer: boolean;
      resuming: boolean;
      bootMode: "fresh" | "snapshot-restore";
      prevState: RemoteSandboxState | null;
      repo: ReturnType<typeof getRepo>;
      branch: string;
      cwd: string;
      gpu: ModalGpu | undefined;
      trust: ReturnType<typeof resolveTrustPolicy>;
      mark: (stage: string) => void;
    },
  ): Promise<Sandbox> {
    const {
      sandboxId,
      remoteId,
      sameContainer,
      resuming,
      bootMode,
      prevState,
      repo,
      branch,
      cwd,
      gpu,
      trust,
      mark,
    } = ctx;
    const driver = modalDriver(c, remoteId);
    await driver.ensureStarted();
    await assertDialbackReachable(driver, this.id);
    mark("dial-back verified");
    // Only now: a container still being scheduled reads its image, and
    // deleting that image underneath it shut the container down.
    if (resuming) deleteImage(c, prevState?.checkpointArtifactId);
    await bootstrapRemoteSandbox(driver, this.id);
    mark("runtime ready");
    if (!sameContainer && (await launchModalAgent(c, sandboxId, remoteId)))
      mark("agent connected");
    if (gpu && !sameContainer) mark(`GPU: ${await describeGpu(driver)}`);
    await setupRemoteWorkspace(
      sessionModalDriver(c, sandboxId, remoteId),
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
    if (resuming) {
      await runResumeHook(
        sessionModalDriver(c, sandboxId, remoteId),
        this.id,
        sandboxId,
        {
          cwd,
          sessionId: spec.sessionId,
          repoId: repo.id,
          trustProfile: trust.trustProfile,
        },
      );
      mark("resume hook ran");
    }
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
    c: ModalClient,
    sandboxId: string,
    remoteId: string | undefined,
    owner: RemoteSandboxOwner,
  ): Sandbox {
    const providerId = this.id;
    return makeRemoteSandbox({
      ...owner,
      providerId,
      sandboxId,
      driver: sessionModalDriver(c, sandboxId, remoteId),
      // Container ports are reachable only through Modal tunnels; every
      // Portal rides the outbound relay, which needs no published port.
      async ports(): Promise<PortMap> {
        return {};
      },
      status: () => sandboxStatus(c, readState(sandboxId)),
      touchActivity: () => touchRemoteState(providerId, sandboxId),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readState(sandboxId);
    if (!state) return null;
    try {
      const c = await modalClient();
      if ((await sandboxStatus(c, state)) === "gone") return null;
      return this.makeHandle(c, sandboxId, state.remoteId, state);
    } catch (error) {
      console.warn(`[sandbox:modal] get(${sandboxId}) failed:`, error);
      return null;
    }
  }

  async pause(sandboxId: string): Promise<void> {
    await pauseModalSandbox(sandboxId);
  }

  machineFor(sessionId: string): string | undefined {
    return findState(sessionId)?.sandboxId;
  }

  /** Any exec resets Modal's own idle timer. */
  async keepAlive(sandboxId: string): Promise<void> {
    const state = readState(sandboxId);
    if (!state?.remoteId) return;
    const c = await modalClient();
    await modalDriver(c, state.remoteId).exec("true", { timeoutMs: 30_000 });
  }

  async resume(sandboxId: string): Promise<Sandbox | null> {
    const state = readState(sandboxId);
    if (!state) return null;
    // ensure() owns every path back to a running container, including the
    // repository hooks a wake runs.
    return this.ensure({
      sessionId: state.sessionId,
      repo: state.repoId,
      branch: state.branch,
      cwd: state.cwd,
      trustProfile: state.trustProfile,
      egressAllowlist: state.egressAllowlist,
    });
  }

  /** Terminates the container and deletes its sleep image, and with them
   *  the workspace (the session continues from its last checkpoint). */
  async destroy(
    sandboxId: string,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const state = readState(sandboxId);
    try {
      const c = await modalClient();
      // Prewarms and qualification containers carry Modal's own id.
      const remoteId = state ? state.remoteId : sandboxId;
      await terminateContainer(c, remoteId);
      if (options.strict && (await liveContainer(c, remoteId)))
        throw new Error(
          `Modal container ${remoteId} still runs after terminate`,
        );
      deleteImage(c, state?.checkpointArtifactId);
      if (state) removeRemoteState(this.id, sandboxId);
    } catch (error) {
      console.warn(`[sandbox:modal] destroy(${sandboxId}):`, error);
      throw error;
    }
  }
}

// ── Terminal ─────────────────────────────────────────────────────────────────

export interface ModalPtyIo {
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | undefined) => void;
}

/** An interactive login shell in the session's workspace: an exec with a
 *  PTY. Modal has no resize call; a resize sets the size on the shell's tty
 *  from a second exec and signals its foreground process group. */
export async function modalPtySession(
  sandboxId: string,
  cwd: string,
  io: ModalPtyIo,
): Promise<{
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}> {
  const state = readState(sandboxId);
  if (!state?.remoteId) throw new Error("Wake the Sandbox first");
  const c = await modalClient();
  const container = await liveContainer(c, state.remoteId);
  if (!container) throw new Error("Wake the Sandbox first");
  const ttyFile = `/tmp/opensession-tty-${crypto.randomUUID()}`;
  const process = await container.exec(
    [
      "bash",
      "-c",
      `tty > ${ttyFile}; stty cols ${io.cols} rows ${io.rows}; cd ${shellQuoteWord(cwd)} 2>/dev/null; exec bash -il`,
    ],
    {
      pty: true,
      mode: "binary",
      stdout: "pipe",
      env: { TERM: "xterm-256color", HOME: L.home, PATH: L.path },
    },
  );
  let closed = false;
  void (async () => {
    try {
      for await (const chunk of process.stdout) io.onData(chunk);
    } catch {}
    const code = await process.wait().catch(() => undefined);
    if (!closed) io.onExit(code);
  })();
  const writer = process.stdin;
  return {
    write(data) {
      void writer.writeBytes(data).catch(() => {});
    },
    resize(cols, rows) {
      void modalDriver(c, state.remoteId).exec(
        `t=$(cat ${ttyFile} 2>/dev/null) && [ -n "$t" ] && stty -F "$t" cols ${Math.round(cols)} rows ${Math.round(rows)} && pkill -WINCH -t "\${t#/dev/}"`,
        { timeoutMs: 15_000 },
      );
    },
    close() {
      closed = true;
      void writer.close().catch(() => {});
      void modalDriver(c, state.remoteId).exec(
        `t=$(cat ${ttyFile} 2>/dev/null) && [ -n "$t" ] && pkill -HUP -t "\${t#/dev/}"; rm -f ${ttyFile}`,
        { timeoutMs: 15_000 },
      );
    },
  };
}

// ── Idle backstop ────────────────────────────────────────────────────────────

/** Sleep containers nothing has touched for `idleStopMinutes`: the backstop
 *  behind the server's two idle timers (sandbox/idle.ts), for a container
 *  that has not been touched since this server started. */
export async function sweepIdleModalSandboxes(
  now = Date.now(),
): Promise<string[]> {
  if (!getSandboxConnection(PROVIDER)) return [];
  const idleMs =
    (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  const stale = listRemoteStates(PROVIDER).filter(
    (state) =>
      state.sandboxId.startsWith(SANDBOX_PREFIX) &&
      state.remoteId &&
      now - Date.parse(state.lastActivityAt || state.createdAt) > idleMs,
  );
  const slept: string[] = [];
  for (const state of stale) {
    const { hostRunBusy } = await import("../../host-registry");
    if (hostRunBusy(state.sessionId)) continue;
    try {
      await pauseModalSandbox(state.sandboxId);
      slept.push(state.sandboxId);
      console.log(
        `[sandbox:modal] slept idle Sandbox ${state.sandboxId} (${state.sessionId})`,
      );
    } catch (error) {
      console.warn(
        `[sandbox:modal] idle sleep of ${state.sandboxId} failed:`,
        error,
      );
    }
  }
  return slept;
}

const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
let idleSweep: ReturnType<typeof setInterval> | undefined;

/** Idempotent; called from boot. */
export function startModalIdleSweep(): void {
  if (idleSweep) return;
  idleSweep = setInterval(() => {
    void sweepIdleModalSandboxes().catch((error) =>
      console.warn("[sandbox:modal] idle sweep failed:", error),
    );
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();
}

// ── Project snapshots + prewarm ──────────────────────────────────────────────

export async function deleteModalTemplateArtifact(
  artifactId: string,
): Promise<void> {
  const c = await modalClient();
  await c.images.delete(artifactId).catch((error) => {
    if (!notFound(error)) throw error;
  });
}

export const modalPrewarmAdapter: PrewarmAdapter = {
  async create(labels, opts) {
    const key = labels[PREWARM_KEY_LABEL] || "";
    const repoId = key.startsWith(`${PROVIDER}:`)
      ? key.slice(PROVIDER.length + 1)
      : "";
    if (!repoId)
      throw new Error(`invalid Modal prewarm key: ${key || "(missing)"}`);
    const c = await modalClient();
    // A prewarm never holds a GPU: it may wait unused for minutes.
    const { gpu: _gpu, ...resources } = opts.resources || {};
    const template = readRemoteRepoTemplate(PROVIDER, repoId);
    let container: ModalSandbox | null = null;
    let restoredFromTemplate = false;
    if (template) {
      try {
        container = await createContainer(c, {
          image: await c.images.fromId(template.artifactId),
          resources,
          tags: labels,
        });
        restoredFromTemplate = true;
      } catch (error) {
        if (!notFound(error)) throw error;
        invalidateRemoteRepoTemplate(PROVIDER, repoId);
      }
    }
    container ??= await createContainer(c, {
      image: baseImage(c),
      resources,
      tags: labels,
    });
    return {
      sandboxId: container.sandboxId,
      driver: modalDriver(c, container.sandboxId),
      restoredFromTemplate,
    };
  },

  async publishTemplate(sandboxId, repo) {
    const c = await modalClient();
    const driver = modalDriver(c, sandboxId);
    await driver.ensureStarted();
    await sealRemoteRepoTemplate(driver, PROVIDER, repo);
    const container = await c.sandboxes.fromId(sandboxId);
    const image = await container.snapshotFilesystem({
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      ttlMs: TEMPLATE_IMAGE_TTL_MS,
    });
    const { previous } = writeRemoteRepoTemplate(
      PROVIDER,
      repo.id,
      image.imageId,
    );
    const retired = previous?.artifactId;
    if (retired && retired !== image.imageId)
      setTimeout(
        () => deleteImage(c, retired),
        TEMPLATE_RETIRE_DELAY_MS,
      ).unref?.();
    console.log(
      `[sandbox:modal] published post-setup repo template ${image.imageId} for ${repo.id}`,
    );
  },

  async destroy(sandboxId) {
    const c = await modalClient();
    await terminateContainer(c, sandboxId);
  },

  async listPrewarmed() {
    const c = await modalClient();
    const app = await modalApp(c);
    const out: Array<{ id: string; key: string }> = [];
    for await (const container of c.sandboxes.list({
      appId: app.appId,
      tags: { [PREWARM_LABEL]: "1" },
    })) {
      if ((await container.poll()) !== null) continue;
      const tags = await container
        .getTags()
        .catch(() => ({}) as Record<string, string>);
      out.push({
        id: container.sandboxId,
        key: String(tags[PREWARM_KEY_LABEL] || ""),
      });
    }
    return out;
  },
};

// ── Qualification ────────────────────────────────────────────────────────────

/** Prove the account end to end on a small CPU container: the base image
 *  builds, exec streams and exit codes, file upload, and a filesystem image
 *  restored into a distinct container (sleep, wake and project snapshots).
 *  No GPU is used. Everything created is removed. */
export async function qualifyModalConnection(
  update: (stage: string, progress?: number) => void = () => undefined,
): Promise<void> {
  try {
    await qualify(update);
  } catch (error) {
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
  const c = await modalClient();
  update("Checking the Modal token", 20);
  await modalApp(c);
  const created: string[] = [];
  let imageId: string | undefined;
  try {
    update("Building the base image and starting a container", 35);
    const source = await createContainer(c, {
      image: baseImage(c),
      resources: { cpu: 1, memoryMb: 2048 },
      tags: { "opensession.qualification": "1" },
    });
    created.push(source.sandboxId);
    const driver = modalDriver(c, source.sandboxId);
    const probe = await driver.exec(
      `set -eu; uname -s; test "$HOME" = ${L.home}; cargo --version; printf opensession-qualified > ~/.opensession-qualification`,
      { timeoutMs: 120_000 },
    );
    if (probe.exitCode !== 0 || !probe.stdout.includes("Linux"))
      throw new Error(
        `Modal container command failed: ${(probe.stderr || probe.stdout).trim().slice(0, 300)}`,
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
      throw new Error("Modal exec streams or exit codes are incompatible");
    await driver.writeFile(`${L.home}/.opensession-upload`, "uploaded");
    const upload = await driver.exec(
      `test "$(cat ${L.home}/.opensession-upload)" = uploaded`,
    );
    if (upload.exitCode !== 0)
      throw new Error("Modal file upload check failed");
    update(
      "Checking filesystem snapshots (sleep, wake, project snapshots)",
      60,
    );
    const image = await source.snapshotFilesystem({
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      ttlMs: 60 * 60_000,
    });
    imageId = image.imageId;
    const restored = await createContainer(c, {
      image,
      resources: { cpu: 1, memoryMb: 2048 },
      tags: { "opensession.qualification": "1" },
    });
    created.push(restored.sandboxId);
    const carried = await modalDriver(c, restored.sandboxId).exec(
      `cat ${L.home}/.opensession-qualification`,
      { timeoutMs: 60_000 },
    );
    if (
      restored.sandboxId === source.sandboxId ||
      carried.stdout.trim() !== "opensession-qualified"
    )
      throw new Error(
        "A container restored from a filesystem image did not carry its files",
      );
    update("Modal is ready", 95);
  } finally {
    for (const id of created)
      await terminateContainer(c, id).catch((error) =>
        console.warn(`[sandbox:modal] qualification cleanup ${id}:`, error),
      );
    deleteImage(c, imageId);
  }
}
