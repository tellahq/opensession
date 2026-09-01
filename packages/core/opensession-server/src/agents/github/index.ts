/**
 * GitHub PR agent: automated review + auto-fix + simplify for the configured repos.
 *
 * Owns the signature-verified GitHub webhook route (`POST /github/webhook`) and
 * its PR behaviors. Slack review notifications are an optional side effect when
 * the Slack agent is enabled.
 */
import {
  configuredIntegration,
  defaultRepo,
  personaName,
} from "../../server/config";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import type { AgentModule } from "../types";
import {
  listAutomations,
  createAutomation,
  saveAutomation,
} from "../../server/automations";
import { githubConfigured } from "./github-rest";
import {
  githubAppCredentialHealth,
  githubToken,
} from "../../server/github-app";
import {
  PR_EVENT_KEY,
  REVIEW_AUTOMATION_NAME,
  PR_MERGED_EVENT_KEY,
  DOCS_SYNC_AUTOMATION_NAME,
} from "./constants";
import { DEFAULT_REVIEW_PROMPT } from "./prompts";
import { DEFAULT_GITHUB_FLOW_MCP_SERVERS } from "./run";
import {
  setGithubSessionInvalidate,
  resolveReviewConfig,
  restoreDesiredReviews,
} from "./webhook";
import { githubWebhookCount, loadGithubDeliveries } from "./webhook-deliveries";
import { handleGithubWebhook } from "./webhook-intake";
import {
  listPrStates,
  activeCodeLoops,
  clearPendingMention,
  clearRecoveryMarker,
  planRecovery,
  recoveryMarkerAt,
  readPrState,
  type GithubPrState,
  type RecoveryKind,
} from "./state";
import { feedbackStats } from "./feedback";
import type { PrRef } from "./review";
import {
  isTrustedGithubLogin,
  isTrustedUser,
} from "../../server/shared/user-mappings";
import { getPrAutomationDetails } from "../../server/pr-info";
import { isExternalPullRequest } from "./public-review";

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

/** Seed the review automation (disabled) if it doesn't exist yet. Keyed on eventKey. */
function ensureReviewAutomation(): void {
  const existing = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY);
  if (existing) {
    // One-time backfill: this record predates PR flows reading `mcpServers`
    // (githubFlowMcpServers in run.ts). Leaving it unset changes no behavior —
    // unset already resolves to the same default — but the Automations UI
    // renders unset as "all connectors", which would now be a lie. Write the
    // effective list so the settings screen matches what the runs actually get.
    if (existing.mcpServers === undefined) {
      saveAutomation({
        ...existing,
        mcpServers: [...DEFAULT_GITHUB_FLOW_MCP_SERVERS],
      });
      console.log(
        `[github] Backfilled review automation MCP allowlist: ${DEFAULT_GITHUB_FLOW_MCP_SERVERS.join(", ")}`,
      );
    }
    return;
  }
  const created = createAutomation({
    name: REVIEW_AUTOMATION_NAME,
    prompt: DEFAULT_REVIEW_PROMPT,
    schedule: "",
    mode: "ask",
    createdBy: `${personaName()} (github agent)`,
    eventKey: PR_EVENT_KEY,
    mcpServers: [...DEFAULT_GITHUB_FLOW_MCP_SERVERS],
  });
  if ("error" in created) {
    console.error(`[github] Failed to seed review automation:`, created.error);
    return;
  }
  // Seed it OFF — start label-only; flip on in the Automations UI to review every non-draft PR.
  saveAutomation({ ...created, enabled: false });
  console.log(
    `[github] Seeded review automation "${REVIEW_AUTOMATION_NAME}" (disabled)`,
  );
}

/**
 * Seed the docs-sync automation if it doesn't exist yet. Keyed on eventKey.
 * Code mode: each merged PR runs a headless session in a fresh worktree that
 * updates the Mintlify docs and opens a PR. Seeded ENABLED — this is the live
 * replacement for the old Mintlify-hosted docs-sync workflow. Toggle it in the
 * Automations UI.
 */
function ensureDocsSyncAutomation(): void {
  const prompt = configuredIntegration("github").docsSyncPrompt;
  if (typeof prompt !== "string" || !prompt.trim()) return;
  const existing = listAutomations().find(
    (a) => a.eventKey === PR_MERGED_EVENT_KEY,
  );
  if (existing) return;
  const created = createAutomation({
    name: DOCS_SYNC_AUTOMATION_NAME,
    prompt: prompt.trim(),
    schedule: "",
    mode: "code",
    repo: defaultRepo().id,
    createdBy: `${personaName()} (github agent)`,
    eventKey: PR_MERGED_EVENT_KEY,
  });
  if ("error" in created) {
    console.error(
      `[github] Failed to seed docs-sync automation:`,
      created.error,
    );
    return;
  }
  console.log(
    `[github] Seeded docs-sync automation "${DOCS_SYNC_AUTOMATION_NAME}" (enabled)`,
  );
}

/** Who armed a recovery marker. Empty/undefined means nobody did — see below. */
function recoveryRequester(
  s: GithubPrState,
  kind: RecoveryKind,
): string | undefined {
  switch (kind) {
    case "auto-fix":
      return s.autoFix?.requestedBy;
    case "pending-auto-fix":
      return s.pendingAutoFix?.requestedBy;
    case "run":
      return s.activeRun?.requestedBy;
    case "mention":
      return s.activeMention?.author;
    case "pending-mention":
      return s.pendingMention?.author;
  }
}

/**
 * May this marker's run be resumed on boot? The gate exists so an untrusted
 * PERSON cannot get a run replayed for them across a restart.
 *
 * Webhook- and reconcile-triggered reviews have no human requester by design
 * (review.ts arms `requestedBy: ""`), so an empty requester on a review means
 * "automation", not "untrusted person". Reading it as untrusted refused every
 * automated review that spanned a restart and, worse, cleared the marker
 * carrying that run's durable `reviewResult` — stranding a finished, paid-for
 * review as a permanently spinning "🔄 Reviewing…" comment (PR #99, 2026-08-25).
 *
 * Only reviews get this exemption: simplify and adversarial always record their
 * triggering human, and auto-fix/mentions are inherently person-initiated, so a
 * missing requester there really is a marker that should not be replayed.
 */
export function recoveryPermitted(
  s: GithubPrState,
  kind: RecoveryKind,
): boolean {
  const requester = recoveryRequester(s, kind);
  if (kind === "mention" || kind === "pending-mention")
    return isTrustedGithubLogin(requester);
  if (kind === "run" && s.activeRun?.kind === "review" && !requester)
    return true;
  return isTrustedUser(requester);
}

/** Fire the one recovery `planRecovery` picked for this PR. */
async function fireRecovery(
  s: GithubPrState,
  kind: RecoveryKind,
): Promise<void> {
  if (!recoveryPermitted(s, kind)) {
    console.warn(
      `[github] Refusing ${kind} recovery for PR #${s.prNumber} from untrusted @${recoveryRequester(s, kind) || "unknown"}`,
    );
    clearRecoveryMarker(s, kind);
    return;
  }

  switch (kind) {
    case "auto-fix": {
      console.log(
        `[github] Recovering interrupted auto-fix loop for PR #${s.prNumber}`,
      );
      const { runAutoFix } = await import("./autofix");
      const ref: PrRef = {
        number: s.prNumber,
        headRef: s.headRef,
        headSha: "",
        title: `PR #${s.prNumber}`,
        ...(s.ghRepo ? { ghRepo: s.ghRepo } : {}),
      };
      void runAutoFix(
        ref,
        s.autoFix?.requestedBy || "",
        undefined,
        /*resuming*/ true,
        s.autoFix?.steer,
      ).catch((e) =>
        console.error(
          `[github] auto-fix recovery failed for PR #${s.prNumber}:`,
          e,
        ),
      );
      return;
    }
    case "pending-auto-fix": {
      const pending = s.pendingAutoFix!;
      console.log(
        `[github] Recovering dropped auto-fix request for PR #${s.prNumber} (from @${pending.requestedBy})`,
      );
      const { runAutoFix } = await import("./autofix");
      const ref: PrRef = {
        number: s.prNumber,
        headRef: s.headRef,
        headSha: "",
        title: `PR #${s.prNumber}`,
        ...(s.ghRepo ? { ghRepo: s.ghRepo } : {}),
      };
      void runAutoFix(ref, pending.requestedBy).catch((e) =>
        console.error(
          `[github] dropped auto-fix recovery failed for PR #${s.prNumber}:`,
          e,
        ),
      );
      return;
    }
    case "run": {
      const run = s.activeRun!;
      console.log(
        `[github] Recovering interrupted ${run.kind} for PR #${s.prNumber}`,
      );
      const { triggerPrAction } = await import("./trigger");
      void triggerPrAction(
        run.kind,
        s.prNumber,
        run.requestedBy,
        run.steer,
        s.ghRepo,
      ).catch((e) =>
        console.error(
          `[github] ${run.kind} recovery failed for PR #${s.prNumber}:`,
          e,
        ),
      );
      return;
    }
    case "mention": {
      const m = s.activeMention!;
      console.log(
        `[github] Recovering interrupted mention for PR #${s.prNumber}`,
      );
      const { runConversationalMention } = await import("./mention");
      void runConversationalMention(
        {
          prNumber: s.prNumber,
          author: m.author,
          body: m.body,
          kind: m.kind,
          replyToId: m.replyToId,
          inline: m.inline,
          ghRepo: s.ghRepo,
        },
        /*recovering*/ true,
      ).catch((e) =>
        console.error(
          `[github] mention recovery failed for PR #${s.prNumber}:`,
          e,
        ),
      );
      return;
    }
    case "pending-mention": {
      const p = s.pendingMention!;
      console.log(
        `[github] Recovering dropped mention for PR #${s.prNumber} (from @${p.author})`,
      );
      const { dispatchMention } = await import("./mention");
      void dispatchMention({
        prNumber: s.prNumber,
        kind: p.kind,
        body: p.body,
        author: p.author,
        replyToId: p.replyToId,
        inline: p.inline,
        ghRepo: s.ghRepo,
      })
        .then(() => clearPendingMention(s.prNumber, s.ghRepo))
        .catch((e) =>
          console.error(
            `[github] dropped-mention recovery remains queued for PR #${s.prNumber}:`,
            e,
          ),
        );
      return;
    }
  }
}

/**
 * Re-enter the work a restart interrupted: auto-fix loops, label requests that
 * were received before a run could self-persist, one-shot actions
 * (review/simplify/adversarial), conversational @mentions, and mentions dropped
 * in the same receipt-to-run window. The classic case is a webhook that landed
 * during shutdown drain (acked 200, so GitHub won't redeliver).
 *
 * ONE pass over the state files, at most one run fired per PR. These markers
 * legitimately coexist — auto-fix arms `autoFix.active` and its gate review arms
 * `activeRun` — so per-marker sweeps used to fire two runs for the same PR after
 * every restart. planRecovery picks the outermost live marker; the nested ones
 * belong to runs the resumed one starts again itself.
 */
async function retryPendingMentions(): Promise<void> {
  const { ghRateLimited } = await import("../../server/github-limit");
  if (ghRateLimited("rest")) return;
  for (const s of listPrStates()) {
    if (!s.pendingMention || s.activeMention || s.activeRun) continue;
    const p = s.pendingMention;
    if (!isTrustedGithubLogin(p.author)) {
      clearPendingMention(s.prNumber, s.ghRepo);
      continue;
    }
    const { dispatchMention } = await import("./mention");
    await dispatchMention({
      prNumber: s.prNumber,
      kind: p.kind,
      body: p.body,
      author: p.author,
      replyToId: p.replyToId,
      inline: p.inline,
      ghRepo: s.ghRepo,
    }).then(
      async () => {
        const stillPending = readPrState(s.prNumber, s.ghRepo)?.pendingMention;
        if (stillPending?.progressCommentId) {
          const { editIssueComment, REPLY_MARKER } =
            await import("./github-rest");
          await editIssueComment(
            stillPending.progressCommentId,
            `${REPLY_MARKER}
Request accepted.`,
            s.ghRepo,
          ).catch(() => {});
        }
        clearPendingMention(s.prNumber, s.ghRepo);
      },
      (error) =>
        console.warn(
          `[github] pending mention remains queued for PR #${s.prNumber}:`,
          error,
        ),
    );
  }
}

function startPendingMentionRetry(): void {
  const g = globalThis as any;
  if (g.__githubPendingMentionRetryTimer) return;
  const timer = setInterval(() => void retryPendingMentions(), 60_000);
  timer.unref?.();
  g.__githubPendingMentionRetryTimer = timer;
}

async function recoverInterrupted(): Promise<void> {
  for (const s of listPrStates()) {
    const { fire, stale } = planRecovery(s);
    for (const kind of stale) {
      const label = kind === "run" ? s.activeRun?.kind || "run" : kind;
      console.log(
        `[github] Clearing stale ${label} recovery flag for PR #${s.prNumber} (from ${recoveryMarkerAt(s, kind) || "unknown"})`,
      );
      clearRecoveryMarker(s, kind);
    }
    if (!fire) continue;
    // The fired run owns the PR; its mention receipt is bookkeeping it supersedes.
    if (fire !== "pending-mention" && s.pendingMention)
      clearPendingMention(s.prNumber, s.ghRepo);
    await fireRecovery(s, fire);
  }
}

export class GithubAgent implements AgentModule {
  name = "github";
  private readonly onSessionInvalidate?: () => void;

  constructor(opts?: { onSessionInvalidate?: () => void }) {
    this.onSessionInvalidate = opts?.onSessionInvalidate;
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    routes.set("POST /github/webhook", handleGithubWebhook);

    // Manual trigger for testing: POST /github-pr/<secret> { prNumber, headRef, headSha?, behavior, requestedBy? }
    routes.set("POST /github-pr/*", async (req, url) => {
      const m = url.pathname.match(/^\/github-pr\/([^/]+)$/);
      if (!m || !GITHUB_WEBHOOK_SECRET || m[1] !== GITHUB_WEBHOOK_SECRET) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      let body: any = {};
      try {
        body = JSON.parse(await readRequestTextWithinLimit(req, 64 * 1024));
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return webhookBodyTooLargeResponse(64 * 1024);
      }
      const prNumber = Number(body?.prNumber);
      const headRef = String(body?.headRef || "").trim();
      const behavior = String(body?.behavior || "review");
      if (!prNumber || !headRef)
        return Response.json(
          { error: "prNumber and headRef required" },
          { status: 400 },
        );
      const manualGhRepo =
        typeof body?.ghRepo === "string" && body.ghRepo.trim()
          ? body.ghRepo.trim()
          : undefined;
      const ref: PrRef = {
        number: prNumber,
        headRef,
        headSha: String(body?.headSha || ""),
        title: `PR #${prNumber}`,
        ...(manualGhRepo ? { ghRepo: manualGhRepo } : {}),
      };
      const requestedBy = String(body?.requestedBy || "");
      const details = await getPrAutomationDetails(
        String(prNumber),
        manualGhRepo,
      );
      const external = details
        ? isExternalPullRequest(details, manualGhRepo || defaultRepo().ghRepo)
        : false;
      if (external && behavior !== "review") {
        return Response.json(
          { error: "External PRs support isolated review only" },
          { status: 403 },
        );
      }

      if (behavior === "autofix") {
        const { runAutoFix } = await import("./autofix");
        void runAutoFix(ref, requestedBy, this.onSessionInvalidate);
      } else if (behavior === "simplify") {
        const { runSimplify } = await import("./simplify");
        void runSimplify(ref, requestedBy, this.onSessionInvalidate);
      } else {
        const { runReview } = await import("./review");
        void runReview(
          ref,
          resolveReviewConfig().config,
          this.onSessionInvalidate,
        );
      }
      return Response.json({ ok: true, behavior, prNumber });
    });

    // GitHub normally owns this shared route. Slack registers the same handler
    // only when this independently gated agent is disabled.
    routes.set("POST /github/webhook", handleGithubWebhook);

    return routes;
  }

  async startup(): Promise<void> {
    // Eagerly restore webhook replay protection. The webhook server binds
    // earlier in boot, so the delivery read/write paths also restore the store
    // lazily on first touch; this keeps it warm when no delivery arrives. A
    // GitHub-only install has no Slack startup to warm it, so this agent loads
    // the store itself.
    loadGithubDeliveries();
    if (!githubConfigured()) {
      console.warn(
        "[github] GitHub App identity is incomplete — review/fix/simplify can't post; agent idle",
      );
    } else if (!(await githubToken())) {
      console.warn(
        "[github] GitHub App installation token is unavailable — review/fix/simplify can't post; agent idle",
      );
    }
    if (!GITHUB_WEBHOOK_SECRET) {
      console.warn(
        "[github] GITHUB_WEBHOOK_SECRET unset — PR webhooks won't be verified",
      );
    }
    loadGithubDeliveries();
    if (this.onSessionInvalidate)
      setGithubSessionInvalidate(this.onSessionInvalidate);
    ensureReviewAutomation();
    ensureDocsSyncAutomation();
    await recoverInterrupted();
    restoreDesiredReviews(listPrStates());
    startPendingMentionRetry();
    // Safety net under all of the above: the webhook path is fire-once, so
    // reviews that die on dry pools or whose delivery never arrives are
    // re-fired by the sweep. Accepted debounce work recovers from PR state.
    const { startReconcileSweep } = await import("./reconcile");
    startReconcileSweep();
    // Cross-PR learning: periodically re-distill the per-repo learned review
    // rules from the feedback store's outcome signals.
    const { armLearnedRulesDistiller } = await import("./learned-rules");
    armLearnedRulesDistiller();
    const { autoEnabled } = resolveReviewConfig();
    console.log(
      `[github] Agent started — review automation ${autoEnabled ? "ENABLED (all non-draft PRs)" : "disabled (label-only)"}`,
    );
  }

  async shutdown(): Promise<void> {
    // Auto-fix loop state is persisted to disk after each iteration; nothing to flush.
  }

  health(): Record<string, unknown> {
    const { autoEnabled } = resolveReviewConfig();
    return {
      status: githubAppCredentialHealth(),
      githubCredentialMode: "app",
      githubCredentialConfigured: githubConfigured(),
      reviewAutomationEnabled: autoEnabled,
      trackedPrs: listPrStates().length,
      activeCodeLoops: activeCodeLoops(),
      reviewFeedback: feedbackStats(),
      webhookConfigured: !!GITHUB_WEBHOOK_SECRET,
      webhooksReceived: githubWebhookCount(),
    };
  }
}
