/**
 * opensession-gpu: run a command or a repository's declared GPU job on a GPU
 * machine (gpu-jobs.ts) from a session that has no GPU.
 *
 * Interactive runs only, like scripts and Portals: a job outlives the call
 * and bills a GPU, so an automation's untrusted input must not start one.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  DEFAULT_GPU_JOB_MINUTES,
  GPU_JOBS_FILE,
  gpuJobStatus,
  listGpuJobs,
  MAX_GPU_JOB_MINUTES,
  sessionRepoGpuJobs,
  startGpuJob,
  stopGpuJob,
} from "./gpu-jobs";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export function createGpuMcpServer(ctx: { sessionId: string; user?: string }) {
  return createSdkMcpServer({
    name: "opensession-gpu",
    version: "1.0.0",
    tools: [
      tool(
        "run_gpu_job",
        `Run work that needs an NVIDIA GPU (CUDA, Vulkan) on a GPU machine, from a session without one. Pass \`job\` to run one the repository declares in ${GPU_JOBS_FILE} (call with no arguments to list them), or \`command\` for any bash command, e.g. a single test. The session's work is checkpointed, uncommitted changes included, and landed on the session's own GPU machine (Modal, T4 or L4), which keeps its build cache between jobs and sleeps when idle. The command runs from the repository root with a read-only GitHub credential for the repository and its private build dependencies. It keeps running through Open Session restarts, and this session is woken with the exit code and the end of the output when it ends: start it, tell the person, and end your turn instead of polling. One job at a time per session.`,
        {
          job: z
            .string()
            .max(80)
            .optional()
            .describe(`A job name from ${GPU_JOBS_FILE}.`),
          command: z
            .string()
            .max(8000)
            .optional()
            .describe(
              "A bash command to run instead of (or, with `job`, in place of) the declared one.",
            ),
          gpu: z
            .enum(["T4", "L4"])
            .optional()
            .describe(
              "NVIDIA T4 (16 GB) or L4 (24 GB). Defaults to the job's, else T4.",
            ),
          timeoutMinutes: z
            .number()
            .positive()
            .max(MAX_GPU_JOB_MINUTES)
            .optional()
            .describe(
              `Stop the job after this long. Default: the job's, else ${DEFAULT_GPU_JOB_MINUTES}.`,
            ),
        },
        async (args: {
          job?: string;
          command?: string;
          gpu?: "T4" | "L4";
          timeoutMinutes?: number;
        }) => {
          const { findSessionAsync } = await import("./session-cache");
          const session = await findSessionAsync(ctx.sessionId);
          if (!session) return text("Couldn't start: no such session.");
          const declared = await sessionRepoGpuJobs(session);
          if (!args.job && !args.command)
            return text(
              JSON.stringify({
                jobs: declared,
                next: Object.keys(declared).length
                  ? "Pass `job` to run one, or `command` for anything else."
                  : `This repository declares no GPU jobs in ${GPU_JOBS_FILE}; pass \`command\`.`,
              }),
            );
          const spec = args.job ? declared[args.job] : undefined;
          if (args.job && !spec)
            return text(
              `Couldn't start: no GPU job named "${args.job}". Declared: ${Object.keys(declared).join(", ") || "none"}.`,
            );
          const result = await startGpuJob({
            sessionId: ctx.sessionId,
            title: args.job || args.command!.split("\n")[0]!.slice(0, 80),
            command: args.command || spec!.command,
            gpu: args.gpu || spec?.gpu || "T4",
            timeoutMinutes:
              args.timeoutMinutes ??
              spec?.timeoutMinutes ??
              DEFAULT_GPU_JOB_MINUTES,
            ...(ctx.user ? { startedBy: ctx.user } : {}),
          });
          if ("error" in result)
            return text(`Couldn't start: ${result.error}.`);
          return text(
            JSON.stringify({
              job: result.job,
              next: "The GPU machine is being prepared (about a minute when it exists, a few minutes the first time), then the job runs. Tell the person it started, then end your turn: this session is woken when it ends. gpu_job_status shows progress meanwhile.",
            }),
          );
        },
      ),
      tool(
        "gpu_job_status",
        "Check a GPU job started with run_gpu_job: preparing/running/exited/failed/timed_out/stopped/lost, exit code, the commit it ran on, and the end of its output. Without an id, lists this session's jobs.",
        { id: z.string().optional().describe("The job's id, 'gj-…'.") },
        async ({ id }: { id?: string }) => {
          if (!id)
            return text(JSON.stringify(await listGpuJobs(ctx.sessionId)));
          const status = await gpuJobStatus(id, ctx.sessionId);
          return text(
            status
              ? JSON.stringify(status)
              : "No GPU job with that id in this session.",
          );
        },
      ),
      tool(
        "stop_gpu_job",
        "Stop a running GPU job: its process group gets SIGTERM, then SIGKILL. The session is woken when it has ended.",
        { id: z.string().describe("The job's id, 'gj-…'.") },
        async ({ id }: { id: string }) => {
          const result = await stopGpuJob(id, ctx.sessionId);
          if ("error" in result) return text(`Couldn't stop: ${result.error}.`);
          return text(JSON.stringify(result.job));
        },
      ),
    ],
  });
}
