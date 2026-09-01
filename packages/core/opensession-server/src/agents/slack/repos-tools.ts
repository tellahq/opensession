/**
 * opensession-repos — an in-process MCP server that lets a session attach secondary
 * repos for cross-repo work. Attaching creates (or reuses) an *isolated git
 * worktree* for that repo and records it on the session, so the agent branches,
 * commits, and opens PRs there independently of the primary repo — instead of
 * editing another repo's shared main checkout (which is parked on whatever branch
 * was last used and collides with other sessions). Also lets a fresh session
 * switch its primary repo when it was created against the wrong one (same
 * clean-only switchPrimaryRepo the RepoBar UI uses).
 *
 * Wired the same way as opensession-sessions/opensession-admin: interactive runs only
 * (Open Session web sessions + Slack), never automations. The handlers run in the
 * parent process and call back into opensession.ts's attachRepo via the injected
 * context, so the session file and live state update immediately.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import type { AttachedRepo, LinkedPr } from "../../server/types";

export interface ReposToolContext {
  /** The session these tools act on. */
  sessionId: string;
  /** Attach (or re-attach) a repo; throws with a human message on bad input. */
  attach: (
    repo: string,
    branch?: string,
  ) => Promise<{ attached: AttachedRepo; all: AttachedRepo[] }>;
  /**
   * Switch the session's PRIMARY repo (wrong repo picked at creation).
   * Clean-only — throws if the session already has work.
   */
  switchPrimary: (
    repo: string,
  ) => Promise<{ repo: string; branch: string; worktreeDir: string }>;
  /** Current repo layout for the session, or null if it can't be resolved. */
  snapshot: () => {
    primaryRepo: string;
    branch: string | null;
    worktreeDir: string | null;
    attached: AttachedRepo[];
  } | null;
  /** All registered repos (id + default branch + whether shared-checkout). */
  repos: () => Array<{
    id: string;
    defaultBranch: string;
    sharedCheckout: boolean;
  }>;
  /**
   * Link a PR to the session (shows up in its Review tab beside the
   * branch-derived PRs); throws with a human message on bad input.
   */
  linkPr: (input: {
    url?: string;
    repo?: string;
    number?: number;
    branch?: string;
  }) => Promise<{ linked: LinkedPr; all: LinkedPr[] }>;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createReposMcpServer(ctx: ReposToolContext) {
  const tools = [
    tool(
      "list_repos",
      "List the repos available to this session: which one is primary, which are already attached (with their worktree paths and branches), and which other repos you could attach. Use before attach_repo to see what's possible.",
      {},
      async () => {
        const snap = ctx.snapshot();
        const repos = ctx.repos();
        const lines: string[] = [];
        if (snap) {
          lines.push(
            `Primary: ${snap.primaryRepo}${snap.branch ? ` (branch ${snap.branch})` : ""} → ${snap.worktreeDir}`,
          );
          if (snap.attached.length) {
            lines.push("Attached:");
            for (const r of snap.attached)
              lines.push(`  • ${r.repo} (branch ${r.branch}) → ${r.dir}`);
          } else {
            lines.push("Attached: none yet");
          }
        }
        const attachable = repos.filter(
          (p) => !p.sharedCheckout && p.id !== snap?.primaryRepo,
        );
        lines.push("");
        lines.push(
          "Attachable repos: " + attachable.map((p) => p.id).join(", "),
        );
        lines.push(
          "Wrong primary repo? Use switch_repo (fresh sessions only).",
        );
        return text(lines.join("\n"));
      },
    ),
    tool(
      "attach_repo",
      "Attach a secondary repo to this session so you can work in it cross-repo. Creates (or reuses) an ISOLATED git worktree for that repo and returns its path — work there, then commit/push and open a PR in that repo independently. Prefer this over cd-ing into a repo's main checkout. Branch defaults to this session's branch.",
      {
        repo: z
          .string()
          .describe("Registered repo id to attach. See list_repos."),
        branch: z
          .string()
          .optional()
          .describe(
            "Branch to check out in the worktree. Defaults to this session's primary branch.",
          ),
      },
      async (args: { repo: string; branch?: string }) => {
        try {
          const { attached, all } = await ctx.attach(args.repo, args.branch);
          const others = all.filter((r) => r.repo !== attached.repo);
          return text(
            `Attached ${attached.repo} on branch ${attached.branch}.\n` +
              `Worktree: ${attached.dir}\n` +
              `cd there to work in it; commit/push and open a PR in this repo independently of the primary repo.` +
              (others.length
                ? `\n(Also attached: ${others.map((r) => r.repo).join(", ")}.)`
                : ""),
          );
        } catch (e: any) {
          return text(
            `Couldn't attach ${args.repo}: ${e?.message || String(e)}`,
          );
        }
      },
    ),
    tool(
      "switch_repo",
      "Switch this session's PRIMARY repo when it was created against the wrong registered repository. Only works while the session is fresh (no uncommitted changes, no commits beyond base), so no work is ever stranded; if you've already done work, attach_repo instead. On success, cd into the returned worktree immediately — your current cwd still points at the old repo for the rest of this turn.",
      {
        repo: z
          .string()
          .describe("Registered repo id to switch to. See list_repos."),
      },
      async (args: { repo: string }) => {
        try {
          const res = await ctx.switchPrimary(args.repo);
          return text(
            `Switched primary repo to ${res.repo} (branch ${res.branch}).\n` +
              `Worktree: ${res.worktreeDir}\n` +
              `cd there now — your current working directory still points at the old repo until the next turn.`,
          );
        } catch (e: any) {
          return text(
            `Couldn't switch to ${args.repo}: ${e?.message || String(e)}`,
          );
        }
      },
    ),
    tool(
      "link_pr",
      "Link a pull request to this session so it shows in the session's Review tab beside the branch-derived PRs. Use when you open a follow-up PR on a different branch, or when a related PR (yours or someone else's) belongs with this session's work. PRs you open on this session's own branch (or an attached repo's branch) are shown automatically — don't link those.",
      {
        url: z
          .string()
          .optional()
          .describe(
            "GitHub PR URL (https://github.com/owner/repo/pull/123). Easiest — repo and number are parsed from it.",
          ),
        repo: z
          .string()
          .optional()
          .describe("Registered repo id when not passing a URL."),
        number: z.number().optional().describe("PR number in that repo."),
        branch: z
          .string()
          .optional()
          .describe("PR head branch, as an alternative to the number."),
      },
      async (args: {
        url?: string;
        repo?: string;
        number?: number;
        branch?: string;
      }) => {
        try {
          const { linked, all } = await ctx.linkPr(args);
          const label = linked.number
            ? `#${linked.number}`
            : `branch ${linked.branch}`;
          return text(
            `Linked ${linked.repo} ${label}${linked.title ? ` (“${linked.title}”)` : ""} to this session.` +
              (all.length > 1
                ? `\nLinked PRs now: ${all.map((r) => `${r.repo}${r.number ? `#${r.number}` : `:${r.branch}`}`).join(", ")}.`
                : ""),
          );
        } catch (e: any) {
          return text(`Couldn't link that PR: ${e?.message || String(e)}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-repos",
    version: "1.0.0",
    tools,
  });
}
