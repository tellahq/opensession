/**
 * opensession-schedule — "check back on this later" for the current session.
 *
 * A thin in-process MCP server over scheduled-prompts.ts: the prompt is stored
 * durably and delivered to THIS session by a SessionKernel timer, so it
 * survives a server restart and needs no live model process. This is the
 * sanctioned replacement for harness built-ins like CronCreate or
 * ScheduleWakeup, which live in one SDK subprocess's memory and die with it.
 *
 * Interactive-only (interactive-mcp.ts): a scheduled prompt is a future turn
 * in a human's session, so untrusted automation text must never author one.
 * Slack runs keep opensession-admin's schedule_once, which creates a one-off
 * automation instead of resuming a session.
 */

import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { z } from "zod";
import { timezoneForUser } from "./shared/user-mappings";
import {
  createScheduledPrompt,
  deleteScheduledPrompt,
  listScheduledPrompts,
  type ScheduledPrompt,
} from "./scheduled-prompts";
import { getSessionControl } from "./session-control";
import { MAX_LOOP_FOR_MINUTES, MIN_LOOP_MINUTES } from "./session-loop";

export interface ScheduleToolContext {
  sessionId: string;
  /** Credited as the sender of the delivered prompt. */
  user: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fmt(p: ScheduledPrompt): string {
  const snippet =
    p.prompt.length > 80 ? `${p.prompt.slice(0, 77)}...` : p.prompt;
  return `- [${p.id}] at ${p.at}: ${snippet.replace(/\s+/g, " ")}`;
}

/** A week: longer than any sensible check-back, short enough to catch a
 *  seconds-for-minutes mistake. */
const MAX_DELAY_MINUTES = 7 * 24 * 60;

/** Exactly one of a relative delay or an absolute time. A relative delay
 *  spares the model computing a timestamp, which is most of what made
 *  `sleep` the easier choice for a short wait. */
export function resolveDeliveryTime(
  args: { in_minutes?: number; at?: string },
  now = Date.now(),
): { at: string } | { error: string } {
  const hasDelay = args.in_minutes !== undefined;
  const hasAt = Boolean(args.at?.trim());
  if (hasDelay === hasAt)
    return { error: "Give exactly one of `in_minutes` or `at`." };
  if (hasAt) return { at: args.at!.trim() };
  const minutes = args.in_minutes!;
  if (!Number.isFinite(minutes) || minutes <= 0)
    return { error: "`in_minutes` must be a positive number." };
  if (minutes > MAX_DELAY_MINUTES)
    return { error: `\`in_minutes\` must be at most ${MAX_DELAY_MINUTES}.` };
  return { at: new Date(now + minutes * 60_000).toISOString() };
}

/** Loops live on the session record and already have one front door, the
 *  `/loop` slash command; going through session control keeps a single
 *  writer and publishes the change to every client. */
async function loopCommand(
  ctx: ScheduleToolContext,
  command: string,
): Promise<string> {
  try {
    const result = await getSessionControl().deliverToSession(
      ctx.sessionId,
      command,
      ctx.user,
    );
    return result.message;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function loopCommandFor(args: {
  in_minutes?: number;
  at?: string;
  every_minutes?: number;
  for_minutes?: number;
  prompt: string;
}): { command: string } | { error: string } {
  if (args.in_minutes !== undefined || args.at?.trim())
    return {
      error:
        "Give `every_minutes` and `for_minutes` for a loop, or `in_minutes`/`at` for one check-back, not both.",
    };
  if (args.every_minutes === undefined || args.for_minutes === undefined)
    return { error: "A loop needs both `every_minutes` and `for_minutes`." };
  const every = Math.round(args.every_minutes);
  const duration = Math.round(args.for_minutes);
  if (!Number.isFinite(every) || every < MIN_LOOP_MINUTES)
    return { error: `\`every_minutes\` must be at least ${MIN_LOOP_MINUTES}.` };
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > MAX_LOOP_FOR_MINUTES
  )
    return {
      error: `\`for_minutes\` must be between 1 and ${MAX_LOOP_FOR_MINUTES}.`,
    };
  const prompt = args.prompt.trim();
  if (!prompt) return { error: "Prompt is required." };
  return { command: `/loop ${every}m for ${duration}m ${prompt}` };
}

async function startLoop(
  ctx: ScheduleToolContext,
  args: Parameters<typeof loopCommandFor>[0],
): Promise<string> {
  const loop = loopCommandFor(args);
  if ("error" in loop) return `Couldn't start the loop: ${loop.error}`;
  const notice = await loopCommand(ctx, loop.command);
  if (!notice.startsWith("Loop set"))
    return `Couldn't start the loop: ${notice}`;
  return `${notice} Give your update as this turn's final answer and end your turn now. Stop early with cancel_scheduled_prompt id \`loop\`.`;
}

export function createScheduleMcpServer(ctx: ScheduleToolContext) {
  const tz = timezoneForUser(ctx.user);
  const tools = [
    tool(
      "schedule_prompt",
      'Schedule a prompt to be sent to THIS session later, then end your turn. Use it instead of `sleep` for any wait longer than a few minutes: a benchmark or job you started, a release workflow, a deploy. To keep monitoring something with regular updates, pass `every_minutes` and `for_minutes` instead of `in_minutes`/`at`: the prompt then comes back on that interval until the time runs out or you cancel id `loop`, and the final answer of each check is the update (text written mid-turn is hidden and notifies no one, so never poll inside one turn). For PR checks, use `wait_for` kind `pr_checks` where it is available: it wakes on the first failure. For a GitHub Actions run with no PR (a release workflow after a tag push), use `wait_for` kind `workflow_run`. Give `in_minutes` (simplest) or an absolute `at`. The prompt arrives in this conversation marked as a scheduled check-back, so write it to your future self with everything needed to pick the work up: what to run, what "done" looks like, what to do on failure. Without `every_minutes` it fires once. Survives restarts. Do not use harness built-ins like CronCreate or ScheduleWakeup here; they do not exist in this session.',
      {
        in_minutes: z
          .number()
          .positive()
          .max(MAX_DELAY_MINUTES)
          .optional()
          .describe(
            "Deliver this many minutes from now (e.g. 20). Use this or `at`.",
          ),
        at: z
          .string()
          .optional()
          .describe(
            `Deliver at this ISO 8601 UTC datetime (e.g. 2026-09-01T19:49:00Z), for a wall-clock time. The user's timezone is ${tz}. Use this or \`in_minutes\`.`,
          ),
        every_minutes: z
          .number()
          .int()
          .min(MIN_LOOP_MINUTES)
          .optional()
          .describe(
            `Repeat the prompt every this many minutes (at least ${MIN_LOOP_MINUTES}), for monitoring with regular updates. Replaces any loop already set on this session. Needs \`for_minutes\`.`,
          ),
        for_minutes: z
          .number()
          .int()
          .positive()
          .max(MAX_LOOP_FOR_MINUTES)
          .optional()
          .describe(
            "With `every_minutes`: stop repeating after this many minutes (e.g. 120). Pick what the person asked for, or a sensible bound.",
          ),
        prompt: z
          .string()
          .describe(
            "The message to deliver to this session, addressed to yourself.",
          ),
      },
      async (args: {
        in_minutes?: number;
        at?: string;
        every_minutes?: number;
        for_minutes?: number;
        prompt: string;
      }) => {
        if (args.every_minutes !== undefined || args.for_minutes !== undefined)
          return text(await startLoop(ctx, args));
        const at = resolveDeliveryTime(args);
        if ("error" in at) return text(`Couldn't schedule it: ${at.error}`);
        const result = await createScheduledPrompt({
          sessionId: ctx.sessionId,
          prompt: args.prompt,
          at: at.at,
          user: ctx.user,
        });
        if ("error" in result)
          return text(`Couldn't schedule it: ${result.error}`);
        return text(
          `Scheduled [${result.id}] for ${result.at}. It will arrive in this session as a new message; end your turn now. Cancel with cancel_scheduled_prompt.`,
        );
      },
    ),
    tool(
      "list_scheduled_prompts",
      "List prompts scheduled for this session, soonest first.",
      {},
      async () => {
        const lines = (await listScheduledPrompts(ctx.sessionId)).map(fmt);
        const loop = await loopCommand(ctx, "/loop status");
        if (loop.startsWith("Loop active")) lines.push(`- [loop] ${loop}`);
        if (!lines.length)
          return text("Nothing is scheduled for this session.");
        return text(lines.join("\n"));
      },
    ),
    tool(
      "cancel_scheduled_prompt",
      "Cancel a prompt scheduled for this session by id. Id `loop` stops this session's repeating loop.",
      {
        id: z
          .string()
          .describe(
            "The id from schedule_prompt or list_scheduled_prompts, or `loop`.",
          ),
      },
      async (args: { id: string }) => {
        if (args.id.trim() === "loop")
          return text(await loopCommand(ctx, "/loop stop"));
        const own = (await listScheduledPrompts(ctx.sessionId)).some(
          (p) => p.id === args.id,
        );
        if (!own)
          return text(`No scheduled prompt ${args.id} in this session.`);
        const removed = await deleteScheduledPrompt(args.id);
        return text(
          removed ? `Cancelled ${args.id}.` : `${args.id} was already gone.`,
        );
      },
    ),
  ];
  return createSdkMcpServer({
    name: "opensession-schedule",
    version: "1.0.0",
    tools,
  });
}
