/**
 * Interactive shell terminals for the session viewer's Shell tab.
 *
 * Multiple shells per WebSocket client, keyed by a client-chosen `termId`
 * (one per shell tab in the UI; legacy clients that never send one all map
 * to "0"). Output streams to the client as base64 `term_data` frames — the
 * WS handler tags each frame with its termId; input/resize come back the
 * same way. A shell dies with its socket (stopAllTerminals), or on its own
 * term_stop (closing the tab), so nothing leaks past a disconnect — and the
 * map lives on globalThis so a hot reload doesn't orphan running shells.
 *
 * Sandbox-aware (startSessionTerminal): the shell lands where the session's
 * work actually happens.
 *  - No sandbox (or any failure mode): a real PTY (Bun's native `terminal`
 *    spawn option) running the login shell in the session's worktree on the
 *    host — exactly the pre-sandbox behavior.
 *  - ACTIVE docker sandbox: same host PTY around `docker exec -it … bash -il`
 *    in the session's container, cwd = the workspace (works for bind AND
 *    volume mode — volume workspaces have no host copy at all). Opening a
 *    terminal is an interactive action, so unlike the read surfaces
 *    (workspace-exec) it WAKES a stopped container (`docker start` first);
 *    the idle-stop sweep still applies, and stopping the container simply
 *    ends the shell (term_exit) — restart-on-demand by reopening the tab.
 *  - Daytona sandbox: the SDK's native PTY (`process.createPty`, a WebSocket
 *    to the sandbox's toolbox API) — a REAL in-sandbox PTY with working
 *    echo, prompt and resize/SIGWINCH. Not ssh: the SSH gateway ignores
 *    pty-req on exec channels, so the previous `ssh <token>@ssh.app.daytona.io
 *    "… exec bash -l"` transport came up with no remote tty — no prompt, no
 *    echo, a dead-looking tab (bit us 2026-07-09). No published port, no
 *    extra HTTPS surface — the SDK socket terminates at opensession and the
 *    browser only ever speaks the existing tailnet-gated session WS.
 *  - Box sandbox: Box's authenticated SSH-key API installs a dedicated
 *    Open Session public key, then the host opens a normal SSH PTY. The
 *    private key remains local and is never exposed to the browser or Box.
 *
 * Trust model: the web UI is Tailscale- + team-gated and interactive users are
 * already admin-equivalent (sessions run arbitrary Bash via prompts), so a
 * shell — host or in-sandbox — adds convenience, not a new privilege tier.
 * MAX_TERMINALS_PER_SOCKET only bounds accidental PTY pile-up, not trust.
 * Nothing here is reachable from automation runs.
 *
 * NOTE: reached only through opensession.ts's WS handlers, which do NOT
 * hot-apply — changes here need a real restart to take effect.
 */

import { homeDir } from "./paths";
import { existsSync } from "fs";
import type { RemotePtyHandle, RemotePtyIo } from "./sandbox/adapters/daytona";

/** Live transport for one shell — how input/resize/teardown reach the PTY,
 *  whether it's a host process or a remote (in-sandbox) socket. */
interface TermEntry {
  write: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  stop: () => void;
}

const g = globalThis as any;
/** ws → termId → live shell. (New globalThis key since the multi-tab change:
 *  the old __opensessionTerminals map was flat ws → entry.) */
const terms: Map<
  unknown,
  Map<string, TermEntry>
> = (g.__opensessionTerminalsById ??= new Map());
/** In-flight async starts (ws → termId → generation token): a stop or
 *  re-start that lands while a sandbox target is still resolving cancels the
 *  stale one. */
const pendingStarts: Map<
  unknown,
  Map<string, object>
> = (g.__opensessionTermPendingById ??= new Map());

/** Bound accidental PTY pile-up per client (each shell tab is one PTY). */
const MAX_TERMINALS_PER_SOCKET = 8;

const HOME = homeDir();

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\"'\"'`)}'`;
}

function setTerm(ws: unknown, termId: string, entry: TermEntry): void {
  let m = terms.get(ws);
  if (!m) terms.set(ws, (m = new Map()));
  m.set(termId, entry);
}

function deleteTerm(ws: unknown, termId: string): void {
  const m = terms.get(ws);
  if (!m) return;
  m.delete(termId);
  if (m.size === 0) terms.delete(ws);
}

function deletePending(ws: unknown, termId: string): void {
  const m = pendingStarts.get(ws);
  if (!m) return;
  m.delete(termId);
  if (m.size === 0) pendingStarts.delete(ws);
}

/** The slice of UnifiedSession / the session file the terminal target needs. */
export interface TerminalSessionInfo {
  id?: string;
  repo?: string | null;
  createdBy?: string | null;
  worktreeDir?: string | null;
  sandbox?: { provider?: string; sandboxId?: string; workspace?: string };
  runner?: { id: string; workspacePath: string };
}

export interface TerminalOpts {
  cols?: number;
  rows?: number;
  send: (msg: object) => void;
}

type TermTargetKind =
  | "host"
  | "docker"
  | "daytona"
  | "box"
  | "microvm"
  | "runner";

/** A shell realized as a host process wrapped in a Bun PTY (host, docker, or
 * an SSH transport such as Box). */
interface SpawnTarget {
  kind: "spawn";
  argv: string[];
  /** Host cwd for the spawned process (undefined for sandbox transports —
   *  their cwd lives inside the sandbox). */
  cwd?: string;
  /** Where the shell actually runs, for the UI's term_ready banner. */
  target: TermTargetKind;
  /** The workspace path the shell lands in (host or in-sandbox). */
  displayCwd: string;
  /** Dim one-liner explaining a fallback (e.g. sandbox unreachable). */
  notice?: string;
  /** Extra env for the spawned process (e.g. the shared ssh-agent sock). */
  env?: Record<string, string>;
  dispose?: () => void;
}

/** A shell realized as a remote PTY the provider connects for us (daytona). */
interface RemoteTarget {
  kind: "remote";
  target: TermTargetKind;
  displayCwd: string;
  notice?: string;
  connect: (io: RemotePtyIo) => Promise<RemotePtyHandle>;
}

type TermTarget = SpawnTarget | RemoteTarget;

function clampCols(cols: number | undefined): number {
  return Math.max(20, Math.min(500, Math.round(cols || 100)));
}
function clampRows(rows: number | undefined): number {
  return Math.max(5, Math.min(200, Math.round(rows || 30)));
}

/**
 * ONE shared ssh-agent for every host-shell PTY. ~/.zshrc starts an agent
 * whenever SSH_AUTH_SOCK is empty, and an `eval $(ssh-agent -s)` agent
 * daemonizes past its shell — so every Shell tab leaked one into the service
 * cgroup until shutdown SIGKILLed the pile (journal 2026-07-09 13:51:41).
 * Handing each PTY a live SSH_AUTH_SOCK makes the profile guard skip the
 * spawn entirely: at most one agent per opensession process, reused across
 * shells, and reaped with the cgroup on service stop.
 */
async function sharedSshAgentEnv(): Promise<Record<string, string>> {
  if (process.env.SSH_AUTH_SOCK) return {}; // service already has one — inherit
  const cur: { sock: string; pid: number } | undefined =
    g.__opensessionTermSshAgent;
  if (cur && existsSync(cur.sock)) {
    try {
      process.kill(cur.pid, 0);
      return { SSH_AUTH_SOCK: cur.sock, SSH_AGENT_PID: String(cur.pid) };
    } catch {}
  }
  const proc = Bun.spawn(["ssh-agent", "-s"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const sock = out.match(/SSH_AUTH_SOCK=([^;\s]+)/)?.[1];
  const pid = Number(out.match(/SSH_AGENT_PID=(\d+)/)?.[1]);
  if (!sock || !pid) return {}; // no agent — the profile spawns its own (old behavior)
  g.__opensessionTermSshAgent = { sock, pid };
  return { SSH_AUTH_SOCK: sock, SSH_AGENT_PID: String(pid) };
}

function hostShellTarget(
  session: TerminalSessionInfo | null | undefined,
  notice?: string,
): SpawnTarget {
  const shell = process.env.SHELL || "/bin/zsh";
  const cwd =
    session?.worktreeDir && existsSync(session.worktreeDir)
      ? session.worktreeDir
      : HOME;
  return {
    kind: "spawn",
    argv: [shell, "-il"],
    cwd,
    target: "host",
    displayCwd: cwd,
    notice,
  };
}

/**
 * Decide where the session's shell runs. Never throws — every failure mode
 * degrades to the host shell with a notice (same fail-open shape as
 * workspace-exec, except a terminal deliberately WAKES a stopped docker
 * container: it's an interactive gesture, not a background read).
 */
async function resolveTarget(
  session: TerminalSessionInfo | null | undefined,
): Promise<TermTarget> {
  if (session?.runner && session.id && session.repo) {
    const runner = session.runner;
    const {
      openRunnerTerminal,
      registerRunnerTerminalHandler,
      resizeRunnerTerminal,
      stopRunnerTerminal,
      writeRunnerTerminal,
    } = await import("./runner-ws");
    return {
      kind: "remote",
      target: "runner",
      displayCwd: runner.workspacePath,
      connect: async (io) => {
        const opened = await openRunnerTerminal({
          runnerId: runner.id,
          sessionId: session.id!,
          repo: session.repo!,
          workspacePath: runner.workspacePath,
          user: session.createdBy || undefined,
          cols: io.cols,
          rows: io.rows,
        });
        const detach = registerRunnerTerminalHandler((runnerId, message) => {
          if (runnerId !== runner.id || message.id !== opened.terminalId)
            return;
          if (message.t === "terminal_data" && typeof message.data === "string")
            io.onData(Buffer.from(message.data, "base64"));
          else if (message.t === "terminal_exit")
            io.onExit(typeof message.code === "number" ? message.code : 0);
        });
        return {
          write: (data) =>
            writeRunnerTerminal(
              runner.id,
              opened.terminalId,
              Buffer.from(data).toString("base64"),
            ),
          resize: (cols, rows) =>
            resizeRunnerTerminal(runner.id, opened.terminalId, cols, rows),
          close: async () => {
            detach();
            stopRunnerTerminal(runner.id, opened.terminalId);
          },
        };
      },
    };
  }
  const sb = session?.sandbox;
  if (!sb?.sandboxId || !sb.provider || sb.provider === "local") {
    return hostShellTarget(session);
  }
  const cwd = session?.worktreeDir || HOME;
  try {
    const { sandboxesEnabled, sandboxProviderConfigured } =
      await import("./sandbox/config");
    if (!sandboxesEnabled()) return hostShellTarget(session); // kill-switch

    if (sb.provider === "docker" && sandboxProviderConfigured("docker")) {
      // Wake on demand — `docker start` is a no-op on a running container.
      const start = Bun.spawn(["docker", "start", sb.sandboxId], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([
        start.exited,
        new Response(start.stderr).text(),
      ]);
      if (code !== 0) {
        return hostShellTarget(
          session,
          `sandbox container unavailable (${err.trim().slice(0, 120)}) — opened a host shell instead`,
        );
      }
      const { touchSandboxActivity } = await import("./sandbox/docker");
      touchSandboxActivity(sb.sandboxId);
      return {
        kind: "spawn",
        argv: [
          "docker",
          "exec",
          "-it",
          "-e",
          "TERM=xterm-256color",
          "-w",
          cwd,
          sb.sandboxId,
          "bash",
          "-il",
        ],
        target: "docker",
        displayCwd: cwd,
      };
    }

    if (sb.provider === "daytona" && sandboxProviderConfigured("daytona")) {
      const { daytonaPtySession } = await import("./sandbox/adapters/daytona");
      const sandboxId = sb.sandboxId;
      return {
        kind: "remote",
        target: "daytona",
        displayCwd: cwd,
        connect: (io) => daytonaPtySession(sandboxId, cwd, io),
      };
    }

    if (sb.provider === "box" && sandboxProviderConfigured("box")) {
      const { boxSshTarget } = await import("./sandbox/adapters/box");
      const target = await boxSshTarget(sb.sandboxId);
      return {
        kind: "spawn",
        target: "box",
        displayCwd: cwd,
        argv: [
          "ssh",
          "-tt",
          "-p",
          String(target.port),
          "-i",
          target.privateKeyPath,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ConnectTimeout=20",
          `${target.user}@${target.host}`,
          `cd ${shellQuote(cwd)} && exec bash -il`,
        ],
      };
    }
  } catch (e: any) {
    return hostShellTarget(
      session,
      `sandbox terminal unavailable (${String(e?.message || e).slice(0, 160)}) — opened a host shell instead`,
    );
  }
  return hostShellTarget(session);
}

/**
 * Session-aware terminal start (the term_start WS handler's entry): resolves
 * the target (host / Docker / Daytona / Box) and connects the shell
 * for one (socket, termId) pair. Async because sandbox resolution can take
 * seconds (container wake, remote PTY connect) — a term_stop or another
 * term_start for the same termId racing in cancels it.
 */
export async function startSessionTerminal(
  ws: unknown,
  termId: string,
  session: TerminalSessionInfo | null | undefined,
  opts: TerminalOpts,
): Promise<void> {
  stopTerminal(ws, termId); // one shell per (socket, termId)
  const open = (terms.get(ws)?.size ?? 0) + (pendingStarts.get(ws)?.size ?? 0);
  if (open >= MAX_TERMINALS_PER_SOCKET) {
    opts.send({
      type: "term_notice",
      message: `too many open shells (${MAX_TERMINALS_PER_SOCKET}) — close one first`,
    });
    opts.send({ type: "term_exit", code: 1 });
    return;
  }
  const token = {};
  {
    let pend = pendingStarts.get(ws);
    if (!pend) pendingStarts.set(ws, (pend = new Map()));
    pend.set(termId, token);
  }
  // A silent hang here (e.g. a sandbox wake that never returns) used to leave
  // the tab dead with zero feedback — say what we're waiting on. NOTE: in a
  // timer-poisoned process (see run-ws.ts's tripwire)
  // this notice can't fire either; the tripwire is the real alarm there.
  const slow = setTimeout(() => {
    try {
      opts.send({
        type: "term_notice",
        message:
          "still connecting to the sandbox shell… (sandbox may be waking up)",
      });
    } catch {}
  }, 8_000);
  (slow as { unref?: () => void }).unref?.();
  let target: TermTarget;
  try {
    target = await resolveTarget(session);

    if (target.kind === "remote") {
      try {
        await connectRemote(ws, termId, token, target, opts);
        return;
      } catch (e: any) {
        if (target.target === "runner") {
          deletePending(ws, termId);
          opts.send({
            type: "term_notice",
            message: `Runner terminal unavailable (${String(e?.message || e).slice(0, 160)})`,
          });
          opts.send({ type: "term_exit", code: 1 });
          return;
        }
        // Same fail-open shape as resolveTarget: any connect failure
        // degrades to a host shell with a notice.
        target = hostShellTarget(
          session,
          `sandbox terminal unavailable (${String(e?.message || e).slice(0, 160)}) — opened a host shell instead`,
        );
      }
    }
  } finally {
    clearTimeout(slow);
  }
  if (target.target === "host") {
    // Keep the profile's ssh-agent guard satisfied so each PTY doesn't leak
    // a daemonized agent (best effort — a failure just restores old behavior).
    try {
      target.env = { ...target.env, ...(await sharedSshAgentEnv()) };
    } catch {}
  }
  if (pendingStarts.get(ws)?.get(termId) !== token) {
    // Stopped or superseded while resolving — release the transport.
    try {
      target.dispose?.();
    } catch {}
    return;
  }
  deletePending(ws, termId);
  spawnPty(ws, termId, target, opts);
}

/** Connect a provider-managed remote PTY (daytona) and register it. */
async function connectRemote(
  ws: unknown,
  termId: string,
  token: object,
  target: RemoteTarget,
  opts: TerminalOpts,
): Promise<void> {
  let handle: RemotePtyHandle | null = null;
  const entry: TermEntry = {
    write: (data) => void handle?.write(data),
    resize: (cols, rows) => void handle?.resize(cols, rows),
    stop: () => void handle?.close(),
  };
  handle = await target.connect({
    cols: clampCols(opts.cols),
    rows: clampRows(opts.rows),
    onData: (chunk) => {
      opts.send({
        type: "term_data",
        data: Buffer.from(chunk).toString("base64"),
      });
    },
    onExit: (code) => {
      if (terms.get(ws)?.get(termId) === entry) {
        deleteTerm(ws, termId);
        try {
          entry.stop();
        } catch {}
        opts.send({ type: "term_exit", code: code ?? 0 });
      }
    },
  });
  if (pendingStarts.get(ws)?.get(termId) !== token) {
    // Stopped or superseded while connecting — release the remote PTY.
    try {
      await handle.close();
    } catch {}
    return;
  }
  deletePending(ws, termId);
  setTerm(ws, termId, entry);
  opts.send({
    type: "term_ready",
    target: target.target,
    cwd: target.displayCwd,
  });
  if (target.notice) opts.send({ type: "term_notice", message: target.notice });
}

function spawnPty(
  ws: unknown,
  termId: string,
  target: SpawnTarget,
  opts: TerminalOpts,
): void {
  const proc = Bun.spawn(target.argv, {
    cwd: target.cwd,
    env: { ...process.env, TERM: "xterm-256color", ...target.env },
    terminal: {
      cols: clampCols(opts.cols),
      rows: clampRows(opts.rows),
      data: (_term: unknown, chunk: Uint8Array) => {
        opts.send({
          type: "term_data",
          data: Buffer.from(chunk).toString("base64"),
        });
      },
    },
  } as any);

  const entry: TermEntry = {
    write: (data) => {
      try {
        (proc as any).terminal?.write(data);
      } catch {}
    },
    resize: (cols, rows) => {
      try {
        (proc as any).terminal?.resize(cols, rows);
      } catch {}
    },
    stop: () => {
      try {
        proc.kill();
      } catch {}
      try {
        target.dispose?.();
      } catch {}
    },
  };

  void proc.exited.then((code) => {
    if (terms.get(ws)?.get(termId) === entry) {
      deleteTerm(ws, termId);
      try {
        target.dispose?.();
      } catch {}
      opts.send({ type: "term_exit", code });
    }
  });

  setTerm(ws, termId, entry);
  opts.send({
    type: "term_ready",
    target: target.target,
    cwd: target.displayCwd,
  });
  if (target.notice) opts.send({ type: "term_notice", message: target.notice });
}

export function writeTerminal(
  ws: unknown,
  termId: string,
  dataB64: string,
): void {
  const t = terms.get(ws)?.get(termId);
  if (!t) return;
  try {
    t.write(Buffer.from(dataB64, "base64"));
  } catch {}
}

export function resizeTerminal(
  ws: unknown,
  termId: string,
  cols: number,
  rows: number,
): void {
  const t = terms.get(ws)?.get(termId);
  if (!t || !cols || !rows) return;
  try {
    t.resize(clampCols(cols), clampRows(rows));
  } catch {}
}

export function stopTerminal(ws: unknown, termId: string): void {
  deletePending(ws, termId); // cancel an in-flight async start
  const t = terms.get(ws)?.get(termId);
  if (!t) return;
  deleteTerm(ws, termId);
  try {
    t.stop();
  } catch {}
}

/** Socket teardown: every shell (and in-flight start) dies with its client. */
export function stopAllTerminals(ws: unknown): void {
  pendingStarts.delete(ws);
  const m = terms.get(ws);
  if (!m) return;
  terms.delete(ws);
  for (const t of m.values()) {
    try {
      t.stop();
    } catch {}
  }
}
