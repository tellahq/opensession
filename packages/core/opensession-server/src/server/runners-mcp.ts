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
          if (!runners.length) return text("No eligible Runners found.");
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
              .join("\n\n"),
          );
        },
      ),
      tool(
        "runner_status",
        "Read one Runner's health, workload, resources, and execution permissions. A Runner may be offline, busy, or in maintenance.",
        { runner: z.string() },
        async ({ runner }: { runner: string }) => {
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
        },
        async (args: {
          runner: string;
          command: string;
          cwd?: string;
          timeoutSeconds?: number;
        }) => {
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
                timeoutMs: Math.min(
                  Math.max((args.timeoutSeconds ?? 600) * 1000, 1_000),
                  3_600_000,
                ),
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
