/**
 * opensession-github — an in-process MCP server that lets the agent trigger the GitHub
 * PR behaviors (the same review / auto-fix / simplify / adversarial actions the PR
 * labels fire) from Slack, for cases where the agent is mid-conversation. Explicit
 * "review PR <n>"-style commands are also intercepted deterministically before the
 * agent runs (see handlers.ts) — both paths share ./trigger.
 *
 * Created per interactive Slack message in handlers.ts and added to the Claude
 * run's mcpServers (in-process SDK MCP, like opensession-admin — Claude path only).
 */
import { defaultRepo, personaName } from "../../server/config";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  parsePrNumber,
  triggerPrAction,
  type PrActionKind,
} from "../github/trigger";
import { sendSlackMessage } from "./slack-api";

export interface GithubToolContext {
  /** Slack user id of the requester — used for commit attribution on fix/simplify/adversarial. */
  requestedBy: string;
  /** Slack channel + thread to report back to when the action finishes. */
  channel?: string;
  threadTs?: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const KIND_LABEL: Record<PrActionKind, string> = {
  review: "review",
  autofix: "auto-fix",
  simplify: "simplify pass",
  adversarial: "adversarial review",
};

const prArg = {
  pr: z
    .union([z.number(), z.string()])
    .describe(
      `The PR number on ${defaultRepo().ghRepo} (a number, '#4296', or a PR URL).`,
    ),
};

export function createGithubMcpServer(ctx: GithubToolContext) {
  const run = async (kind: PrActionKind, pr: number | string) => {
    const n = parsePrNumber(pr);
    if (!n) return text(`Couldn't read a PR number from "${pr}".`);
    const res = await triggerPrAction(kind, n, ctx.requestedBy);
    // Report back to the Slack thread when it finishes (this session has ended by
    // then, so the runner posts the follow-up).
    if (res.ok && res.done && ctx.channel) {
      const channel = ctx.channel;
      const threadTs = ctx.threadTs;
      void res.done.finally(() =>
        sendSlackMessage(
          channel,
          `✓ Finished the ${KIND_LABEL[kind]} on PR #${n} — results are on the PR${res.url ? `: ${res.url}` : ""}`,
          threadTs,
        ).catch(() => {}),
      );
    }
    return text(res.ok ? `On it — ${res.message}` : res.message);
  };

  const tools = [
    tool(
      "review_pr",
      `Run ${personaName()}'s automated code review on a ${defaultRepo().label} PR and post it on the PR: a single pinned summary comment (verdict + confidence) plus inline findings with severity. Use when asked to 'review PR <n>'. Read-only — makes no code changes.`,
      prArg,
      async ({ pr }: { pr: number | string }) => run("review", pr),
    ),
    tool(
      "auto_fix_pr",
      `Trigger ${personaName()}'s auto-fix on a ${defaultRepo().label} PR: resolve merge conflicts, address review findings and failing CI, push fixes to the PR branch, and loop until CI is green (bounded, never merges). Use when asked to 'auto-fix PR <n>'. Commits are attributed to you.`,
      prArg,
      async ({ pr }: { pr: number | string }) => run("autofix", pr),
    ),
    tool(
      "simplify_pr",
      `Run ${personaName()}'s /simplify pass on a ${defaultRepo().label} PR (quality cleanup — reuse, simplification, efficiency), push it, then re-review. Use when asked to 'simplify PR <n>'. Commits are attributed to you.`,
      prArg,
      async ({ pr }: { pr: number | string }) => run("simplify", pr),
    ),
    tool(
      "adversarial_review_pr",
      `Run ${personaName()}'s adversarial code review on a ${defaultRepo().label} PR (two independent hostile review passes, adjudicated), implement the accepted findings, push, and post a summary. Deeper than a normal review. Use when asked to 'adversarial review PR <n>' or for a rigorous/second-opinion review. Commits are attributed to you.`,
      prArg,
      async ({ pr }: { pr: number | string }) => run("adversarial", pr),
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-github",
    version: "1.0.0",
    tools,
  });
}
