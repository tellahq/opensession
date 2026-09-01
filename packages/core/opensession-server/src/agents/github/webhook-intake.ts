/**
 * GitHub's webhook intake route. GithubAgent owns this handler; Slack registers
 * it only as a compatibility fallback when the GitHub agent is disabled.
 */
import { configuredIntegration, isGithubBotLogin } from "../../server/config";
import { isTrustedGithubLogin } from "../../server/shared/user-mappings";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import { verifyGitHubSignature } from "../../server/shared/signature";
import {
  claimGithubDelivery,
  incrementGithubWebhooks,
  markGithubDeliveryProcessed,
  releaseGithubDelivery,
} from "./webhook-deliveries";
import { handleGithubPrEvent } from "./webhook";

const GITHUB_WEBHOOK_BODY_LIMIT = 1024 * 1024;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

function integrationEnabled(
  id: "github" | "slack",
  flag: "ENABLE_GITHUB_AGENT" | "ENABLE_SLACK_AGENT",
): boolean {
  const env = process.env[flag];
  return env == null
    ? configuredIntegration(id).enabled === true
    : env === "true";
}

/** Whether Slack must register the GitHub route for legacy Slack-only setups. */
export function githubWebhookCompatibilityFallbackEnabled(): boolean {
  return !integrationEnabled("github", "ENABLE_GITHUB_AGENT");
}

function slackAgentEnabled(): boolean {
  return integrationEnabled("slack", "ENABLE_SLACK_AGENT");
}

/** The shared route handler used by GitHub and Slack compatibility registration. */
export async function handleGithubWebhook(req: Request): Promise<Response> {
  let body: string;
  try {
    body = await readRequestTextWithinLimit(req, GITHUB_WEBHOOK_BODY_LIMIT);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return webhookBodyTooLargeResponse(GITHUB_WEBHOOK_BODY_LIMIT);
    }
    throw error;
  }
  const signature = req.headers.get("x-hub-signature-256") || "";
  if (!verifyGitHubSignature(body, signature, GITHUB_WEBHOOK_SECRET)) {
    console.error("[github] Invalid GitHub webhook signature");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") || "";
  const deliveryId = req.headers.get("x-github-delivery");
  const deliveryClaim = deliveryId
    ? claimGithubDelivery(deliveryId)
    : "claimed";
  if (deliveryClaim === "processed") {
    console.log(`[github] Duplicate GitHub delivery ${deliveryId} - skipping`);
    return Response.json({ ok: true, duplicate: true });
  }
  if (deliveryClaim === "in_flight") {
    return Response.json(
      { error: "Webhook admission in progress" },
      { status: 503 },
    );
  }

  try {
    const payload = JSON.parse(body);
    incrementGithubWebhooks();
    console.log(
      `[github] GitHub webhook: event=${event}, action=${payload.action}`,
    );

    // Slack remains optional: don't load any Slack module in GitHub-only mode.
    if (event === "pull_request_review" && slackAgentEnabled()) {
      const reviewerLogin: string =
        payload?.review?.user?.login || payload?.sender?.login || "";
      if (
        isGithubBotLogin(reviewerLogin) ||
        isTrustedGithubLogin(reviewerLogin)
      ) {
        Promise.all([
          import("../slack/github-reviews"),
          import("../slack/worktree-channels"),
        ])
          .then(([reviews, channels]) =>
            reviews.handlePullRequestReview(payload, channels.branchToChannel),
          )
          .catch((e) =>
            console.error("[github] Error handling PR review webhook:", e),
          );
      } else {
        console.warn(
          `[github] Ignoring PR review notification from untrusted @${reviewerLogin || "unknown"}`,
        );
      }
    }

    // Sync PR caches for every delivery; the cache handler filters events itself.
    import("../../server/pr-webhook")
      .then((m) => m.handlePrWebhookEvent(event, payload))
      .catch((e) => console.error("[github] pr-webhook dispatch failed:", e));

    if (
      event === "pull_request" ||
      event === "issue_comment" ||
      event === "pull_request_review_comment" ||
      event === "workflow_run"
    ) {
      // Long-running work starts in the background, but durable admission must
      // finish before both the delivery receipt and HTTP success are committed.
      await handleGithubPrEvent(event, payload);
    }
    if (deliveryId) markGithubDeliveryProcessed(deliveryId);
    return Response.json({ ok: true });
  } catch (error) {
    if (deliveryId) releaseGithubDelivery(deliveryId);
    console.error("[github] durable webhook admission failed:", error);
    return Response.json(
      { error: "Webhook admission failed" },
      { status: 503 },
    );
  }
}
