/**
 * Route a remote Sandbox's commands through its Sandbox agent when one is
 * connected (agent-channel.ts, src/runner-host/sandbox-agent.ts), and through
 * the provider's own lane (SSH, the provider's command API) otherwise.
 *
 * This is the generic part of a provider: an adapter keeps lifecycle (create,
 * start, stop, snapshot, destroy) and hands its RemoteDriver to
 * `withSandboxAgent`; commands, background processes and file writes need
 * nothing from the provider once the agent is up. The provider lane stays as
 * the bootstrap path (the agent needs the base runtime's bun) and as the
 * fallback whenever the agent is not connected, so a missing agent can only
 * make a Sandbox as slow as it was before, never unusable.
 */
import { readFile } from "node:fs/promises";
import { REPO_ROOT } from "../../runner-host/protocol";
import { remoteSandboxCallbackBaseUrl, sandboxAgentEnabled } from "./config";
import {
  SANDBOX_AGENT_PATH,
  mintSandboxAgentToken,
  sandboxAgentConnected,
  sandboxAgentRequest,
  waitForSandboxAgent,
} from "./agent-channel";
import {
  remoteLayoutForProvider,
  shellQuoteWord,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./adapters/bootstrap";
import type { SandboxProviderId } from "./provider";

export const SANDBOX_AGENT_ENTRY = `${REPO_ROOT}/packages/core/opensession-server/src/runner-host/sandbox-agent.ts`;
/** Per-boot runtime files: the token (deleted once read) and the pid. Under
 *  /tmp so neither survives a stop or lands in a snapshot. */
export const SANDBOX_AGENT_RUN_DIR = "/tmp/opensession-agent";

let agentSource: Promise<string> | undefined;
function readAgentSource(): Promise<string> {
  agentSource ??= readFile(SANDBOX_AGENT_ENTRY, "utf8").catch((error) => {
    agentSource = undefined;
    throw error;
  });
  return agentSource;
}

/** Fold cwd and env into a shell string the way a provider lane would. */
export function composeAgentShell(cmd: string, opts?: RemoteExecOpts): string {
  let shell = cmd;
  const env = opts?.env && Object.keys(opts.env).length ? opts.env : undefined;
  if (env) {
    const pairs = Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuoteWord(value)}`)
      .join(" ");
    shell = `env ${pairs} sh -c ${shellQuoteWord(shell)}`;
  }
  if (opts?.cwd) shell = `cd ${shellQuoteWord(opts.cwd)} && { ${shell}\n}`;
  return shell;
}

/** Before a launch: the runtime directories exist, bun is there, and any
 *  previous agent is stopped. Fails (exit 3) while bun is not installed. */
export function sandboxAgentPrepareScript(input: {
  bun: string;
  home: string;
}): string {
  const run = SANDBOX_AGENT_RUN_DIR;
  return [
    `test -x ${shellQuoteWord(input.bun)} || { echo 'bun is not installed yet' >&2; exit 3; }`,
    `mkdir -p ${shellQuoteWord(`${input.home}/.opensession/agent`)}`,
    `mkdir -p -m 700 ${run} && chmod 700 ${run}`,
    // A pid from before a reboot may now belong to anything: kill it only
    // while it is still an agent.
    `if [ -f ${run}/pid ]; then p="$(cat ${run}/pid)"; if ps -p "$p" -o args= 2>/dev/null | grep -q sandbox-agent; then kill "$p" 2>/dev/null || true; fi; rm -f ${run}/pid; fi`,
  ].join(" && ");
}

/** The detached command that becomes the agent (exec keeps the pid the
 *  pidfile records). */
export function sandboxAgentLaunchScript(input: {
  bun: string;
  home: string;
  path: string;
  entry: string;
  endpoint: string;
}): string {
  const run = SANDBOX_AGENT_RUN_DIR;
  const log = `${input.home}/.opensession/agent/agent.log`;
  return (
    `cd ${shellQuoteWord(input.home)} && echo $$ > ${run}/pid && ` +
    `exec env HOME=${shellQuoteWord(input.home)} PATH=${shellQuoteWord(input.path)} ` +
    `OPENSESSION_SANDBOX_AGENT_URL=${shellQuoteWord(input.endpoint)} ` +
    `OPENSESSION_SANDBOX_AGENT_TOKEN_FILE=${run}/token ` +
    `${shellQuoteWord(input.bun)} run ${shellQuoteWord(input.entry)} ` +
    `</dev/null >${shellQuoteWord(log)} 2>&1`
  );
}

type LaunchState = { launching?: Promise<boolean>; failedAt?: number };
const launches: Map<string, LaunchState> = ((
  globalThis as { __opensessionSandboxAgentLaunches?: Map<string, LaunchState> }
).__opensessionSandboxAgentLaunches ??= new Map());
/** After a failed launch, wait this long before trying again; meanwhile the
 *  provider lane carries everything. */
const RELAUNCH_BACKOFF_MS = 60_000;

/**
 * Start the Sandbox's agent through the provider lane and wait briefly for it
 * to say hello. One launch at a time per Sandbox; a failure is remembered for
 * a minute so a burst of commands does not relaunch on every call.
 */
export function launchSandboxAgent(
  inner: RemoteDriver,
  input: { providerId: SandboxProviderId; sandboxId: string },
  waitMs = 10_000,
): Promise<boolean> {
  const state = launches.get(input.sandboxId) ?? {};
  launches.set(input.sandboxId, state);
  if (state.launching) return state.launching;
  if (sandboxAgentConnected(input.sandboxId)) return Promise.resolve(true);
  let runtimeMissing = false;
  const launching = (async () => {
    const layout = remoteLayoutForProvider(input.providerId);
    const home = inner.home || layout.home;
    const entry = `${home}/.opensession/agent/sandbox-agent.ts`;
    const endpoint =
      `${remoteSandboxCallbackBaseUrl().replace(/\/$/, "")}${SANDBOX_AGENT_PATH}` +
      `?sandbox=${encodeURIComponent(input.sandboxId)}`;
    const bun = `${home}/.bun/bin/bun`;
    const prepared = await inner.exec(
      sandboxAgentPrepareScript({ bun, home }),
      {
        timeoutMs: 30_000,
      },
    );
    if (prepared.exitCode === 3) {
      // A machine still being bootstrapped: not a failure worth backing off
      // for, the launch after the base runtime install will work.
      runtimeMissing = true;
      return false;
    }
    if (prepared.exitCode !== 0)
      throw new Error(prepared.stderr.trim() || "could not prepare the agent");
    await inner.writeFile(entry, await readAgentSource());
    const token = mintSandboxAgentToken({
      sandboxId: input.sandboxId,
      provider: input.providerId,
    });
    await inner.writeFile(`${SANDBOX_AGENT_RUN_DIR}/token`, token);
    await inner.execBackground(
      sandboxAgentLaunchScript({
        bun,
        home,
        path: layout.path,
        entry,
        endpoint,
      }),
      { timeoutMs: 30_000 },
    );
    return waitForSandboxAgent(input.sandboxId, waitMs);
  })()
    .catch((error) => {
      console.warn(
        `[sandbox-agent] ${input.sandboxId}: launch failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    })
    .then((connected) => {
      state.failedAt = connected || runtimeMissing ? undefined : Date.now();
      return connected;
    })
    .finally(() => {
      state.launching = undefined;
    });
  state.launching = launching;
  return launching;
}

/** Forget launch bookkeeping for a retired Sandbox. */
export function forgetSandboxAgentLaunch(sandboxId: string): void {
  launches.delete(sandboxId);
}

export interface SandboxAgentDriverOptions {
  providerId: SandboxProviderId;
  sandboxId: string;
  /** The provider's own cwd/env folding plus any prefix its commands need
   *  (Boat re-links /home/ubuntu on every command). Default: plain folding. */
  compose?: (cmd: string, opts?: RemoteExecOpts) => string;
  /** Wait for the agent on ensureStarted instead of launching it in the
   *  background. Used where the next calls are a burst worth speeding up. */
  awaitAgentMs?: number;
}

/**
 * Wrap a provider's RemoteDriver so its commands use the Sandbox agent while
 * it is connected. `ensureStarted` starts the machine through the provider,
 * then makes sure an agent is running (in the background unless asked to
 * wait). A provider not enabled for the agent gets its driver back as is.
 */
export function withSandboxAgent(
  inner: RemoteDriver,
  options: SandboxAgentDriverOptions,
): RemoteDriver {
  if (!sandboxAgentEnabled(options.providerId)) return inner;
  const { sandboxId } = options;
  const compose = options.compose ?? composeAgentShell;
  // The env travels in the frame and reaches spawn directly: folded into the
  // script (as the provider lanes must) it would sit in argv, readable by
  // anything that lists the Sandbox's processes.
  const agentFrame = (cmd: string, opts?: RemoteExecOpts) => {
    const env =
      opts?.env && Object.keys(opts.env).length ? opts.env : undefined;
    return {
      script: compose(cmd, opts && { ...opts, env: undefined }),
      ...(env ? { env } : {}),
    };
  };
  const kick = async (waitMs: number) => {
    if (sandboxAgentConnected(sandboxId)) return;
    const state = launches.get(sandboxId);
    if (
      !state?.launching &&
      state?.failedAt &&
      Date.now() - state.failedAt < RELAUNCH_BACKOFF_MS
    )
      return;
    const launched = launchSandboxAgent(
      inner,
      options,
      Math.max(waitMs, 10_000),
    );
    if (waitMs > 0) await Promise.race([launched, Bun.sleep(waitMs)]);
  };
  return {
    os: inner.os,
    home: inner.home,
    async exec(cmd, opts) {
      const timeoutMs = opts?.timeoutMs ?? 120_000;
      const viaAgent = sandboxAgentRequest(
        sandboxId,
        { t: "exec", ...agentFrame(cmd, opts), timeoutMs },
        timeoutMs + 15_000,
      );
      return viaAgent ? viaAgent : inner.exec(cmd, opts);
    },
    async execBackground(cmd, opts) {
      const viaAgent = sandboxAgentRequest(
        sandboxId,
        { t: "spawn", ...agentFrame(cmd, opts) },
        30_000,
      );
      if (!viaAgent) return inner.execBackground(cmd, opts);
      const result = await viaAgent;
      if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || "background launch failed");
    },
    async writeFile(path, content) {
      const viaAgent = sandboxAgentRequest(
        sandboxId,
        {
          t: "write",
          path,
          b64: Buffer.from(content, "utf8").toString("base64"),
        },
        60_000,
      );
      if (!viaAgent) return inner.writeFile(path, content);
      const result = await viaAgent;
      if (result.exitCode !== 0)
        throw new Error(
          `writeFile(${path}) failed: ${result.stderr.trim().slice(0, 300)}`,
        );
    },
    async ensureStarted() {
      await inner.ensureStarted();
      await kick(options.awaitAgentMs ?? 0);
    },
  };
}
