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

export function createScheduleMcpServer(ctx: ScheduleToolContext) {
  const tz = timezoneForUser(ctx.user);
  const tools = [
    tool(
      "schedule_prompt",
      'Schedule a prompt to be sent to THIS session later, then end your turn. Use it instead of `sleep` for any wait longer than a few minutes: a benchmark or job you started, a release workflow, a deploy. For PR checks, use `wait_for` kind `pr_checks` where it is available: it wakes on the first failure. Give `in_minutes` (simplest) or an absolute `at`. The prompt arrives in this conversation marked as a scheduled check-back, so write it to your future self with everything needed to pick the work up: what to run, what "done" looks like, what to do on failure. Fires once; survives restarts. Do not use harness built-ins like CronCreate or ScheduleWakeup here; they do not exist in this session.',
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
        prompt: z
          .string()
          .describe(
            "The message to deliver to this session, addressed to yourself.",
          ),
      },
      async (args: { in_minutes?: number; at?: string; prompt: string }) => {
        const at = resolveDeliveryTime(args);
        if ("error" in at) return text(`Couldn't schedule it: ${at.error}`);
        const result = createScheduledPrompt({
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
        const prompts = listScheduledPrompts(ctx.sessionId);
        if (!prompts.length)
          return text("Nothing is scheduled for this session.");
        return text(prompts.map(fmt).join("\n"));
      },
    ),
    tool(
      "cancel_scheduled_prompt",
      "Cancel a prompt scheduled for this session by id.",
      {
        id: z
          .string()
          .describe("The id from schedule_prompt or list_scheduled_prompts."),
      },
      async (args: { id: string }) => {
        const own = listScheduledPrompts(ctx.sessionId).some(
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
