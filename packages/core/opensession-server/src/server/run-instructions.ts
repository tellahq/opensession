// Engine-neutral run instructions — the policy/context text EVERY engine
// delivers with a session run, whatever the transport: the pi runner
// appends it via an instructions file (Pi's system-prompt append
// channel), the pi runner via systemPromptOverride. Run-policy text that
// every engine must carry belongs here, not in an engine-specific prompt.
//
// Extracted from pi-runner.ts (where it was born as
// buildPiInstructions) once the pi engine started sharing it.

import { join } from "path";
import { configuredServer, personaName } from "./config";
import { githubLoginFor, type GitIdentity } from "./shared/user-mappings";

const UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

/** Private-key-backed PR-checks reader used by the bash allowlist. */
export const GH_CHECKS_CLI_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "gh-checks.ts",
);

/** Minimal per-run context appended to the engine system prompt. */
export function buildRunInstructions(input: {
  isAsk: boolean;
  /** Repo-less scratch session (feed-item workspaces — the feeds design). */
  isScratch?: boolean;
  /** No repo behind this run's cwd: a scratch dir, or a repo-less ask
   *  session. Decides which Ask-mode briefing the run gets. */
  isRepoLess?: boolean;
  reposNote?: string;
  /** Reviewer to request on PRs this run opens (GitHub login, `org/team`
   *  slug, or comma-separated list) — see RunAgentOpts.prReviewer. */
  prReviewer?: string;
  inProcessMcp?: Record<string, unknown>;
  osSessionId?: string;
  /** Requester attribution for PRs: the turn's raw user label and the resolved
   *  git identity (same table as commit attribution). PRs open under the bot
   *  GitHub account, so the body line + assignee are how the human shows up. */
  user?: string;
  author?: GitIdentity | null;
  /** Backing git host of the session's primary repo; undefined = GitHub.
   *  "codestorage" swaps the PR-flow instructions for push-the-branch ones
   *  (code.storage has no PRs — a pushed branch is the change request). */
  repoHost?: "github" | "codestorage";
  /** Set when this run carries the owner's own GitHub token (github-auth.ts):
   *  PRs are authored by them directly, so skip the bot-attribution assignee. */
  githubUserLogin?: string | null;
  /** Untracked instance-local instructions (readLocalInstructions) — appended
   *  verbatim so operator-private guidance never has to live in the tracked
   *  AGENTS.md. */
  localInstructions?: string;
  /** The Dial: tells a dial-preset run about its oracle subagent. Only set for
   *  dial runs — other sessions never learn the oracle agents exist. */
  dialOracle?: {
    agent: string;
    presetLabel: string;
    mainLabel: string;
    oracleLabel: string;
    /** Pi exposes the advisor as a custom tool rather than an Pi task agent. */
    tool?: boolean;
  };
  /** The Orchestrator: tells an orchestrator-preset run about its worker
   *  subagents. Only set for orchestrator runs — mirrors dialOracle. */
  orchestrator?: {
    presetLabel: string;
    mainLabel: string;
    workers: Array<{ agent: string; label: string; modelLabel: string }>;
    /** Pi delegates through the sessions MCP instead of Pi task agents. */
    tool?: "task" | "sessions";
  };
}): string {
  const parts: string[] = [];
  parts.push(
    "## Data handling\nNever upload files or data to public hosts. Use " +
      "organization-controlled channels only.",
  );
  parts.push(
    "## Finish your turns\nComplete promised actions, then briefly report the outcome and " +
      "relevant links.",
  );
  parts.push(
    "## References\nFor PRs outside the current primary repository, write " +
      "`<repo>#<number>`, never bare `#<number>`.",
  );

  if (input.isScratch) {
    parts.push(
      `You are ${personaName()} in Scratch mode. This is not a repository; do not commit, ` +
        "push, or open a PR.",
    );
  } else if (input.isAsk) {
    parts.push(
      input.isRepoLess
        ? `You are ${personaName()} in read-only Ask mode with no repository.`
        : `You are ${personaName()} in read-only Ask mode for the current checkout.`,
    );
  }

  if (input.dialOracle) {
    const d = input.dialOracle;
    const access = d.tool
      ? `the \`${d.agent}\` tool`
      : `the \`${d.agent}\` task agent`;
    parts.push(
      `## Oracle\nThe "${d.presetLabel}" preset pairs ${d.mainLabel} with ${d.oracleLabel} via ` +
        `${access}. Use it for difficult planning, architecture, debugging, or review, not routine work.`,
    );
  }

  if (input.orchestrator) {
    const o = input.orchestrator;
    const workers = o.workers
      .map((w) => `\`${w.agent}\` (${w.modelLabel})`)
      .join(", ");
    parts.push(
      `## Workers\nThe "${o.presetLabel}" preset gives ${o.mainLabel} these workers: ` +
        `${workers}. Delegate clear independent tasks, then verify their work.`,
    );
  }

  if (input.reposNote) parts.push(input.reposNote);

  if (
    !input.isAsk &&
    !input.isScratch &&
    input.osSessionId &&
    input.repoHost === "codestorage"
  ) {
    parts.push(
      "## Code Storage\nCommit and push the branch; a pushed branch is the change request. " +
        "Do not merge it or use `gh pr create`.",
    );
  } else if (!input.isAsk && !input.isScratch && input.osSessionId) {
    const link = `${UI_BASE}/session/${input.osSessionId}`;
    const requester = input.author?.name || null;
    const login = githubLoginFor(input.user || input.author?.name);
    const footer = requester
      ? `Started by ${requester} in [this ${personaName()} session](${link})`
      : `Created by [this ${personaName()} session](${link})`;
    parts.push(
      "## PR attribution\nEnd each PR body with:\n\n" +
        `${footer}\n` +
        (input.githubUserLogin
          ? `PRs use @${input.githubUserLogin}'s account; do not add an assignee.`
          : requester && login
            ? `When possible, assign @${login}.`
            : ""),
    );
    if (input.prReviewer) {
      parts.push(
        `For a PR this unattended automation creates, request \`${input.prReviewer}\` as reviewer. Never add this automatic reviewer to an existing PR or a human-steered PR. If the request fails, mention it in the final response.`,
      );
    }
  }

  const inproc = (input.inProcessMcp || {}) as Record<string, unknown>;
  if (inproc["opensession-sessions"]) {
    parts.push(
      "## New sessions\nA request for a new session means `create_session`, not an " +
        "in-process worker.",
    );
  }
  if (!input.isAsk && inproc["opensession-portals"]) {
    parts.push(
      "## Preview links\nFor user-facing web changes, set the exact root-relative route, " +
        "query included. For editors, call `tella-stage` `lease_editor_fixture` with " +
        "fixture `multi_clip_transcript_v1` and this Open Session id as `leaseKey`. Pass only " +
        "its `leaseId` to `opensession-portals` `set_editor_preview_path`; Open Session " +
        "verifies the lease directly with Tella. Never construct a video id or report evidence " +
        "yourself. Otherwise call `set_portal_path` without a name. Open the staging URL and " +
        "verify the changed feature.",
    );
  }

  parts.push(
    "## Media\nShow selected results with `OPENSESSION_IMAGE: /abs/path.png` or " +
      "`OPENSESSION_VIDEO: /abs/path.mp4`.",
  );
  // Instance-local operator instructions last: they're the deployment's own
  // additions and may refine anything above.
  if (input.localInstructions?.trim())
    parts.push(input.localInstructions.trim());
  return parts.join("\n\n");
}
