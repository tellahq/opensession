/**
 * GitHub PR review handler for the Slack agent.
 *
 * When a PR review is submitted on a branch that has a worktree channel,
 * posts a Block Kit message with inline comments and an "Address this feedback"
 * button that enqueues a Claude session to fix the review feedback.
 */

import { BOT_LOGIN } from "../github/github-rest";
import {
  GITHUB_TO_SLACK,
  githubUsernameToSlackId,
} from "../../server/shared/user-mappings";
import { sendSlackMessage, postSlackBlocks } from "./slack-api";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import { GITHUB_REPO } from "./state";
import { ghRateLimited, noteGhRateLimited } from "../../server/github-limit";
import { configuredIntegration } from "../../server/config";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

export async function githubApi(path: string): Promise<any> {
  const { githubRepoFromApiPath, githubToken } =
    await import("../../server/github-app");
  // A /repos/{owner}/{name} path mints against that owner's installation.
  const repo = githubRepoFromApiPath(path);
  const token = await githubToken(repo ? { repo } : {});
  if (!token) return null;
  try {
    const resp = await fetchWithTimeout(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!resp.ok) {
      console.warn(`[slack] GitHub API ${path}: ${resp.status}`);
      if (
        (resp.status === 403 || resp.status === 429) &&
        resp.headers.get("x-ratelimit-remaining") === "0"
      ) {
        const resetHeader = resp.headers.get("x-ratelimit-reset");
        if (resetHeader)
          noteGhRateLimited("slack-github", Number(resetHeader) * 1000, "rest");
        else noteGhRateLimited("slack-github", undefined, "rest");
      }
      return null;
    }
    return resp.json();
  } catch (e) {
    console.warn(`[slack] GitHub API error for ${path}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Poll for Vercel preview URL after PR creation
// ---------------------------------------------------------------------------

export async function pollForVercelPreview(
  prNumber: number,
  channel: string,
  threadTs?: string,
): Promise<void> {
  const maxAttempts = 30; // 5 minutes (10s intervals)
  const interval = 10_000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (ghRateLimited("rest")) return; // best-effort nicety — abandon rather than burn the backoff window
    try {
      // Get the PR's head commit SHA
      const pr = await githubApi(`/repos/${GITHUB_REPO}/pulls/${prNumber}`);
      if (!pr?.head?.sha) continue;

      // Find deployment for this commit
      const configuredEnvironment =
        configuredIntegration("github").previewEnvironment;
      const previewEnvironment =
        typeof configuredEnvironment === "string"
          ? configuredEnvironment
          : "Preview";
      const deployments = await githubApi(
        `/repos/${GITHUB_REPO}/deployments?ref=${pr.head.sha}&environment=${encodeURIComponent(previewEnvironment)}&per_page=1`,
      );
      if (!deployments?.[0]?.id) continue;

      // Get deployment status
      const statuses = await githubApi(
        `/repos/${GITHUB_REPO}/deployments/${deployments[0].id}/statuses`,
      );
      const latest = statuses?.[0];
      if (latest?.state === "success" && latest?.environment_url) {
        await sendSlackMessage(
          channel,
          `Preview ready: ${latest.environment_url}`,
          threadTs,
        );
        console.log(
          `[slack] [vercel] Preview ready for PR #${prNumber}: ${latest.environment_url}`,
        );
        return;
      }
      if (latest?.state === "failure" || latest?.state === "error") {
        console.log(`[slack] [vercel] Deployment failed for PR #${prNumber}`);
        return;
      }
    } catch (e) {
      console.warn(`[slack] [vercel] Poll error for PR #${prNumber}:`, e);
    }
  }
  console.log(
    `[slack] [vercel] Timed out waiting for preview for PR #${prNumber}`,
  );
}

// ---------------------------------------------------------------------------
// Find GitHub users relevant to a branch
// ---------------------------------------------------------------------------

export async function findGitHubUsersForBranch(
  branch: string,
): Promise<string[]> {
  const users = new Set<string>();

  // Find PRs where this branch is the head
  const prs = await githubApi(
    `/repos/${GITHUB_REPO}/pulls?head=${GITHUB_REPO.split("/")[0]}:${branch}&state=all&per_page=1`,
  );
  if (prs && prs.length > 0) {
    const pr = prs[0];
    if (pr.user?.login) users.add(pr.user.login);
    for (const a of pr.assignees || []) {
      if (a.login) users.add(a.login);
    }
    for (const r of pr.requested_reviewers || []) {
      if (r.login) users.add(r.login);
    }
    // Fetch submitted reviews
    const reviews = await githubApi(
      `/repos/${GITHUB_REPO}/pulls/${pr.number}/reviews`,
    );
    if (reviews) {
      for (const r of reviews) {
        if (r.user?.login) users.add(r.user.login);
      }
    }
  }

  // Also check recent commits on the branch for committers
  const commits = await githubApi(
    `/repos/${GITHUB_REPO}/commits?sha=${encodeURIComponent(branch)}&per_page=5`,
  );
  if (commits) {
    for (const c of commits) {
      if (c.author?.login) users.add(c.author.login);
    }
  }

  // Filter out bots
  const filtered = [...users].filter(
    (u) => !u.endsWith("[bot]") && !u.includes("bot") && u !== "web-flow",
  );
  console.log(
    `[slack] GitHub users for branch ${branch}: ${filtered.join(", ") || "(none)"}`,
  );
  return filtered;
}

// ---------------------------------------------------------------------------
// Invite relevant GitHub users to a Slack channel
// ---------------------------------------------------------------------------

export async function inviteRelevantUsersToChannel(
  channelId: string,
  branch: string,
): Promise<void> {
  const ghUsers = await findGitHubUsersForBranch(branch);
  if (ghUsers.length === 0) return;

  const slackUserIds: string[] = [];
  for (const ghUser of ghUsers) {
    const slackId = githubUsernameToSlackId(ghUser);
    if (slackId) slackUserIds.push(slackId);
  }

  if (slackUserIds.length === 0) {
    console.log(`[slack] No Slack users to invite for branch ${branch}`);
    return;
  }

  // Invite all users at once
  console.log(
    `[slack] Inviting ${slackUserIds.length} user(s) to channel ${channelId}: ${slackUserIds.join(", ")}`,
  );
  const resp = await fetchWithTimeout(
    "https://slack.com/api/conversations.invite",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: channelId,
        users: slackUserIds.join(","),
      }),
    },
  );
  const data = (await resp.json()) as any;
  if (!data.ok && data.error !== "already_in_channel") {
    console.warn(`[slack] conversations.invite error: ${data.error}`);
  }
}

// ---------------------------------------------------------------------------
// Handle pull_request_review webhook
// ---------------------------------------------------------------------------

export async function handlePullRequestReview(
  payload: any,
  branchToChannel: Map<string, string>,
): Promise<void> {
  if (payload.action !== "submitted") return;

  const review = payload.review;
  const pr = payload.pull_request;
  if (!review || !pr) return;

  // Ignore reviews from our own bot account
  const reviewerLogin = review.user?.login;
  if (reviewerLogin === BOT_LOGIN) {
    console.log(`[slack] Ignoring PR review from ${BOT_LOGIN} (self)`);
    return;
  }

  const branch = pr.head?.ref;
  if (!branch) return;

  const channelId = branchToChannel.get(branch);
  if (!channelId) {
    console.log(
      `[slack] PR review on branch ${branch} \u2014 no worktree channel, ignoring`,
    );
    return;
  }

  const reviewerName = review.user?.login || "unknown";
  const reviewState: string = review.state; // "approved", "changes_requested", "commented"
  const reviewBody: string = (review.body || "").trim();
  const prNumber = pr.number;
  const prUrl = pr.html_url;
  const prTitle = pr.title;
  const reviewUrl = review.html_url;

  console.log(
    `[slack] PR review on branch ${branch}: ${reviewState} by ${reviewerName} (PR #${prNumber})`,
  );

  // Fetch inline review comments via GitHub API
  let inlineComments: Array<{
    path: string;
    line: number | null;
    body: string;
  }> = [];
  try {
    const commentsData = await githubApi(
      `/repos/${payload.repository.full_name}/pulls/${prNumber}/reviews/${review.id}/comments`,
    );
    if (commentsData && Array.isArray(commentsData)) {
      for (const c of commentsData) {
        inlineComments.push({ path: c.path, line: c.line, body: c.body });
      }
    }
  } catch (e) {
    console.warn("[slack] Failed to fetch inline review comments:", e);
  }

  // Build emoji based on review state
  let stateEmoji = "\ud83d\udcac";
  let stateLabel = "commented on";
  if (reviewState === "approved") {
    stateEmoji = "\u2705";
    stateLabel = "approved";
  } else if (reviewState === "changes_requested") {
    stateEmoji = "\ud83d\udd04";
    stateLabel = "requested changes on";
  }

  // Build Block Kit message
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${stateEmoji} PR Review: ${reviewerName} ${stateLabel} #${prNumber}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${prUrl}|${prTitle}>*\nReviewer: *${reviewerName}* | <${reviewUrl}|View review>`,
      },
    },
  ];

  // Add review body if present
  if (reviewBody) {
    const truncatedBody =
      reviewBody.length > 1500
        ? reviewBody.substring(0, 1500) + "..."
        : reviewBody;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Review comment:*\n>${truncatedBody.replace(/\n/g, "\n>")}`,
      },
    });
  }

  // Add inline comments summary
  if (inlineComments.length > 0) {
    const commentSummary = inlineComments
      .slice(0, 10) // limit to 10 to stay within block limits
      .map((c) => {
        const loc = c.line ? `:${c.line}` : "";
        const body =
          c.body.length > 150 ? c.body.substring(0, 150) + "..." : c.body;
        return `\u2022 \`${c.path}${loc}\`: ${body}`;
      })
      .join("\n");

    let text = `*Inline comments (${inlineComments.length}):*\n${commentSummary}`;
    if (inlineComments.length > 10) {
      text += `\n_...and ${inlineComments.length - 10} more_`;
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
  }

  // Add action buttons for changes_requested or commented-with-body
  const hasActionableContent =
    reviewState === "changes_requested" ||
    (reviewState === "commented" && (reviewBody || inlineComments.length > 0));

  if (hasActionableContent) {
    // Build the value payload — must be under 2000 chars for Slack
    const buttonValue = JSON.stringify({
      branch,
      channelId,
      prNumber,
      prUrl,
      reviewerName,
      reviewState,
      reviewBody: reviewBody.substring(0, 500),
      inlineCommentCount: inlineComments.length,
    }).substring(0, 2000);

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Address this feedback",
            emoji: true,
          },
          style: "primary",
          action_id: `gh-review-address-${prNumber}-${review.id}`,
          value: buttonValue,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss", emoji: true },
          action_id: `gh-review-dismiss-${prNumber}-${review.id}`,
          value: buttonValue,
        },
      ],
    });
  }

  const fallback = `${stateEmoji} ${reviewerName} ${stateLabel} PR #${prNumber}: ${prTitle}`;
  await postSlackBlocks(channelId, fallback, blocks);
}
