/** Interactive-only Runner MCP. Runners are trusted machines, never Sandboxes. */

import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { execOnRunner, isRunnerConnected } from "./runner-ws";
import {
  getRunner,
  listRunners,
  publicRunner,
  releaseRunnerReservation,
  reserveRunner,
  runnerAllowed,
} from "./runners";
import {
  execOnMachine,
  findMachine,
  listMachineViews,
  machineAllows,
  machineView,
  releaseMachine,
  reserveMachine,
  startMachine,
  stopMachine,
  waitForMachine,
  type ManagedMachineView,
} from "./managed-machines";
import type { ManagedMachineConfig } from "./managed-machines/config";

function resolveRunner(query: string) {
  const wanted = query.trim().toLowerCase();
  if (!wanted)
    return { error: "Name a Runner. Use list_runners first." } as const;
  const runners = listRunners();
  const exact = runners.filter(
    (runner) => runner.id === query || runner.name.toLowerCase() === wanted,
  );
  if (exact.length === 1) return { runner: exact[0] } as const;
  const capability = runners.filter(
    (runner) =>
      runner.capabilities.toolchains.includes(wanted) ||
      runner.capabilities.tags.includes(wanted),
  );
  if (capability.length === 1) return { runner: capability[0] } as const;
  if (capability.length > 1)
    return {
      error: `'${query}' matches ${capability.map((runner) => runner.name).join(", ")}. Choose one.`,
    } as const;
  return { error: `No Runner matches '${query}'.` } as const;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** A managed machine, when the query names one and no Runner exactly. */
async function resolveMachine(
  query: string,
): Promise<ManagedMachineConfig | undefined> {
  const wanted = query.trim().toLowerCase();
  if (
    listRunners().some(
      (runner) => runner.id === query || runner.name.toLowerCase() === wanted,
    )
  )
    return undefined;
  return findMachine(query);
}

function machineSummary(view: ManagedMachineView): string {
  const lines = [
    `${view.label} (managed machine ${view.id})`,
    `state: ${view.state}${view.detail ? ` (${view.detail})` : ""}`,
  ];
  if (view.cpu !== undefined || view.gpu !== undefined)
    lines.push(
      `activity: ${[view.cpu !== undefined ? `cpu ${view.cpu}` : "", view.gpu !== undefined ? `gpu ${view.gpu}` : ""].filter(Boolean).join(", ")}`,
    );
  if (view.lastPollAt) lines.push(`last status check: ${view.lastPollAt}`);
  lines.push(
    view.execAvailable
      ? "commands: run_on_runner works while it is on"
      : "commands: none configured (start and stop only)",
  );
  if (view.idle?.kind === "idle")
    lines.push(`idle since ${view.idle.since}; stops at ${view.idle.stopAt}`);
  else if (view.idle?.kind === "held")
    lines.push(`kept on: ${view.idle.reasons.join("; ")}`);
  else if (view.idle?.kind === "not-idle")
    lines.push(
      `stops after ${view.idle.minutes} idle minutes; not idle now: ${view.idle.reason}`,
    );
  if (view.reservation)
    lines.push(
      `reserved by ${view.reservation.reservedBy ?? "someone"} until ${view.reservation.expiresAt}`,
    );
  if (view.attention) lines.push(`attention: ${view.attention}`);
  return lines.join("\n");
}

const WAIT_DEFAULT_MINUTES = 10;
const WAIT_MAX_MINUTES = 20;

function abortSignal(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

export function createRunnersMcpServer(
  context: {
    user?: string;
    sessionId?: string;
    repo?: () => string | undefined;
  } = {},
) {
  return createSdkMcpServer({
    name: "opensession-runners",
    version: "1.0.0",
    tools: [
      tool(
        "list_runners",
        "List workspace Runners. A Runner is a trusted, persistent machine, not an isolated Sandbox. Inspect capability and availability before choosing one.",
        {
          capability: z.string().optional(),
          tag: z.string().optional(),
          online: z.boolean().optional(),
        },
        async (args: {
          capability?: string;
          tag?: string;
          online?: boolean;
        }) => {
          const runners = listRunners().filter((runner) => {
            if (
              args.capability &&
              !runner.capabilities.toolchains.includes(args.capability)
            )
              return false;
            if (args.tag && !runner.capabilities.tags.includes(args.tag))
              return false;
            if (args.online === true && !isRunnerConnected(runner.id))
              return false;
            return runnerAllowed(runner, {
              user: context.user,
              repo: context.repo?.(),
              permission: "commands",
            });
          });
          const machines = (await listMachineViews(context.user)).filter(
            (machine) =>
              machine.allowed &&
              (args.online !== true || machine.state === "on") &&
              !args.capability &&
              !args.tag,
          );
          const machineText = machines.length
            ? `\n\nManaged machines (start_runner turns one on; they stop on their own when idle):\n\n${machines.map(machineSummary).join("\n\n")}`
            : "";
          if (!runners.length)
            return text(
              machineText
                ? machineText.trimStart()
                : "No eligible Runners found.",
            );
          return text(
            runners
              .map((runner) => {
                const view = publicRunner(
                  runner,
                  isRunnerConnected(runner.id),
                  Boolean(runner.workload),
                );
                return `${view.name} (${view.id})\nstate: ${view.state}\nplatform: ${view.platform}/${view.arch}\ncapabilities: ${view.capabilities.toolchains.join(", ") || "none"}\ntags: ${view.capabilities.tags.join(", ") || "none"}${view.resources?.gpu ? `\ngpu: ${view.resources.gpu.model ?? view.resources.gpu.kind}${view.resources.gpu.vramGb ? ` (${view.resources.gpu.vramGb} GB)` : ""}` : ""}${view.label ? `\nlabel: ${view.label}` : ""}`;
              })
              .join("\n\n") + machineText,
          );
        },
      ),
      tool(
        "runner_status",
        "Read one Runner's health, workload, resources, and execution permissions. A Runner may be offline, busy, or in maintenance.",
        { runner: z.string() },
        async ({ runner }: { runner: string }) => {
          const machine = await resolveMachine(runner);
          if (machine)
            return text(
              JSON.stringify(machineView(machine, context.user), null, 2),
            );
          const resolved = resolveRunner(runner);
          if ("error" in resolved)
            return text(resolved.error ?? "Runner not found.");
          const view = publicRunner(
            resolved.runner,
            isRunnerConnected(resolved.runner.id),
            Boolean(resolved.runner.workload),
          );
          return text(JSON.stringify(view, null, 2));
        },
      ),
      tool(
        "run_on_runner",
        "Run one bounded command on a trusted Runner. It runs as that machine's local user and is not sandboxed. Check status first, use only the session-owned workspace, and avoid destructive commands. Commands run under PowerShell on a win32 Runner and under bash elsewhere, so match the syntax to the Runner's platform.",
        {
          runner: z.string(),
          command: z.string(),
          cwd: z.string().optional(),
          timeoutSeconds: z.number().optional(),
          stdin: z
            .string()
            .optional()
            .describe(
              "Managed machines only: text passed to the command's stdin.",
            ),
        },
        async (
          args: {
            runner: string;
            command: string;
            cwd?: string;
            timeoutSeconds?: number;
            stdin?: string;
          },
          extra: unknown,
        ) => {
          const timeoutMs = Math.min(
            Math.max((args.timeoutSeconds ?? 600) * 1000, 1_000),
            3_600_000,
          );
          const machine = await resolveMachine(args.runner);
          if (machine) {
            // A managed machine has no cwd of its own: the operator's exec
            // prefix decides where commands start. Prepend a cd instead.
            if (args.cwd)
              return text(
                `${machine.label} does not take cwd. Start the command with cd instead.`,
              );
            try {
              const result = await execOnMachine(machine.id, args.command, {
                user: context.user,
                sessionId: context.sessionId,
                timeoutMs,
                stdin: args.stdin,
                signal: abortSignal(extra),
              });
              return text(
                `${machine.label}: exit ${result.code}${result.timedOut ? " (TIMED OUT)" : ""}${result.cancelled ? " (CANCELLED)" : ""}${result.stdout.trim() ? `\n\nstdout:\n${result.stdout.trimEnd()}` : ""}${result.stderr.trim() ? `\n\nstderr:\n${result.stderr.trimEnd()}` : ""}`,
              );
            } catch (error) {
              return text(
                `Could not run on ${machine.label}: ${(error as Error).message}`,
              );
            }
          }
          if (args.stdin !== undefined)
            return text("stdin is only supported on managed machines.");
          const resolved = resolveRunner(args.runner);
          if ("error" in resolved)
            return text(resolved.error ?? "Runner not found.");
          if (!isRunnerConnected(resolved.runner.id))
            return text(
              `${resolved.runner.name} is offline, so no work was queued.`,
            );
          try {
            const result = await execOnRunner(
              resolved.runner.id,
              args.command,
              {
                cwd: args.cwd,
                timeoutMs,
                aws: true,
                user: context.user,
                repo: context.repo?.(),
                sessionId: context.sessionId,
              },
            );
            return text(
              `${resolved.runner.name}: exit ${result.code}${result.timedOut ? " (TIMED OUT)" : ""}${result.stdout.trim() ? `\n\nstdout:\n${result.stdout.trimEnd()}` : ""}${result.stderr.trim() ? `\n\nstderr:\n${result.stderr.trimEnd()}` : ""}`,
            );
          } catch (error) {
            return text(
              `Could not run on ${resolved.runner.name}: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "start_runner",
        "Turn on a managed machine (see list_runners) and wait until its status check reports it on. A cold start can take several minutes; if it is not on when the wait ends, call again to keep waiting. Managed machines stop on their own after an idle period: reserve_runner keeps one on across long pauses.",
        {
          runner: z.string(),
          waitMinutes: z
            .number()
            .optional()
            .describe(
              `Minutes to wait (default ${WAIT_DEFAULT_MINUTES}, max ${WAIT_MAX_MINUTES}, 0 to return at once).`,
            ),
        },
        async (args: { runner: string; waitMinutes?: number }) => {
          const machine = await resolveMachine(args.runner);
          if (!machine)
            return text(
              `No managed machine matches '${args.runner}'. Ordinary Runners cannot be started from Open Session.`,
            );
          if (!machineAllows(machine, context.user))
            return text(`You are not allowed to use ${machine.label}.`);
          try {
            // startMachine skips the command while the machine is on or an
            // earlier start is still on its way, so calling again only waits.
            await startMachine(machine.id, {
              user: context.user,
              via: "agent",
            });
            const minutes = Math.min(
              Math.max(args.waitMinutes ?? WAIT_DEFAULT_MINUTES, 0),
              WAIT_MAX_MINUTES,
            );
            const view = await waitForMachine(
              machine.id,
              context.user,
              minutes * 60_000,
            );
            if (view.state === "on")
              return text(
                `${machine.label} is on.${view.execAvailable ? " Use run_on_runner." : ""}${view.idle ? ` It stops after ${view.idle.minutes} idle minutes unless reserved.` : ""}`,
              );
            if (view.lastAction?.ok === false)
              return text(
                `${machine.label} did not start: ${view.lastAction.error ?? "the start command failed"}.`,
              );
            return text(
              `${machine.label} is still ${view.state}${view.detail ? ` (${view.detail})` : ""}${view.lastPollError ? `; status check: ${view.lastPollError}` : ""}. Call start_runner again to keep waiting; it does not start it twice.`,
            );
          } catch (error) {
            return text(
              `Could not start ${machine.label}: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "stop_runner",
        "Turn off a managed machine now. Refused while it is in use (a command running through Open Session, or someone else's reservation). Idle machines stop on their own, so call this only when the work is done.",
        { runner: z.string() },
        async ({ runner }: { runner: string }) => {
          const machine = await resolveMachine(runner);
          if (!machine)
            return text(
              `No managed machine matches '${runner}'. Ordinary Runners cannot be stopped from Open Session.`,
            );
          try {
            await stopMachine(machine.id, { user: context.user, via: "agent" });
            return text(`${machine.label}'s stop command succeeded.`);
          } catch (error) {
            return text(
              `Did not stop ${machine.label}: ${(error as Error).message}`,
            );
          }
        },
      ),
      tool(
        "reserve_runner",
        "Reserve a scarce trusted Runner for this session. This does not bypass permissions or turn it into a Sandbox.",
        {
          runner: z.string(),
          reason: z.string(),
          durationMinutes: z.number().optional(),
        },
        async (args: {
          runner: string;
          reason: string;
          durationMinutes?: number;
        }) => {
          const machine = await resolveMachine(args.runner);
          if (machine) {
            try {
              const reservation = await reserveMachine(machine.id, {
                user: context.user,
                sessionId: context.sessionId,
                reason: args.reason,
                durationMinutes: args.durationMinutes,
              });
              return text(
                `${machine.label} is reserved until ${reservation.expiresAt}. It will not stop for idleness meanwhile.`,
              );
            } catch (error) {
              return text((error as Error).message);
            }
          }
          const resolved = resolveRunner(args.runner);
          if ("error" in resolved)
            return text(resolved.error ?? "Runner not found.");
          const reserved = reserveRunner(resolved.runner.id, {
            reason: args.reason,
            reservedBy: context.user,
            sessionId: context.sessionId,
            durationMinutes: args.durationMinutes,
          });
          return reserved
            ? text(
                `${reserved.name} is reserved until ${reserved.reservation?.expiresAt}.`,
              )
            : text(
                `${resolved.runner.name} is unavailable or already reserved.`,
              );
        },
      ),
      tool(
        "release_runner_reservation",
        "Release this user's reservation on a Runner.",
        { runner: z.string() },
        async ({ runner }: { runner: string }) => {
          const machine = await resolveMachine(runner);
          if (machine) {
            try {
              await releaseMachine(machine.id, { user: context.user });
              return text(`Released ${machine.label}.`);
            } catch (error) {
              return text((error as Error).message);
            }
          }
          const resolved = resolveRunner(runner);
          if ("error" in resolved)
            return text(resolved.error ?? "Runner not found.");
          return releaseRunnerReservation(resolved.runner.id, context.user)
            ? text(`Released ${resolved.runner.name}.`)
            : text(`Could not release ${resolved.runner.name}.`);
        },
      ),
    ],
  });
}
