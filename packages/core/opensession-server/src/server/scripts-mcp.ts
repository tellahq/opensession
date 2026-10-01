/**
 * opensession-scripts: run a long script or migration as a supervised run
 * (script-runs.ts) instead of a shell job that dies with the turn or the
 * server.
 *
 * Interactive runs only, like Portals: a run outlives the call that started
 * it, so an automation's untrusted input must not be able to leave one
 * behind.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  DEFAULT_SCRIPT_MINUTES,
  listScriptRuns,
  MAX_SCRIPT_COMMAND_CHARS,
  MAX_SCRIPT_MINUTES,
  scriptRunStatus,
  startScriptRun,
  stopScriptRun,
} from "./script-runs";
import {
  scriptEnv,
  scriptLogDir,
  scriptWorkspace,
  type ScriptSessionLookup,
} from "./script-workspace";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export function createScriptsMcpServer(ctx: {
  sessionId: string;
  user?: string;
  /** Test seam; defaults to the session cache. */
  session?: ScriptSessionLookup;
}) {
  return createSdkMcpServer({
    name: "opensession-scripts",
    version: "1.0.0",
    tools: [
      tool(
        "start_script",
        `Run a long shell command (a migration, backfill, sync, data fix, long build) as a supervised script run instead of a background shell job. It keeps running through Open Session restarts and deploys, shows as a card in the session where people can follow and stop it, and when it ends this session is woken with how it ended and the end of its output, so start it and end your turn instead of polling or scheduling a check-back. It runs on this server, in the session's workspace, with a minimal environment (PATH, HOME, LANG, TMPDIR): pass anything else on the command line, e.g. 'set -a; . ./.env; set +a; bun scripts/migrate.ts'. Make long jobs resumable and print progress lines. Output is appended to the log at logPath. A Sandbox or Runner session cannot start one. For a script that needs a teammate's credential, use run_with_credential (opensession-keychain) instead.`,
        {
          command: z
            .string()
            .min(1)
            .max(MAX_SCRIPT_COMMAND_CHARS)
            .describe("The bash command to run."),
          title: z
            .string()
            .max(120)
            .optional()
            .describe(
              "Short name people see on the card, e.g. 'Backfill workspace plans'. Defaults to the command.",
            ),
          cwd: z
            .string()
            .max(4000)
            .optional()
            .describe(
              "Directory to run in: absolute, or relative to the session's workspace (the default).",
            ),
          timeoutMinutes: z
            .number()
            .positive()
            .max(MAX_SCRIPT_MINUTES)
            .optional()
            .describe(
              `Stop the run after this long. Default ${DEFAULT_SCRIPT_MINUTES}, at most ${MAX_SCRIPT_MINUTES}.`,
            ),
          notify: z
            .boolean()
            .optional()
            .describe(
              "Wake this session when the run ends (default true). Turn off only for fire-and-forget work nobody needs to hear about.",
            ),
        },
        async (args: {
          command: string;
          title?: string;
          cwd?: string;
          timeoutMinutes?: number;
          notify?: boolean;
        }) => {
          const where = scriptWorkspace(ctx.sessionId, args.cwd, ctx.session);
          if ("error" in where) return text(`Couldn't start: ${where.error}.`);
          const result = await startScriptRun({
            sessionId: ctx.sessionId,
            command: args.command,
            cwd: where.cwd,
            logDir: scriptLogDir(ctx.sessionId),
            env: scriptEnv(ctx.sessionId),
            ...(args.title ? { title: args.title } : {}),
            ...(args.timeoutMinutes !== undefined
              ? { timeoutMinutes: args.timeoutMinutes }
              : {}),
            ...(args.notify !== undefined ? { notify: args.notify } : {}),
            ...(ctx.user ? { startedBy: ctx.user } : {}),
          });
          if ("error" in result)
            return text(`Couldn't start: ${result.error}.`);
          return text(
            JSON.stringify({
              run: result.run,
              next: result.run.notify
                ? "It's running. Tell the person it started, then end your turn: this session is woken when it ends. script_status shows progress meanwhile."
                : "It's running. Check it with script_status.",
            }),
          );
        },
      ),
      tool(
        "script_status",
        "Check a script run started with start_script or run_with_credential: running/exited/failed/timed_out/stopped/revoked/lost, exit code, start and end times, credential call counts, and the last few KB of its output (the full log is at logPath). Without an id, lists this session's runs.",
        {
          id: z
            .string()
            .optional()
            .describe("The run's id, 'sr-…'. Omit to list runs."),
        },
        async ({ id }: { id?: string }) => {
          if (!id)
            return text(JSON.stringify(await listScriptRuns(ctx.sessionId)));
          const status = await scriptRunStatus(id, ctx.sessionId);
          return text(
            status
              ? JSON.stringify(status)
              : "No script run with that id in this session.",
          );
        },
      ),
      tool(
        "stop_script",
        "Stop a running script run: its process group is sent SIGTERM, then SIGKILL after 10 seconds. The session is woken when it has ended, as for any other end.",
        { id: z.string().describe("The run's id, 'sr-…'.") },
        async ({ id }: { id: string }) => {
          const result = await stopScriptRun(id, ctx.sessionId);
          if ("error" in result) return text(`Couldn't stop: ${result.error}.`);
          return text(JSON.stringify(result.run));
        },
      ),
    ],
  });
}
