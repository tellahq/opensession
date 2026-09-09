/**
 * opensession-pull-requests — the owner-identity GitHub tools.
 *
 * An agent run's shell holds a repository-scoped App installation token and
 * never a person's (docs/github-authority.md). When a person started the
 * turn, these tools let the agent do the two things that should carry that
 * person's name, opening and editing the pull request, by having the GATEWAY
 * make the request with the person's token. The token never enters the run.
 *
 * The third tool, propose_merge, holds no token at all: it checks the PR is
 * mergeable, writes a notice into the session, and the person taps Merge in
 * the PR panel, which calls the same pr-merge route the button always used.
 * Nothing in the agent's reach can perform the merge.
 *
 * Mounted only when the turn's sender resolves to a connected person
 * (ownerGithubUser). A review handoff, a worker report, or an automation is
 * nobody and gets no such tools.
 */

import { z } from "zod";
import { audited } from "./audit";
import { githubCredentialUser } from "./auto-continue";
import type { GithubCredential } from "./github-auth";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import type { MutationPrMeta, PrDetails } from "./pr-contract";
import { isMachineActor } from "./session-actors";

/**
 * The person a turn acts for, or undefined: the sender, unless it is the
 * synthetic auto-continue driver, in which case the session owner (#322). A
 * machine sender (a review handoff, a worker report, an automation) is
 * nobody. Errs toward nobody: an unknown sender is not the owner.
 */
export function ownerGithubUser(
  user?: string | null,
  sessionOwner?: string | null,
): string | undefined {
  const who = githubCredentialUser(user, sessionOwner);
  return who && !isMachineActor(who) ? who : undefined;
}

export interface PullRequestWorkspace {
  /** GitHub `owner/name`. */
  ghRepo: string;
  /** The session's branch in that repository, if it has one. */
  branch?: string;
  baseBranch: string;
}

export interface PullRequestToolContext {
  sessionId: string;
  /** GitHub login of the person the tools act as (messages only). */
  login: string;
  /** The person's credential, resolved per call because tokens refresh.
   * Null when they disconnected since the turn started. */
  credential: () => GithubCredential | null;
  /** The session's checkout in one of its repositories: the primary when
   * `repo` is omitted. Null for a repository the session does not carry. */
  workspace: (repo?: string) => PullRequestWorkspace | null;
  prMeta: (
    branch: string,
    ghRepo: string,
    credential: GithubCredential,
  ) => Promise<MutationPrMeta | null>;
  prDetails: (branch: string, ghRepo: string) => Promise<PrDetails | null>;
  /** Post a runner notice into the session transcript. */
  notice: (text: string, id: string) => Promise<void>;
  /** Run `gh` as the credential; resolves stdout, rejects with stderr. */
  gh?: (
    args: string[],
    credential: GithubCredential,
    stdin?: string,
  ) => Promise<string>;
}

async function runGh(
  args: string[],
  credential: GithubCredential,
  stdin?: string,
): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error((err || `gh ${args[0]} failed`).slice(0, 400));
  return out;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function failure(message: string) {
  return { ...text(message), isError: true as const };
}

const repoArg = z
  .string()
  .optional()
  .describe(
    "Repository id as listed by opensession-repos (omit for the session's primary repo).",
  );

function checksSummary(details: PrDetails | null): string {
  const checks = details?.checks ?? [];
  if (!checks.length) return "no checks reported";
  const failing = checks.filter((c) =>
    /^(failure|cancelled|timed_out|action_required|error)$/i.test(
      c.conclusion || "",
    ),
  ).length;
  const pending = checks.filter(
    (c) => !c.conclusion || /^(pending|in_progress|queued)$/i.test(c.status),
  ).length;
  if (failing) return `${failing} of ${checks.length} checks failing`;
  if (pending) return `${pending} of ${checks.length} checks still running`;
  return `all ${checks.length} checks passing`;
}

export function createPullRequestMcpServer(ctx: PullRequestToolContext) {
  const gh = ctx.gh ?? runGh;

  type Resolved =
    | { error: string }
    | {
        ws: PullRequestWorkspace & { branch: string };
        credential: GithubCredential;
      };
  const resolve = (repo?: string): Resolved => {
    const ws = ctx.workspace(repo);
    if (!ws)
      return {
        error: repo
          ? `This session does not carry repository ${repo}.`
          : "This session has no GitHub repository.",
      };
    if (!ws.branch)
      return {
        error: "The session has no branch yet. Commit and push a branch first.",
      };
    const credential = ctx.credential();
    if (!credential)
      return {
        error: `@${ctx.login} is no longer connected to GitHub. Ask them to reconnect in Settings, or open the PR with gh as the bot.`,
      };
    return { ws: { ...ws, branch: ws.branch }, credential };
  };

  const tools = [
    tool(
      "open_pull_request",
      `Open a pull request for this session's pushed branch under @${ctx.login}'s own GitHub account. The request is made by the gateway with their token; you never hold it. Prefer this over \`gh pr create\`, which opens the PR as the bot. Push the branch first. End the body with the attribution footer from the session context.`,
      {
        repo: repoArg,
        title: z.string().min(1).describe("PR title."),
        body: z.string().describe("PR body, markdown."),
        base: z
          .string()
          .optional()
          .describe("Base branch (default: the repository's default branch)."),
        draft: z.boolean().optional().describe("Open as a draft."),
      },
      async ({ repo, title, body, base, draft }) => {
        const r = resolve(repo);
        if ("error" in r) return failure(r.error);
        const { ws, credential } = r;
        const existing = await ctx
          .prMeta(ws.branch, ws.ghRepo, credential)
          .catch(() => null);
        if (existing && existing.state === "OPEN")
          return text(
            `A pull request is already open for ${ws.branch}: ${existing.url}. Use edit_pull_request to change it.`,
          );
        const args = [
          "pr",
          "create",
          "--repo",
          ws.ghRepo,
          "--head",
          ws.branch,
          "--base",
          base || ws.baseBranch,
          "--title",
          title,
          "--body-file",
          "-",
          ...(draft ? ["--draft"] : []),
        ];
        try {
          const out = await audited(
            {
              context: "pull-requests",
              action: "open",
              args: {
                session: ctx.sessionId,
                repo: ws.ghRepo,
                branch: ws.branch,
                base: base || ws.baseBranch,
                draft: !!draft,
                credential: credential.principal,
              },
            },
            () => gh(args, credential, body),
          );
          const url = out.trim().split("\n").at(-1) || "";
          return text(`Opened ${url} as @${ctx.login}.`);
        } catch (error) {
          return failure(
            `Could not open the pull request: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),

    tool(
      "edit_pull_request",
      `Change the title, body, or draft state of this session's pull request as @${ctx.login}. The gateway makes the request with their token.`,
      {
        repo: repoArg,
        number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("PR number (default: the PR for the session's branch)."),
        title: z.string().optional(),
        body: z.string().optional().describe("Replaces the whole body."),
        ready: z
          .boolean()
          .optional()
          .describe(
            "true marks a draft ready for review; false converts to draft.",
          ),
      },
      async ({ repo, number, title, body, ready }) => {
        if (title === undefined && body === undefined && ready === undefined)
          return failure("Nothing to change: give a title, body, or ready.");
        const r = resolve(repo);
        if ("error" in r) return failure(r.error);
        const { ws, credential } = r;
        let prNumber = number;
        if (!prNumber) {
          const meta = await ctx
            .prMeta(ws.branch, ws.ghRepo, credential)
            .catch(() => null);
          if (!meta)
            return failure(
              `No pull request for ${ws.branch}. Open one with open_pull_request.`,
            );
          prNumber = meta.number;
        }
        try {
          await audited(
            {
              context: "pull-requests",
              action: "edit",
              args: {
                session: ctx.sessionId,
                repo: ws.ghRepo,
                number: prNumber,
                fields: [
                  ...(title !== undefined ? ["title"] : []),
                  ...(body !== undefined ? ["body"] : []),
                  ...(ready !== undefined ? ["ready"] : []),
                ],
                credential: credential.principal,
              },
            },
            async () => {
              if (title !== undefined || body !== undefined)
                await gh(
                  [
                    "api",
                    "-X",
                    "PATCH",
                    `repos/${ws.ghRepo}/pulls/${prNumber}`,
                    "--input",
                    "-",
                  ],
                  credential,
                  JSON.stringify({
                    ...(title !== undefined ? { title } : {}),
                    ...(body !== undefined ? { body } : {}),
                  }),
                );
              if (ready !== undefined)
                await gh(
                  [
                    "pr",
                    "ready",
                    String(prNumber),
                    "--repo",
                    ws.ghRepo,
                    ...(ready ? [] : ["--undo"]),
                  ],
                  credential,
                );
            },
          );
          return text(`Updated PR #${prNumber} as @${ctx.login}.`);
        } catch (error) {
          return failure(
            `Could not edit PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),

    tool(
      "propose_merge",
      `Hand a merge to @${ctx.login}. You cannot merge: no token in your reach can update the default branch. This checks the PR is open and reports its checks and review state, then posts a notice in the session; the person merges with one tap in the PR panel. Call it when asked to merge, or when the work is ready and reviewed.`,
      {
        repo: repoArg,
        method: z
          .enum(["squash", "merge", "rebase"])
          .optional()
          .describe("Suggested merge method (default squash)."),
        note: z
          .string()
          .optional()
          .describe("One line on why it is ready, shown in the notice."),
      },
      async ({ repo, method, note }) => {
        const r = resolve(repo);
        if ("error" in r) return failure(r.error);
        const { ws, credential } = r;
        const meta = await ctx
          .prMeta(ws.branch, ws.ghRepo, credential)
          .catch(() => null);
        if (!meta)
          return failure(
            `No pull request for ${ws.branch}. Open one with open_pull_request first.`,
          );
        if (meta.state !== "OPEN")
          return failure(
            `PR #${meta.number} is ${meta.state.toLowerCase()}, not open.`,
          );
        if (meta.isDraft)
          return failure(
            `PR #${meta.number} is a draft. Mark it ready with edit_pull_request first.`,
          );
        const details = await ctx
          .prDetails(ws.branch, ws.ghRepo)
          .catch(() => null);
        const checks = checksSummary(details);
        const review = details?.reviewDecision
          ? details.reviewDecision.toLowerCase().replace(/_/g, " ")
          : "no review decision";
        const line =
          `Merge proposed for PR #${meta.number}${details?.title ? ` "${details.title}"` : ""} (${meta.url}), ` +
          `${method || "squash"}. ${checks}; ${review}.` +
          (note ? ` ${note}` : "") +
          ` Merge from the PR panel.`;
        await ctx.notice(
          line,
          `merge-proposal:${ws.ghRepo}#${meta.number}@${meta.headRefOid.slice(0, 7)}`,
        );
        return text(
          `Proposed. Nothing merges until @${ctx.login} taps Merge in the PR panel; do not try to merge from the shell. State: ${checks}; ${review}.`,
        );
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-pull-requests",
    version: "1.0.0",
    tools,
  });
}
