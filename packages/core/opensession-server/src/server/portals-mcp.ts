/** Interactive session Portal MCP. Portals expose only processes in this session workspace. */

import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { sandboxPortalLocalUrls } from "./sandbox-portal-relay";
import {
  getPreviewStatus,
  getSandboxPreviewStatus,
  recipeStartOptions,
  sandboxPreviewIdentityContext,
  seedHostEnvFiles,
} from "./preview";
import {
  listPortalServices,
  listSandboxPortalServices,
  pendingSandboxPortalNames,
  sandboxPortalsWarming,
  restartPortalService,
  restartSandboxPortalService,
  normalizePortalPath,
  PORTAL_LOG_MAX_LINES,
  readHostPortalLog,
  readSandboxPortalLog,
  type PortalLogRead,
  type PortalOomKill,
  setPortalPath,
  setSandboxPortalPath,
  startPortalService,
  startSandboxPortalService,
  stopPortalService,
  stopSandboxPortalService,
} from "./portal-supervisor";
import {
  listRunnerPortalServices,
  restartRunnerPortal,
  runnerPortalUrl,
  setRunnerPortalPath,
  startRunnerPortal,
  stopRunnerPortal,
} from "./runner-portals";
import type { UnifiedSession } from "./types";
import type { Sandbox } from "./sandbox/provider";
import type { PortalSandboxReport } from "./portal-sandbox";
import { createWorkloadIdentityEnv } from "./workload-identity";
import { getRepo } from "./worktree";
import {
  simulatorPortalCommand,
  simulatorPortalInput,
} from "./simulator-portal-command";
import {
  sandboxSimulatorPortalCommand,
  sandboxSupportsSimulatorPortal,
} from "./sandbox-simulator-portal";

const verifiedEditorFixtureSchema = z.object({
  leaseId: z.string().regex(/^epfl_[A-Za-z0-9]+$/),
  videoId: z.string().regex(/^vid_[A-Za-z0-9]+$/),
  editorPath: z.string(),
  expiresAt: z.string().datetime(),
  editorAccessVerified: z.literal(true),
});

type VerifiedEditorFixture = z.infer<typeof verifiedEditorFixtureSchema>;

export interface PortalsMcpContext {
  sessionId: string;
  worktreeDir: () => string | undefined;
  verifyEditorFixture: (leaseId: string) => Promise<VerifiedEditorFixture>;
  setDefaultPath: (
    path: string | null,
    options?: {
      exclusiveKey?: string;
      sourceLeaseId?: string;
      leaseMinutes?: number;
    },
  ) => Promise<{ leaseId?: string }>;
  /** An explicit computation action may wake the Sandbox. Passive listing may not. */
  sandbox: (options?: { wake?: boolean }) => Promise<Sandbox | null>;
  hasSandbox: () => boolean;
  /** The agent's shell runs on this machine while its Portals run in a
   *  Portal Sandbox: list_portals then gives each Portal's loopback URL. */
  shellOnHost?: () => boolean;
  /** How the Sandbox that runs the Portals is doing when none is live: the
   * answer says preparing, waking, asleep, or what failed. */
  sandboxState?: () => PortalSandboxReport | null;
  /** How long one tool call waits before answering with where things
   * stand. Defaults to PORTAL_TOOL_WAIT_MS. */
  waitMs?: number;
  /** Runner sessions own their services on the trusted remote machine. */
  runner: () => UnifiedSession | undefined;
}

function result(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Most of a log's bytes one answer carries; the tail wins. */
const PORTAL_LOG_MAX_CHARS = 30_000;

/** One sentence per out-of-memory kill, for list_portals and read_portal_log. */
export function describeOomKills(kills: PortalOomKill[]): string {
  if (!kills.length) return "";
  const listed = kills
    .map((kill) => `${kill.process} (pid ${kill.pid}, ${kill.rssMb} MB)`)
    .join(", ");
  return `Since the Sandbox booted, its kernel killed these processes for running out of memory: ${listed}.`;
}

export function formatPortalLog(
  name: string,
  read: PortalLogRead,
  match?: string,
): string {
  const oom = describeOomKills(read.oomKills);
  if (read.log === null)
    return [`${name} has not written a log yet.`, oom]
      .filter(Boolean)
      .join("\n");
  // Dev servers color their prefixes; the escapes only cost tokens here.
  let log = read.log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  if (log.length > PORTAL_LOG_MAX_CHARS)
    log = `…${log.slice(-PORTAL_LOG_MAX_CHARS)}`;
  const header = match
    ? `${name} log, lines matching "${match}":`
    : `${name} log (latest lines):`;
  return [
    oom,
    header,
    log.trim() ? log : match ? "(no matching lines)" : "(empty)",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * How long a Portal tool waits for readiness before answering. The MCP call
 * itself times out at 120s; a declared dev server may take minutes to boot,
 * and an answer that arrives after the client gave up reads as a failure, so
 * the agent starts the Portal again on top of the one still booting.
 */
export const PORTAL_TOOL_WAIT_MS = 90_000;

/**
 * What a start already answering "still starting" may add after the
 * deadline: the launch settles its own answer with the Portal's port, and
 * the call that wraps it waits this much longer for that before answering
 * without it. Deadline plus grace stays well inside the 120s MCP budget.
 */
const STILL_STARTING_GRACE_MS = 10_000;

/**
 * The budget of one Portal tool call, taken when the handler starts. Waking
 * the Sandbox, probing status, and stopping the previous process all spend
 * it: a restart that bounded only its launch still answered after the MCP
 * timeout once a loaded host made the stop slow.
 */
function portalToolDeadline(ctx: PortalsMcpContext): number {
  return Date.now() + (ctx.waitMs ?? PORTAL_TOOL_WAIT_MS);
}

export function settleBefore<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  return settleWithin(promise, Math.max(0, deadline - Date.now()));
}

export async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The answer for a Portal still booting when the tool must reply: where it is
 * and what to do, instead of a timeout the agent reads as failure. The start
 * keeps running and records awake or failed in the registry.
 */
async function stillStarting(
  ctx: PortalsMcpContext,
  dir: string,
  sandbox: Sandbox | null,
  name: string,
  started: Promise<unknown>,
): Promise<string> {
  void started.catch(() => {});
  const portals = sandbox
    ? await listSandboxPortalServices(sandbox)
    : await listPortalServices(dir);
  const portal = portals.find((candidate) => candidate.name === name);
  return stillStartingText(name, portal ? ` on port ${portal.port}` : "");
}

function stillStartingText(name: string, where = ""): string {
  return (
    `${name} is still starting${where}. Do not start it again: check list_portals ` +
    `in a minute; it reports the URL once something listens, or the error if it died.`
  );
}

/**
 * The answer when the machine is what the call ran out of time on: a Portal
 * Sandbox created on this first start, or a sleeping one waking and
 * relaunching the Portals it ran. The start goes on past this answer and
 * launches the Portal as soon as the machine is up; a repeated start would
 * only join it (portal-sandbox.ts, portal-supervisor.ts), so say so.
 */
function sandboxStillComing(ctx: PortalsMcpContext, name: string): string {
  const state = ctx.sandboxState?.();
  const doing =
    state?.where === "portal" && !state.materialized
      ? "being prepared"
      : "waking";
  return (
    `The Sandbox that runs this session's Portals is still ${doing}; ${name} starts ` +
    `there as soon as it is up. Do not start it again: check list_portals in a minute. ` +
    `It reports the URL once something listens, or what failed.`
  );
}

/**
 * Why no Sandbox is live for the Portals, from the record the Portals panel
 * shows. Reads as a sentence after "Could not start Portal:" or, capitalized,
 * on its own. Never "sleeping or unavailable": that read as a machine to
 * wake by sending a message, when it was one still coming up after a start
 * that answered early, or one whose failure only the panel could see.
 */
export function noSandboxReason(ctx: PortalsMcpContext): string {
  const state = ctx.sandboxState?.();
  if (!state) return "this session's Sandbox is unavailable.";
  const why = state.error ? `: ${state.error.replace(/\.?$/, ".")}` : ".";
  if (state.where === "workspace") {
    switch (state.busy ? "waking" : state.lifecycle) {
      case "preparing":
      case "waking":
        return "this session's Sandbox is still coming up. Check list_portals in a minute.";
      case "sleeping":
        return "this session's Sandbox is asleep. Starting or restarting a Portal wakes it.";
      case "needs_attention":
        return `this session's Sandbox needs attention${why} Starting a Portal tries again.`;
      default:
        return `this session's Sandbox is unavailable${why}`;
    }
  }
  const machine = `the Portal Sandbox (${state.provider}) that runs this session's Portals`;
  const lifecycle = state.busy
    ? state.materialized
      ? "waking"
      : "preparing"
    : state.lifecycle;
  switch (lifecycle) {
    case "none":
      return `${machine} is created by the first start_portal or start_declared_portal; nothing runs there yet.`;
    case "preparing":
      return `${machine} is still being prepared. Do not start the Portal again: check list_portals in a minute.`;
    case "waking":
      return `${machine} is still waking. Do not start the Portal again: check list_portals in a minute.`;
    case "sleeping":
      return `${machine} is asleep. Starting or restarting a Portal wakes it.`;
    case "needs_attention":
      return `${machine} needs attention${why} Starting a Portal tries again.`;
    default:
      return `${machine} is not reachable right now${why} Starting a Portal tries again.`;
  }
}

function sentence(reason: string): string {
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/**
 * A Portal start from the Sandbox up, under one deadline: wake or provision
 * the machine, then launch. The machine alone can take longer than the call
 * may wait (a Portal Sandbox is created on the first start; a wake relaunches
 * the Portals it ran before landing the checkpoint), and an answer that
 * arrived after the MCP timeout read as failure, so the agent started again
 * on top of it, each time asking for another machine. Now the call answers
 * with where things stand while the start it began runs on.
 */
async function startUnderDeadline(
  ctx: PortalsMcpContext,
  dir: string,
  name: string,
  deadline: number,
  input: (
    status: Awaited<ReturnType<typeof portalStatus>>,
  ) => PortalStartInput | null,
): Promise<string> {
  const runner = ctx.runner();
  let sandbox: Sandbox | null | undefined;
  const run = (async () => {
    sandbox = runner?.runner ? null : await ctx.sandbox({ wake: true });
    if (!sandbox && !runner?.runner && ctx.hasSandbox())
      return `Could not start Portal: ${noSandboxReason(ctx)}`;
    const status = await portalStatus(ctx, dir, sandbox);
    const resolved = input(status);
    if (!resolved)
      return `Could not start Portal: declared Portal '${name}' was not found.`;
    return startPortalForContext(ctx, dir, sandbox, resolved, deadline);
  })();
  return answerUnderDeadline(ctx, name, deadline, run, () => sandbox);
}

/**
 * The call's answer: what `run` settled to in time, or where it stands. The
 * work continues either way; a failure after the answer is logged, and the
 * Sandbox record or the Portal registry carries it for list_portals.
 */
async function answerUnderDeadline(
  ctx: PortalsMcpContext,
  name: string,
  deadline: number,
  run: Promise<string>,
  sandboxSoFar: () => Sandbox | null | undefined,
): Promise<string> {
  let outcome = await settleBefore(run, deadline);
  if (!outcome.settled && sandboxSoFar() !== undefined)
    outcome = await settleWithin(run, STILL_STARTING_GRACE_MS);
  if (outcome.settled) return outcome.value;
  run.catch((error) =>
    console.warn(
      `[portals] ${ctx.sessionId}: ${name} failed after the tool answered:`,
      error instanceof Error ? error.message : String(error),
    ),
  );
  return sandboxSoFar() === undefined
    ? sandboxStillComing(ctx, name)
    : stillStartingText(name);
}
function workspace(ctx: PortalsMcpContext): string | Error {
  const dir = ctx.worktreeDir();
  return dir ? dir : new Error("This session has no workspace for a Portal.");
}

async function portalStatus(
  ctx: PortalsMcpContext,
  dir: string,
  sandbox: Sandbox | null,
) {
  return sandbox
    ? getSandboxPreviewStatus(sandbox, dir, ctx.sessionId)
    : getPreviewStatus(dir);
}

function sandboxPortalEnv(
  ctx: PortalsMcpContext,
  sandbox: Sandbox,
): Record<string, string> {
  const session = ctx.runner();
  if (!session?.repo) return {};
  return createWorkloadIdentityEnv(
    sandboxPreviewIdentityContext(
      sandbox,
      getRepo(session.repo).id,
      "interactive",
    ),
  );
}

type PortalStartInput = {
  name: string;
  command: string;
  port?: number;
  key?: string;
  description?: string;
  defaultPath?: string;
  readyTimeoutMs?: number;
  shutdownGraceMs?: number;
};

async function startPortalForContext(
  ctx: PortalsMcpContext,
  dir: string,
  sandbox: Sandbox | null,
  input: PortalStartInput,
  deadline: number,
): Promise<string> {
  const session = ctx.runner();
  if (session?.runner) {
    const portal = await startRunnerPortal({
      session,
      name: input.name,
      command: input.command,
      ...(input.port ? { port: input.port } : {}),
      ...(input.description ? { description: input.description } : {}),
    });
    return `${portal.name} is ready at ${(await runnerPortalUrl(portal)) ?? "its authenticated Portal URL"}.`;
  }
  if (!sandbox) seedHostEnvFiles(dir);
  const starting = sandbox
    ? startSandboxPortalService({
        sessionId: ctx.sessionId,
        sandbox,
        ...input,
        env: sandboxPortalEnv(ctx, sandbox),
      })
    : startPortalService({
        sessionId: ctx.sessionId,
        worktreeDir: dir,
        ...input,
      });
  const outcome = await settleBefore(starting, deadline);
  if (!outcome.settled)
    return stillStarting(ctx, dir, sandbox, input.name, starting);
  const portal = outcome.value;
  const status = await portalStatus(ctx, dir, sandbox);
  const service = status.services.find(
    (candidate) => candidate.key === portal.key,
  );
  return service?.previewUrl
    ? `${portal.name} is ready at ${service.previewUrl}.`
    : `${portal.name} is listening on port ${portal.port}, but its authenticated Portal URL is unavailable. Configure this instance's Caddy HTTPS Portal routing, then check list_portals. Do not share the raw local port.`;
}

function isTellaEditorPath(path: string): boolean {
  const normalized = normalizePortalPath(path);
  if (!normalized) return false;
  const pathname = new URL(normalized, "https://preview.invalid").pathname;
  return /^\/video\/[^/]+\/edit(?:\/|$)/.test(pathname);
}

export function createPortalsMcpServer(ctx: PortalsMcpContext) {
  return createSdkMcpServer({
    name: "opensession-portals",
    version: "1.0.0",
    tools: [
      tool(
        "start_simulator_portal",
        "Start this session's interactive iOS Simulator Portal on the local Mac or in this session's macOS Sandbox (Mac VM or use.computer). Requires full Xcode, an iOS Simulator runtime, idb and idb_companion on PATH, and an already-built simulator .app inside the workspace. Creates a private simulator, streams its screen and forwards taps, swipes and typing. Returns the authenticated viewer URL; the viewer reports boot or dependency errors. Repeated calls reuse the Portal. Use stop_portal/restart_portal with the returned name. Not available in Linux Sandboxes or remote Runner workspaces. Does not build, sign, release, or enable hot reload.",
        simulatorPortalInput,
        async (args) => {
          const deadline = portalToolDeadline(ctx);
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          if (ctx.runner()?.runner)
            return result(
              "Simulator Portals require a local Mac workspace or a macOS Sandbox, not a remote Runner.",
            );
          if (ctx.hasSandbox()) {
            const sandbox = await ctx.sandbox({ wake: true });
            if (!sandbox)
              return result(
                `Could not start simulator Portal: ${noSandboxReason(ctx)}`,
              );
            if (!sandboxSupportsSimulatorPortal(sandbox))
              return result(
                "Simulator Portals need a macOS Sandbox (Mac VM or use.computer) with Xcode, an iOS Simulator runtime, idb and idb_companion.",
              );
            try {
              const input = await sandboxSimulatorPortalCommand({
                ...args,
                sessionId: ctx.sessionId,
                sandbox,
              });
              return result(
                await startPortalForContext(ctx, dir, sandbox, input, deadline),
              );
            } catch (error) {
              return result(
                `Could not start simulator Portal: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (process.platform !== "darwin")
            return result(
              "Simulator Portals require Open Session running on macOS with full Xcode and idb installed.",
            );
          try {
            const input = await simulatorPortalCommand({
              ...args,
              sessionId: ctx.sessionId,
              workspaceDir: dir,
            });
            return result(
              await startPortalForContext(ctx, dir, null, input, deadline),
            );
          } catch (error) {
            return result(
              `Could not start simulator Portal: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      ),
      tool(
        "start_portal",
        "Start a supervised HTTP or WebSocket service in this session workspace. Open Session allocates a port when omitted, sets PORT and PORTAL_URL, waits for it to listen, and returns its authenticated Portal URL. Never use an upstream URL: Portals expose only this session's process.",
        {
          name: z.string(),
          command: z.string(),
          port: z.number().int().optional(),
          description: z.string().optional(),
        },
        async (args: {
          name: string;
          command: string;
          port?: number;
          description?: string;
        }) => {
          const deadline = portalToolDeadline(ctx);
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            return result(
              await startUnderDeadline(
                ctx,
                dir,
                args.name,
                deadline,
                (status) => {
                  const recipe = status.portalRecipes.find(
                    (candidate) => candidate.id === args.name,
                  );
                  return recipe ? recipeStartOptions(recipe) : args;
                },
              ),
            );
          } catch (error) {
            return result(
              `Could not start Portal: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "start_declared_portal",
        "Start a repository-declared Portal by its ID. Use this instead of copying its command: Open Session applies the trusted command, port contract, readiness timeout, and sandbox workload identity from .agents/portals.json.",
        {
          id: z.string(),
        },
        async ({ id }: { id: string }) => {
          const deadline = portalToolDeadline(ctx);
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            return result(
              await startUnderDeadline(ctx, dir, id, deadline, (status) => {
                const recipe = status.portalRecipes.find(
                  (candidate) => candidate.id === id,
                );
                return recipe ? recipeStartOptions(recipe) : null;
              }),
            );
          } catch (error) {
            return result(
              `Could not start Portal: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "list_portals",
        "List this session's registered Portals and their readiness. Use this after starting a service before telling the user it is ready.",
        {},
        async () => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          const runner = ctx.runner();
          if (runner?.runner) {
            const portals = await listRunnerPortalServices(runner);
            if (!portals.length)
              return result(
                "No Portals are registered. Use start_portal for a live app or service.",
              );
            return result(
              (
                await Promise.all(
                  portals.map(
                    async (portal) =>
                      `${portal.name}\nstate: ${portal.state}\nport: ${portal.port}\nurl: ${(await runnerPortalUrl(portal)) ?? "not ready"}${portal.description ? `\ndescription: ${portal.description}` : ""}`,
                  ),
                )
              ).join("\n\n"),
            );
          }
          const sandbox = await ctx.sandbox();
          if (!sandbox && ctx.hasSandbox())
            return result(sentence(noSandboxReason(ctx)));
          const portals = sandbox
            ? await listSandboxPortalServices(sandbox)
            : await listPortalServices(dir);
          const preparing = sandbox
            ? pendingSandboxPortalNames(sandbox.id).filter(
                (name) => !portals.some((portal) => portal.name === name),
              )
            : [];
          const preparingText = preparing
            .map(
              (name) =>
                `${name}\nstate: starting\nurl: not ready\nnote: the Sandbox is still getting ready to run it. Do not start it again.`,
            )
            .join("\n\n");
          if (!portals.length)
            return result(
              preparingText ||
                "No Portals are registered. Use start_portal for a live app or service.",
            );
          const failed = portals.filter((portal) => portal.state === "failed");
          // Reading the status reconnects a Sandbox Portal's relay, which
          // can move its loopback address; read the address after it.
          const statusRead = portalStatus(ctx, dir, sandbox);
          const [status, warming, local, oom] = await Promise.all([
            statusRead,
            sandbox
              ? sandboxPortalsWarming(
                  sandbox,
                  ctx.sessionId,
                  portals
                    .filter((portal) => portal.state === "awake")
                    .map((portal) => portal.name),
                )
              : new Set<string>(),
            sandbox && ctx.shellOnHost?.()
              ? statusRead.then(
                  () => sandboxPortalLocalUrls(ctx.sessionId),
                  () => sandboxPortalLocalUrls(ctx.sessionId),
                )
              : new Map<string, string>(),
            // A dev server that stopped listening in a Sandbox is most often
            // an out-of-memory kill; say so instead of a bare "failed".
            sandbox && failed[0]
              ? readSandboxPortalLog({
                  sessionId: ctx.sessionId,
                  sandbox,
                  name: failed[0].name,
                  lines: 1,
                })
                  .then((read) => describeOomKills(read.oomKills))
                  .catch(() => "")
              : Promise.resolve(""),
          ]);
          return result(
            portals
              .map((portal) => {
                const service = status.services.find(
                  (candidate) => candidate.key === portal.key,
                );
                return `${portal.name}\nstate: ${portal.state}\nport: ${portal.port}\nurl: ${service?.previewUrl ?? "not ready"}${portal.state === "awake" && local.has(portal.name) ? `\nlocal: ${local.get(portal.name)} (from this shell, no sign-in: use it for curl, scripts, and screenshots)` : ""}${portal.description ? `\ndescription: ${portal.description}` : ""}${warming.has(portal.name) ? "\nwarming: its first pages are still compiling, so opening one now can take a minute. Say so rather than calling it ready." : ""}${portal.state === "failed" && portal.lastError ? `\nerror: ${portal.lastError}` : ""}${portal.state === "failed" ? `${oom ? `\n${oom}` : ""}\nlog: read_portal_log shows its output.` : ""}`;
              })
              .concat(preparingText ? [preparingText] : [])
              .join("\n\n"),
          );
        },
      ),
      tool(
        "read_portal_log",
        `Read the latest output (stdout and stderr) of one of this session's Portals, including one running in a Sandbox your shell cannot reach. Use it when a Portal fails, stops listening, or answers 502/503. In a Sandbox it also reports processes the kernel killed for running out of memory. lines defaults to 120 (max ${PORTAL_LOG_MAX_LINES}); match keeps only lines containing that text, case-insensitive.`,
        {
          name: z.string(),
          lines: z.number().int().min(1).max(PORTAL_LOG_MAX_LINES).optional(),
          match: z.string().min(1).max(200).optional(),
        },
        async ({
          name,
          lines,
          match,
        }: {
          name: string;
          lines?: number;
          match?: string;
        }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            if (ctx.runner()?.runner)
              return result(
                "Runner Portal logs stay on the Runner. Read them there with the Runner tools.",
              );
            const sandbox = await ctx.sandbox();
            if (!sandbox && ctx.hasSandbox())
              return result(
                `Could not read the Portal log: ${noSandboxReason(ctx)}`,
              );
            const read = sandbox
              ? await readSandboxPortalLog({
                  sessionId: ctx.sessionId,
                  sandbox,
                  name,
                  lines,
                  match,
                })
              : await readHostPortalLog({
                  sessionId: ctx.sessionId,
                  name,
                  lines,
                  match,
                });
            return result(formatPortalLog(name, read, match));
          } catch (error) {
            return result(
              `Could not read the Portal log: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "stop_portal",
        "Stop one supervised Portal in this session. It never affects services in another session.",
        { name: z.string() },
        async ({ name }: { name: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const runner = ctx.runner();
            if (runner?.runner) {
              await stopRunnerPortal({ session: runner, name });
              return result(`Stopped ${name}.`);
            }
            const sandbox = await ctx.sandbox();
            if (!sandbox && ctx.hasSandbox())
              return result(`Could not stop Portal: ${noSandboxReason(ctx)}`);
            if (sandbox)
              await stopSandboxPortalService({
                sessionId: ctx.sessionId,
                sandbox,
                name,
              });
            else
              await stopPortalService({
                sessionId: ctx.sessionId,
                worktreeDir: dir,
                name,
              });
            return result(`Stopped ${name}.`);
          } catch (error) {
            return result(`Could not stop Portal: ${(error as Error).message}`);
          }
        },
      ),
      tool(
        "restart_portal",
        "Restart one supervised Portal using its registered command and port. Repository-declared Portals are refreshed from their trusted recipe before restart.",
        { name: z.string() },
        async ({ name }: { name: string }) => {
          const deadline = portalToolDeadline(ctx);
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const runner = ctx.runner();
            // Under the same deadline as a start: the wake is the step that
            // outlasts the call, and it relaunches the Portal being restarted
            // on its own.
            let sandbox: Sandbox | null | undefined;
            const run = (async (): Promise<string> => {
              sandbox = runner?.runner
                ? null
                : await ctx.sandbox({ wake: true });
              if (!sandbox && !runner?.runner && ctx.hasSandbox())
                return `Could not restart Portal: ${noSandboxReason(ctx)}`;
              const status = await portalStatus(ctx, dir, sandbox);
              const recipe = status.portalRecipes.find(
                (candidate) => candidate.id === name,
              );
              if (recipe) {
                const options = recipeStartOptions(recipe);
                if (sandbox) {
                  const restarting = restartSandboxPortalService({
                    sessionId: ctx.sessionId,
                    sandbox,
                    ...options,
                    env: sandboxPortalEnv(ctx, sandbox),
                  });
                  const outcome = await settleBefore(restarting, deadline);
                  if (!outcome.settled)
                    return stillStarting(ctx, dir, sandbox, name, restarting);
                  const portal = outcome.value;
                  const refreshed = await portalStatus(ctx, dir, sandbox);
                  return `${portal.name} restarted at ${refreshed.services.find((candidate) => candidate.key === portal.key)?.previewUrl ?? "its authenticated Portal URL"}.`;
                }
                // Stopping a loaded dev server can take most of the budget on
                // its own. The stop and the start keep running past the reply;
                // the registry records where they end up.
                const restarting = (async () => {
                  if (runner?.runner)
                    await stopRunnerPortal({ session: runner, name });
                  else
                    await stopPortalService({
                      sessionId: ctx.sessionId,
                      worktreeDir: dir,
                      name,
                    });
                  return startPortalForContext(
                    ctx,
                    dir,
                    sandbox ?? null,
                    options,
                    deadline,
                  );
                })();
                const outcome = await settleBefore(restarting, deadline);
                return outcome.settled
                  ? outcome.value
                  : stillStarting(ctx, dir, sandbox, name, restarting);
              }
              if (runner?.runner) {
                const portal = await restartRunnerPortal({
                  session: runner,
                  name,
                });
                return `${portal.name} restarted at ${(await runnerPortalUrl(portal)) ?? "its authenticated Portal URL"}.`;
              }
              const restarting = sandbox
                ? restartSandboxPortalService({
                    sessionId: ctx.sessionId,
                    sandbox,
                    name,
                    env: sandboxPortalEnv(ctx, sandbox),
                  })
                : restartPortalService({
                    sessionId: ctx.sessionId,
                    worktreeDir: dir,
                    name,
                  });
              const outcome = await settleBefore(restarting, deadline);
              if (!outcome.settled)
                return stillStarting(ctx, dir, sandbox, name, restarting);
              const portal = outcome.value;
              const refreshed = await portalStatus(ctx, dir, sandbox);
              return `${portal.name} restarted at ${refreshed.services.find((candidate) => candidate.key === portal.key)?.previewUrl ?? "its authenticated Portal URL"}.`;
            })();
            return result(
              await answerUnderDeadline(
                ctx,
                name,
                deadline,
                run,
                () => sandbox,
              ),
            );
          } catch (error) {
            return result(
              `Could not restart Portal: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "set_editor_preview_path",
        "Verify a Tella editor fixture lease server-side, then set and exclusively reserve its authoritative editor route. Invented, expired, mismatched, or inaccessible fixtures are rejected.",
        {
          fixtureLeaseId: z.string().regex(/^epfl_[A-Za-z0-9]+$/),
        },
        async ({ fixtureLeaseId }: { fixtureLeaseId: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            const fixture = verifiedEditorFixtureSchema.parse(
              await ctx.verifyEditorFixture(fixtureLeaseId),
            );
            if (fixture.leaseId !== fixtureLeaseId)
              throw new Error("Tella returned a different fixture lease.");
            const normalized = normalizePortalPath(fixture.editorPath);
            if (!normalized)
              throw new Error("Tella returned an empty editor staging route.");
            const pathname = new URL(normalized, "https://preview.invalid")
              .pathname;
            if (pathname !== `/video/${fixture.videoId}/edit`)
              throw new Error(
                "Tella's leased video ID does not match its editor route.",
              );
            const remainingMinutes = Math.floor(
              (Date.parse(fixture.expiresAt) - Date.now()) / 60_000,
            );
            if (remainingMinutes < 10 || remainingMinutes > 7 * 24 * 60)
              throw new Error(
                "Tella's editor fixture lease must have between 10 minutes and 7 days remaining.",
              );
            const reservation = await ctx.setDefaultPath(normalized, {
              exclusiveKey: `video:${fixture.videoId}`,
              sourceLeaseId: fixture.leaseId,
              leaseMinutes: remainingMinutes,
            });
            if (!reservation.leaseId)
              throw new Error("The staging record could not be reserved.");
            return result(
              `Verified and reserved Tella fixture ${fixture.leaseId} at ${normalized} for this session.`,
            );
          } catch (error) {
            return result(
              `Could not set editor preview path: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "set_portal_path",
        "Set the root-relative route a Portal should open by default. Omit name to set the session's default testing route.",
        { name: z.string().optional(), path: z.string() },
        async ({ name, path }: { name?: string; path: string }) => {
          const dir = workspace(ctx);
          if (dir instanceof Error) return result(dir.message);
          try {
            if (isTellaEditorPath(path))
              throw new Error(
                "Tella editor routes require set_editor_preview_path with a verified fixture lease.",
              );
            if (name) {
              const runner = ctx.runner();
              if (runner?.runner) {
                await setRunnerPortalPath({ session: runner, name, path });
                return result(`Set ${name}'s default route to ${path || "/"}.`);
              }
              const sandbox = await ctx.sandbox();
              if (!sandbox && ctx.hasSandbox())
                return result(
                  `Could not set Portal route: ${noSandboxReason(ctx)}`,
                );
              if (sandbox) await setSandboxPortalPath(sandbox, path, name);
              else await setPortalPath(dir, path, name);
            } else {
              const normalized = normalizePortalPath(path) ?? null;
              await ctx.setDefaultPath(normalized);
              return result(
                `Set this session's default route to ${normalized || "/"}.`,
              );
            }
            return result(`Set ${name}'s default route to ${path || "/"}.`);
          } catch (error) {
            return result(
              `Could not set Portal path: ${(error as Error).message}`,
            );
          }
        },
      ),
    ],
  });
}
