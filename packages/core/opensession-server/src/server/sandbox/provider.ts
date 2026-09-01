/**
 * Sandbox seam (docs/self-hosting-sandboxes.md): the interfaces every execution
 * backend implements. A "sandbox" is where a session's work happens — a git
 * worktree on this host (LocalProvider, src/server/sandbox/local.ts), a
 * Docker container, AWS Lambda MicroVM, or a remote Daytona/E2B/Box/Modal
 * sandbox, all behind these two interfaces.
 *
 * Deliberately small, mirroring the existing run-host layer's idioms:
 *  - `launchRun` takes the same serializable `RunHostSpec` the detached
 *    run-host processes consume (src/runner-host/protocol.ts) and yields the
 *    same `StreamEvent` generator shape as runAgent / runAgentHosted.
 *  - `RunHandle`'s control surface mirrors host-registry's `HostRunControl`
 *    (steer / interruptSteer / cancel returning booleans, `steerable` flag).
 *
 * Sessions opt in at create time; run-session.ts's maybeRunSandboxed routes
 * their prompts through the provider registry, and sessions without a
 * `sandbox` field keep the unchanged in-process host path.
 */

import type { StreamEvent, ImageInput } from "../run-events";
import type { RunAgentOpts } from "../agent-runner";
import type { RunHostSpec } from "../../runner-host/protocol";

/** The provider ids the registry knows (all implemented — see index.ts). */
export type SandboxProviderId =
  | "local"
  | "docker"
  | "daytona"
  | "e2b"
  | "box"
  | "modal"
  /** Parsed only so persisted legacy sessions fail explicitly at dispatch. */
  | "microvm"
  | "lambda-microvm";

/** Selection authority for starting new work on a configured provider. */
export type SandboxProviderUsability =
  | { state: "not_configured"; configured: false; usable: false }
  | { state: "unavailable"; configured: true; usable: false }
  | { state: "unqualified"; configured: true; usable: false }
  | { state: "usable"; configured: true; usable: true };

/**
 * Everything a provider needs to create-or-reuse the sandbox for a session.
 * For the local provider this resolves to a worktree path via the existing
 * worktree.ts helpers; container providers additionally key their
 * container/volume names off `sessionId`.
 */
export interface SandboxSessionSpec {
  /** Open Session session id (bks-…). Container providers name resources by it. */
  sessionId: string;
  /** Registered repo id (worktree.ts REPOS). Defaults to the instance default repo. */
  repo?: string;
  /** Branch for code-mode worktrees. Required unless ask/sharedCheckout/cwd. */
  branch?: string;
  mode?: "ask" | "code" | "scratch";
  /**
   * Already-resolved workspace dir (an existing session's `worktreeDir`).
   * When set, providers reuse it (reviving a cleaned-up worktree from
   * `branch` when the dir is gone) instead of resolving a fresh one.
   */
  cwd?: string;
  /** Stack base: branch the new worktree branches off (createWorktree opts.base). */
  base?: string;
  /**
   * Attached-repo worktree dirs (multi-repo sessions). Bind-mode docker
   * sandboxes mount each at its identical path (plus its repo's common .git)
   * so the agent can cd into them; a change to this set recreates the
   * container on the next ensure. Volume-mode workspaces reject attachments.
   */
  attachedDirs?: string[];
  /** Automation sandboxes fail closed unless the provider can install its
   *  credential-minimal profile and outbound network policy. */
  trustProfile?: "interactive" | "automation";
  /** Hostnames, IPs, CIDRs, or URLs permitted for automation egress. */
  egressAllowlist?: string[];
  /** Force a credential-free HTTPS clone. Public untrusted-source jobs must
   * never receive the configured repository clone credential. */
  cloneCredential?: "configured" | "none";
  /** Prepare only a fresh credential-free source checkout for immutable
   * verification. Skips templates, private seed files, runner bootstrap,
   * dial-back, and repository lifecycle hooks. */
  sourceVerification?: boolean;
}

export interface ExecOpts {
  /** Extra env for the command (merged over the provider's baseline). */
  env?: Record<string, string>;
  /** Requested deadline for providers that support command cancellation. */
  timeoutMs?: number;
  /**
   * Run through a provider-native detached process when available. Use this
   * for long workspace work that must not block an agent launch on the same
   * sandbox.
   */
  background?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One published sandbox port. Docker publishes to a loopback host port
 *  (Caddy fronts it); remote providers only hand out a preview URL on their
 *  own domain — either field may be present. */
export interface PortEntry {
  /** Host loopback port the sandbox port is published on (docker). */
  hostPort?: number;
  /** Caddy-reachable dial address for private runtimes that do not publish a
   *  loopback port (for example a local Firecracker guest veth). */
  upstream?: string;
  /** Direct preview URL (remote providers' port-forward domains). */
  url?: string;
  /** Provider authentication/control headers applied by OpenSession's Caddy
   *  portal. Kept server-side so private-provider credentials never enter the
   *  browser URL, workspace, or reusable snapshot. */
  requestHeaders?: Record<string, string>;
}

/** Preview port mapping: port inside the sandbox → where to reach it. A bare
 *  number is shorthand for `{hostPort}` (the docker provider's shape).
 *  Local sandboxes run on the host network, so theirs is always empty. */
export type PortMap = Record<number, number | PortEntry>;

export type SandboxStatus = "running" | "stopped" | "gone";

/**
 * Callbacks a caller attaches to a launched run — the non-serializable
 * counterpart of RunHostSpec, matching host-client's HandleCallbacks /
 * HostedRunOpts split (asks are proxied back to whoever can answer them).
 */
export interface RunHandleCallbacks {
  onAskUser?: RunAgentOpts["onAskUser"];
  /**
   * Builds the in-process SDK MCP servers (opensession-sessions/-admin/…) for
   * runs executing inside this process. Hosted/containerized runs ignore it —
   * they reach the same tools via the stdio→RPC proxy path
   * (RunHostSpec.proxyMcpServers + rpcToken).
   */
  inProcessMcp?: () => Record<string, unknown> | undefined;
  /**
   * A steer reached the run too late (already finishing) or the backend can't
   * steer — the caller should queue the text for delivery after the run
   * instead of dropping it. Mirrors host-client's HandleCallbacks. Only fires
   * for out-of-process runs; in-process steers report failure synchronously.
   */
  onSteerFailed?: (text: string) => void;
}

/**
 * A long-lived agent run inside a sandbox. `events()` is the same
 * AsyncGenerator<StreamEvent> shape every runner entry point yields — consume
 * it exactly once. The control methods mirror HostRunControl and return false
 * when the run can't honor the request (caller queues instead).
 */
export interface RunHandle {
  events(): AsyncGenerator<StreamEvent>;
  /** Whether the run's backend supports mid-run steering (claude yes, exec-codex no). */
  steerable: boolean;
  steer(text: string, images?: ImageInput[]): boolean;
  interruptSteer(text: string, images?: ImageInput[]): boolean;
  cancel(): boolean;
}

/**
 * One session's execution environment. `id` is journaled on ActiveRunRecord
 * (`sandboxId`) and the session file so a restarted opensession can reattach via
 * `SandboxProvider.get()`.
 */
export interface Sandbox {
  id: string;
  provider: SandboxProviderId;
  /** Workspace path *inside* the sandbox (== host path for local + bind-mount Docker). */
  cwd: string;
  /** How the workspace is materialized (docker only): "bind" = host worktree
   *  bind-mounted at the identical path; "volume" = cloned into a per-session
   *  volume, no host copy. Undefined for local (the host dir IS the workspace). */
  workspace?: "bind" | "volume";
  /** How the current container came to exist (docker only): "fresh" = created
   *  from the base image, "snapshot-restore" = recreated from a per-session
   *  snapshot image. Lifecycle scripts get it as OPENSESSION_BOOT_MODE (the
   *  background-agents boot-mode pattern). */
  bootMode?: "fresh" | "snapshot-restore";
  /** One-shot commands in the workspace (git status, ls-files, …). Never throws
   *  on non-zero exit — inspect `exitCode`. */
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>;
  /** Start a long-lived agent run (NDJSON-stream semantics; see RunHandle). */
  launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle;
  /**
   * Like `launchRun`, but the sandbox-side setup (container exec, socket
   * connect) is awaited HERE and a failure THROWS instead of surfacing as an
   * error event on the stream — so a caller with a fallback path (e.g. run on
   * the host instead) can catch it before committing to the sandbox. Optional:
   * only backends whose launch can fail out-of-process implement it; the local
   * provider's in-process launch has nothing to await.
   */
  launchRunEager?(
    spec: RunHostSpec,
    cb?: RunHandleCallbacks,
  ): Promise<RunHandle>;
  /** Preview ports (sandbox port → host port). `requestedPorts` lets providers
   *  with dynamic tunnels publish services a session added to .ports.conf. */
  ports(requestedPorts?: number[]): Promise<PortMap>;
  status(): Promise<SandboxStatus>;
}

export interface SandboxProvider {
  id: SandboxProviderId;
  /** Create-or-reuse the sandbox for a session. Idempotent. */
  ensure(spec: SandboxSessionSpec): Promise<Sandbox>;
  /** Reattach to a known sandbox after a restart; null when it's gone. */
  get(sandboxId: string): Promise<Sandbox | null>;
  /** Release compute while retaining the durable workspace. Optional only for
   *  providers whose own idle policy cannot expose this directly. */
  pause?(sandboxId: string): Promise<void>;
  /** Wake a paused sandbox and return its live handle. */
  resume?(sandboxId: string): Promise<Sandbox | null>;
  /** Persist a session-owned filesystem checkpoint after a clean turn.
   * Providers whose stopped sandboxes retain disk do not need this hook. */
  checkpoint?(sandboxId: string): Promise<void>;
  /** Tear the sandbox down (session delete/archive). Workspace data outlives
   *  it where the provider stores it on the host (local worktrees always do).
   *  Strict cleanup rejects unless disposal is confirmed. */
  destroy(sandboxId: string, options?: { strict?: boolean }): Promise<void>;
}
