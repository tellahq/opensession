/**
 * E2bProvider — remote sandbox adapter over the E2B API
 * (docs/self-hosting-sandboxes.md).
 *
 * LICENSING: the `e2b` JS SDK (pinned 2.32.0) is **MIT** (verified from the
 * npm `license` field, 2026-07-08); E2B's platform/infra repo is Apache-2.0.
 * Self-hosting their infra is a Terraform/Nomad project (GCP full, AWS beta)
 * — documented for self-hosters, not operated here.
 *
 * Shape (shared machinery in ./bootstrap.ts):
 *  - ensure(): find the session's sandbox by metadata `bksSession=<id>`
 *    (Sandbox.list query), else create from the config template (default
 *    "base" — Debian with git/curl/node/gh preinstalled), then bootstrap the
 *    runner payload + clone the workspace inside (always volume-style).
 *  - Idle model: E2B sandboxes live on a COUNTDOWN (timeoutMs), not an idle
 *    stop — we set it to idleStopMinutes at create and extend it via
 *    setTimeout() on activity. When the countdown expires the sandbox is
 *    KILLED and the workspace is gone (unless it was paused): that is this
 *    provider's sharper version of the volume-mode data-loss contract — push
 *    your work. (Pause/resume snapshotting as a gentler idle-stop is a
 *    documented follow-up.)
 *  - exec(): commands.run takes a shell string and THROWS CommandExitError on
 *    non-zero exit — caught and mapped back to ExecResult (argv callers go
 *    through shellQuote). launchRun uses background commands (they survive
 *    disconnect), WS transport back to `callbackBaseUrl`.
 *  - ports(): `https://` + getHost(port) → PortMap `{url}` entries (E2B's
 *    public-by-default preview domain).
 *
 * The SDK is imported lazily inside methods so opensession boot doesn't load it
 * unless the provider is used. Unconfigured (no apiKey in the config's `e2b`
 * block or E2B_API_KEY) fails loudly at ensure-time.
 */

import type { Sandbox as E2bSandbox } from "e2b";
import { getRepo, worktreePathFor } from "../../worktree";
import { sandboxConfig } from "../config";
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
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  resolveTrustPolicy,
  setupRemoteWorkspace,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";

const SESSION_META = "bksSession";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const DEFAULT_TEMPLATE = "base";
/** Ceiling for background runner processes (the sandbox countdown is the real
 *  lifetime bound). */
const BG_TIMEOUT_MS = 23 * 60 * 60 * 1000;

function idleMs(): number {
  return (
    (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000
  );
}

function apiKeyOrThrow(): string {
  const key = sandboxConfig().e2b?.apiKey || process.env.E2B_API_KEY;
  if (!key) {
    throw new Error(
      'e2b sandbox provider is not configured — set {"e2b":{"apiKey":"…"}} in ~/.opensession-sandbox.json or E2B_API_KEY',
    );
  }
  return key;
}

async function e2bSandboxClass(): Promise<typeof E2bSandbox> {
  const { Sandbox } = await import("e2b");
  return Sandbox;
}

// ── Driver ────────────────────────────────────────────────────────────────────

function e2bDriver(sbx: E2bSandbox): RemoteDriver {
  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      try {
        const r = await sbx.commands.run(cmd, {
          cwd: opts?.cwd,
          envs: opts?.env,
          timeoutMs: opts?.timeoutMs ?? 120_000,
        });
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      } catch (e: any) {
        // CommandExitError implements CommandResult — a non-zero exit, not an
        // infra failure.
        if (typeof e?.exitCode === "number") {
          return {
            exitCode: e.exitCode,
            stdout: e.stdout || "",
            stderr: e.stderr || "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: String(e?.message || e) };
      }
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      await sbx.commands.run(cmd, {
        cwd: opts?.cwd,
        envs: opts?.env,
        background: true,
        timeoutMs: BG_TIMEOUT_MS,
      } as any);
    },

    async writeFile(path: string, content: string) {
      await sbx.files.write(path, content);
    },

    async ensureStarted() {
      // Connect() (used by get/ensure) already resumes a paused sandbox; a
      // killed one is unrecoverable. Extend the countdown so the sandbox
      // doesn't die mid-run.
      try {
        await sbx.setTimeout(idleMs());
      } catch {}
    },
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class E2bProvider implements SandboxProvider {
  readonly id = "e2b" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.attachedDirs?.length) {
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    }
    const apiKey = apiKeyOrThrow();
    const SandboxCls = await e2bSandboxClass();
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd ||
      prevState?.cwd ||
      worktreePathFor(branch, repo.id, { isolated: true });

    let sbx: E2bSandbox | null = null;
    const existingId =
      (await this.findSandboxId(spec.sessionId)) || prevState?.sandboxId;
    if (existingId) {
      try {
        sbx = await SandboxCls.connect(existingId, { apiKey });
      } catch {
        sbx = null; // killed/expired — recreate below
      }
    }
    if (!sbx) {
      console.log(`[sandbox:e2b] creating sandbox for ${spec.sessionId}`);
      sbx = await SandboxCls.create(
        sandboxConfig().e2b?.template || DEFAULT_TEMPLATE,
        {
          apiKey,
          metadata: { [SESSION_META]: spec.sessionId, opensessionSandbox: "1" },
          timeoutMs: idleMs(),
        },
      );
    }

    const driver = e2bDriver(sbx);
    await driver.ensureStarted();
    // Cheap dial-back probe BEFORE the expensive bootstrap (same as the other
    // remote adapters): a sandbox that can't reach our callback URL can never
    // run anything — fail fast with the documented error instead of 30s+ of
    // doomed bootstrap.
    await assertDialbackReachable(driver, "e2b");
    await bootstrapRemoteSandbox(driver, "e2b");
    await setupRemoteWorkspace(
      driver,
      cwd,
      await remoteCloneUrl(repo),
      branch,
      repo.defaultBranch,
      repo.id,
      {
        sandboxId: sbx.sandboxId,
        provider: this.id,
        sessionId: spec.sessionId,
        repoId: repo.id,
        trustProfile: trust.trustProfile,
      },
    );
    writeRemoteState({
      sandboxId: sbx.sandboxId,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    });
    return this.makeHandle(sbx, spec.sessionId, cwd);
  }

  /** Non-waking lookup of the session's sandbox id via the list API. */
  private async findSandboxId(sessionId: string): Promise<string | null> {
    try {
      const apiKey = apiKeyOrThrow();
      const SandboxCls = await e2bSandboxClass();
      const paginator: any = SandboxCls.list({
        apiKey,
        query: { metadata: { [SESSION_META]: sessionId } },
      } as any);
      const infos: any[] = Array.isArray(paginator)
        ? paginator
        : typeof paginator?.nextItems === "function"
          ? await paginator.nextItems()
          : await paginator;
      return infos?.[0]?.sandboxId || null;
    } catch {
      return null;
    }
  }

  private makeHandle(sbx: E2bSandbox, sessionId: string, cwd: string): Sandbox {
    const providerId = this.id;
    return makeRemoteSandbox({
      providerId,
      sandboxId: sbx.sandboxId,
      sessionId,
      cwd,
      driver: e2bDriver(sbx),
      async ports(requestedPorts = []): Promise<PortMap> {
        const map: PortMap = {};
        const ports = new Set([
          ...(sandboxConfig().previewPorts || []),
          ...requestedPorts.filter(
            (port) => Number.isInteger(port) && port > 0 && port <= 65_535,
          ),
        ]);
        for (const port of ports) {
          try {
            map[port] = { url: `https://${sbx.getHost(port)}` };
          } catch (e) {
            console.warn(`[sandbox:e2b] getHost(${port}) failed:`, e);
          }
        }
        return map;
      },
      async status(): Promise<SandboxStatus> {
        try {
          return (await sbx.isRunning()) ? "running" : "stopped";
        } catch {
          return "gone";
        }
      },
      touchActivity: async () => {
        touchRemoteState(providerId, sbx.sandboxId);
        try {
          await sbx.setTimeout(idleMs()); // extend the countdown
        } catch {}
      },
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const SandboxCls = await e2bSandboxClass();
      const sbx = await SandboxCls.connect(sandboxId, {
        apiKey: apiKeyOrThrow(),
      });
      return this.makeHandle(sbx, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:e2b] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  /** Kills the sandbox — and with it the volume-style workspace (documented
   *  data loss: push your work). */
  async destroy(sandboxId: string): Promise<void> {
    try {
      const SandboxCls = await e2bSandboxClass();
      await (SandboxCls as any).kill(sandboxId, { apiKey: apiKeyOrThrow() });
    } catch (e) {
      console.warn(`[sandbox:e2b] destroy(${sandboxId}):`, e);
    }
    removeRemoteState(this.id, sandboxId);
  }
}
