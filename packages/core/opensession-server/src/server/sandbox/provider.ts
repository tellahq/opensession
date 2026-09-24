/**
 * Sandbox seam (docs/self-hosting-sandboxes.md): the interfaces every
 * workspace backend implements. A "sandbox" is where a session's workspace
 * lives: a git worktree on this host (LocalProvider, local.ts) or a remote
 * machine (Daytona, Boat, a Mac VM, use.computer).
 *
 * The agent loop never runs in a Sandbox. It runs on this server, and its
 * file and shell tools reach a remote workspace through `exec`
 * (remote-workspace.ts, sandbox/workspace-rpc.ts). Portals, checkpoints,
 * lifecycle hooks and the Desktop tab use the same handle.
 */

/** The provider ids the registry knows (all implemented — see index.ts).
 *  Persisted sessions may still carry a retired id (docker, modal, e2b,
 *  microvm, lambda-microvm); those fail explicitly at dispatch. `tart` is a
 *  macOS VM on a paired Mac Runner (adapters/tart.ts). */
export type SandboxProviderId =
  | "local"
  | "daytona"
  | "box"
  | "tart"
  | "usecomputer";

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
   * Attached-repo worktree dirs (multi-repo sessions). Remote workspaces
   * reject attachments; the field remains for the local provider.
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
  /** A workspace checkpoint on origin (sandbox/checkpoint.ts) to restore when
   * this ensure() materializes a FRESH workspace: the branch lands on the
   * checkpoint's head with its uncommitted changes in place. A workspace
   * that already exists on the sandbox disk keeps that disk instead. */
  restoreCheckpoint?: { ref: string; commit: string; branch: string };
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
  /**
   * The caller is issuing a burst of commands against a Sandbox it already
   * woke (a run's tool calls): skip the provider's wake check and keepalive
   * unless a minute has passed since the last one.
   */
  assumeStarted?: boolean;
  /** Give the command a workload identity lease (default true). A run's
   *  file operations skip it; its shell commands keep it. */
  workloadIdentity?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One published sandbox port. Remote providers hand out a preview URL on
 *  their own domain; a host-published loopback port is the local shape. */
export interface PortEntry {
  /** Host loopback port the sandbox port is published on. */
  hostPort?: number;
  /** Caddy-reachable dial address for private runtimes that do not publish a
   *  loopback port. */
  upstream?: string;
  /** Direct preview URL (remote providers' port-forward domains). */
  url?: string;
  /** Provider authentication/control headers applied by OpenSession's Caddy
   *  portal. Kept server-side so private-provider credentials never enter the
   *  browser URL, workspace, or reusable snapshot. */
  requestHeaders?: Record<string, string>;
}

/** Port mapping: port inside the sandbox → where to reach it. A bare number
 *  is shorthand for `{hostPort}`. Local sandboxes run on the host network, so
 *  theirs is always empty. */
export type PortMap = Record<number, number | PortEntry>;

export type SandboxStatus = "running" | "stopped" | "gone";

/**
 * One session's execution environment. `id` is journaled on ActiveRunRecord
 * (`sandboxId`) and the session file so a restarted opensession can reattach via
 * `SandboxProvider.get()`.
 */
export interface Sandbox {
  id: string;
  provider: SandboxProviderId;
  /** Workspace path *inside* the sandbox (== host path for local). */
  cwd: string;
  /** How the workspace is materialized: "volume" = cloned into the sandbox's
   *  own disk, no host copy (every remote provider). Undefined for local (the
   *  host dir IS the workspace). "bind" only survives on legacy records. */
  workspace?: "bind" | "volume";
  /** How the current sandbox came to exist: "fresh" = created from the base
   *  image, "snapshot-restore" = restored from a project snapshot. Lifecycle
   *  scripts get it as OPENSESSION_BOOT_MODE. */
  bootMode?: "fresh" | "snapshot-restore";
  /** True when this handle started a sleeping sandbox: `.agents/resume` ran
   *  and the session's Portals need restoring (session-sandbox.ts). */
  wokeFromSleep?: boolean;
  /** One-shot commands in the workspace (git status, ls-files, …). Never throws
   *  on non-zero exit — inspect `exitCode`. */
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>;
  /** Preview ports (sandbox port → host port). `requestedPorts` lets providers
   *  with dynamic tunnels publish services a session added to .ports.conf. */
  ports(requestedPorts?: number[]): Promise<PortMap>;
  status(): Promise<SandboxStatus>;
}

export interface SandboxDesktop {
  /** Opens straight into the live desktop; treat it like a password. Absent
   *  when the desktop streams through `vnc` instead. */
  url?: string;
  /** A VNC stream relayed by this server: the browser's viewer connects to
   *  `streamPath` on the app origin and authenticates with `password`. Treat
   *  both like a password. */
  vnc?: { streamPath: string; password: string };
  /** Epoch ms after which the URL stops working, when the provider says. */
  expiresAt?: number;
}

/** A screenshot of the whole desktop. `data` is base64 of `mimeType`. */
export interface SandboxScreenshot {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  /** Desktop size in pixels, the coordinate space every control call uses. */
  width: number;
  height: number;
}

export interface SandboxDesktopWindow {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
}

export type SandboxMouseButton = "left" | "middle" | "right";

/** Drive the Sandbox desktop the way a person at the keyboard would. Every
 *  coordinate is a desktop pixel as reported by `screenshot()`. */
export interface SandboxDesktopControl {
  screenshot(options?: {
    /** 0 < scale <= 1 shrinks the image before it is encoded. */
    scale?: number;
    format?: "png" | "jpeg";
  }): Promise<SandboxScreenshot>;
  display(): Promise<{ width: number; height: number }>;
  windows(): Promise<SandboxDesktopWindow[]>;
  move(x: number, y: number): Promise<void>;
  click(
    x: number,
    y: number,
    options?: { button?: SandboxMouseButton; double?: boolean },
  ): Promise<void>;
  drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    options?: { button?: SandboxMouseButton },
  ): Promise<void>;
  scroll(
    x: number,
    y: number,
    direction: "up" | "down",
    amount?: number,
  ): Promise<void>;
  /** Type literal text into the focused window. */
  type(text: string): Promise<void>;
  /** Press one chord such as `Return`, `ctrl+l`, `alt+F4`. */
  key(chord: string): Promise<void>;
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
  /** A desktop a person can watch and control from the browser. The URL is a
   *  bearer secret minted for one viewer; providers that cannot expose a
   *  desktop leave this undefined. Rejects while the sandbox is asleep. */
  desktop?(sandboxId: string): Promise<SandboxDesktop>;
  /** The same desktop for the agent: screenshots plus mouse and keyboard.
   *  Rejects while the sandbox is asleep. */
  desktopControl?(sandboxId: string): Promise<SandboxDesktopControl>;
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
