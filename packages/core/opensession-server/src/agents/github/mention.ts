/**
 * @mention replies. When someone mentions the bot in a PR comment — inline
 * (pull_request_review_comment) or in the conversation (issue_comment) — route it
 * to the PR's mention session and post the reply in-thread.
 *
 * Loop-safe: we skip any comment carrying one of our hidden markers (our own
 * posts), and only act when the body actually mentions a configured handle — so
 * the bot's replies (which don't mention itself) never re-trigger.
 */
import {
  getPrAutomationDetails,
  type PrAutomationDetails,
} from "../../server/pr-info";
import { defaultRepo } from "../../server/config";
import { isExternalPullRequest } from "./public-review";
import { listAutomations } from "../../server/automations";
import {
  createWorktreeForPrBranch,
  createWorktreeForFollowup,
} from "../../server/worktree";
import {
  claimLock,
  releaseLock,
  readPrState,
  updatePrState,
  setPendingMention,
  clearPendingMention,
} from "./state";
import {
  announceGithubRun,
  runGithubAgent,
  authorForLogin,
  finalSummary,
  sessionUrl,
} from "./run";
import { buildMentionPrompt, buildFollowupMentionPrompt } from "./prompts";
import { triggerPrAction } from "./trigger";
import { repoForFullName } from "./constants";
import {
  postIssueComment,
  editIssueComment,
  postOrEditComment,
  replyToReviewComment,
  BOT_LOGIN,
  REPLY_MARKER,
  OWN_MARKERS,
} from "./github-rest";
import { PR_EVENT_KEY } from "./constants";
import { classifyPrActionIntent } from "../slack/mention-intent";
import {
  configuredIntegration,
  isGithubBotLogin,
  personaName,
} from "../../server/config";
import { isTrustedGithubLogin } from "../../server/shared/user-mappings";

export function githubMentionHandles(input: {
  persona: string;
  appSlug?: string;
  botLogin?: string;
  configured?: unknown;
  environment?: string;
}): string[] {
  return [
    input.persona.toLowerCase().replace(/[^a-z0-9-]/g, ""),
    input.appSlug || "",
    (input.botLogin || "").replace(/\[bot\]$/i, ""),
    ...(Array.isArray(input.configured)
      ? input.configured.filter(
          (value): value is string => typeof value === "string",
        )
      : []),
    ...(input.environment || "").split(","),
  ]
    .map((handle) =>
      handle
        .trim()
        .replace(/^@/, "")
        .replace(/\[bot\]$/i, "")
        .toLowerCase(),
    )
    .filter(
      (handle, index, handles) => !!handle && handles.indexOf(handle) === index,
    );
}

const githubIntegration = configuredIntegration("github");
const configuredAppSlug =
  process.env.OPENSESSION_GITHUB_APP_SLUG?.trim() ||
  (typeof githubIntegration.appSlug === "string"
    ? githubIntegration.appSlug.trim()
    : "");
const MENTION_HANDLES = githubMentionHandles({
  persona: personaName(),
  appSlug: configuredAppSlug,
  botLogin: BOT_LOGIN,
  configured: githubIntegration.mentionHandles,
  environment: process.env.GITHUB_MENTION_HANDLES,
});
const MENTION_RE = new RegExp(
  `@(${MENTION_HANDLES.map((handle) => handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

function mentionsAgent(body: string): boolean {
  if (!body) return false;
  if (OWN_MARKERS.some((m) => body.includes(m))) return false; // our own content
  return MENTION_RE.test(body);
}

// Bounded in-memory dedup against webhook redelivery.
const handled = new Set<string>();
function alreadyHandled(key: string): boolean {
  if (handled.has(key)) return true;
  handled.add(key);
  // Evict oldest-first (Sets iterate in insertion order) — a wholesale clear()
  // would forget the most recent keys and re-handle a prompt redelivery.
  while (handled.size > 500) {
    const oldest = handled.values().next().value;
    if (oldest === undefined) break;
    handled.delete(oldest);
  }
  return false;
}

export type MentionKind = "issue" | "review";

export async function handleMention(
  kind: MentionKind,
  payload: any,
): Promise<void> {
  if (payload?.action !== "created") return; // ignore edits/deletes
  const comment = payload.comment;
  const body: string = comment?.body || "";
  if (!mentionsAgent(body)) return;

  const authorLogin: string = comment?.user?.login || "";
  if (isGithubBotLogin(authorLogin)) return; // the bot's own pushes' account
  if (!isTrustedGithubLogin(authorLogin)) {
    console.warn(
      `[github] Ignoring PR mention from untrusted @${authorLogin || "unknown"}`,
    );
    return;
  }

  // Multi-repo: resolve which configured repo this comment belongs to; events
  // for unconfigured repos are dropped (mirrors the webhook gate).
  const eventRepo = payload?.repository?.full_name
    ? repoForFullName(payload.repository.full_name)
    : null;
  if (payload?.repository?.full_name && !eventRepo) return;
  const ghRepo: string | undefined = eventRepo?.ghRepo;

  let prNumber: number | undefined;
  let inline: { path: string; line?: number; diffHunk?: string } | undefined;
  let replyToId: number | undefined;

  if (kind === "review") {
    prNumber = payload.pull_request?.number;
    inline = {
      path: comment?.path,
      line: comment?.line ?? comment?.original_line,
      diffHunk: comment?.diff_hunk,
    };
    // Reply at the thread root so GitHub threads it correctly.
    replyToId = comment?.in_reply_to_id || comment?.id;
  } else {
    if (!payload.issue?.pull_request) return; // a plain issue, not a PR
    prNumber = payload.issue?.number;
  }
  if (!prNumber || !comment?.id) return;
  if (alreadyHandled(`${kind}:${comment.id}`)) return;

  // Persist the mention on receipt, BEFORE the slow classify + worktree window. If
  // the process dies in that window — e.g. this webhook landed mid-shutdown-drain,
  // which we still ack 200 so GitHub won't redeliver — startup recovery replays it.
  // The run self-persists its richer activeMention/activeRun only seconds later.
  setPendingMention(
    prNumber,
    {
      kind,
      commentId: comment.id,
      body,
      author: authorLogin,
      replyToId,
      inline,
      receivedAt: new Date().toISOString(),
    },
    ghRepo,
  );
  // Acknowledge through REST before any metadata/model work. The durable marker
  // remains queued if dispatch fails, and this comment is reused on retry.
  const receiptId = await postIssueComment(
    prNumber,
    `${REPLY_MARKER}
Queued @${authorLogin}'s request. I'll retry automatically if GitHub metadata is temporarily unavailable.`,
    ghRepo,
  ).catch(() => null);
  if (receiptId) {
    const pending = readPrState(prNumber, ghRepo)?.pendingMention;
    if (pending && pending.commentId === comment.id) {
      setPendingMention(
        prNumber,
        { ...pending, progressCommentId: receiptId },
        ghRepo,
      );
    }
  }
  try {
    await dispatchMention({
      prNumber,
      kind,
      body,
      author: authorLogin,
      replyToId,
      inline,
      ghRepo,
    });
    const stillPending = readPrState(prNumber, ghRepo)?.pendingMention;
    if (receiptId && stillPending?.commentId === comment.id) {
      await editIssueComment(
        receiptId,
        `${REPLY_MARKER}
Request accepted.`,
        ghRepo,
      ).catch(() => {});
    }
    clearPendingMention(prNumber, ghRepo);
  } catch (error) {
    if (receiptId)
      await editIssueComment(
        receiptId,
        `${REPLY_MARKER}
Queued @${authorLogin}'s request. GitHub metadata is temporarily unavailable, so I'll retry automatically.`,
        ghRepo,
      ).catch(() => {});
    throw error;
  }
}

/**
 * Classify the mention and route it: a whole-PR action (review/simplify/etc.) or a
 * conversational reply. Shared by the live webhook path (handleMention) and startup
 * recovery of a mention that was dropped before its run could self-persist.
 */
export async function dispatchMention(args: {
  prNumber: number;
  kind: MentionKind;
  body: string;
  author: string;
  replyToId?: number;
  inline?: { path: string; line?: number; diffHunk?: string };
  ghRepo?: string;
}): Promise<void> {
  const { prNumber, kind, body, author, replyToId, inline, ghRepo } = args;
  // Startup recovery enters here without a fresh webhook. Re-check the persisted
  // login so an old public comment cannot become trusted after a restart.
  if (!isTrustedGithubLogin(author)) {
    console.warn(
      `[github] Ignoring recovered PR mention on #${prNumber} from untrusted @${author || "unknown"}`,
    );
    return;
  }

  // A whole-PR action request ("@<bot> adversarial review plz") → run the dedicated
  // behavior. Classified before any lock, since triggerPrAction claims the "code" lock.
  const action = await classifyPrActionIntent(body);
  if (action !== "none") {
    // Pass the full comment as steer: the classifier reduced it to a verb, but the
    // body may carry specific guidance ("…the Update.call change wasn't needed.
    // /simplify") that the run should honor — not just a generic pass.
    const res = await triggerPrAction(action, prNumber, author, body, ghRepo);
    const ack = `${REPLY_MARKER}\nOn it — ${res.message}`;
    if (kind === "review" && replyToId)
      await replyToReviewComment(prNumber, replyToId, ack, ghRepo).catch(
        () => {},
      );
    else await postIssueComment(prNumber, ack, ghRepo).catch(() => {});
    return;
  }

  // Otherwise it's a conversational request — answer (and act) in a worktree session.
  await runConversationalMention({
    prNumber,
    author,
    body,
    kind,
    replyToId,
    inline,
    ghRepo,
  });
}

export interface ConversationalMentionArgs {
  prNumber: number;
  author: string;
  body: string;
  kind: MentionKind;
  replyToId?: number;
  inline?: { path: string; line?: number; diffHunk?: string };
  ghRepo?: string;
}

/** Run (or, on restart recovery, re-run) a conversational @mention in a PR-branch worktree. */
export async function runConversationalMention(
  args: ConversationalMentionArgs,
  recovering = false,
): Promise<void> {
  const { prNumber, ghRepo } = args;
  if (!isTrustedGithubLogin(args.author)) {
    console.warn(
      `[github] Ignoring conversational mention on #${prNumber} from untrusted @${args.author || "unknown"}`,
    );
    return;
  }
  if (!claimLock("code", prNumber, ghRepo)) {
    console.log(
      `[github] a code action is already running for PR #${prNumber}, skipping mention`,
    );
    return;
  }
  let headRef = "";
  let runOwnsRecovery = false;
  try {
    const details = await getPrAutomationDetails(
      String(prNumber),
      ghRepo || undefined,
    );
    if (!details) return;
    if (isExternalPullRequest(details, ghRepo || defaultRepo().ghRepo)) {
      const message = `${REPLY_MARKER}\nExternal PRs are read-only. I can run an isolated review, but I can't execute requests or push changes from this fork.`;
      if (args.kind === "review" && args.replyToId)
        await replyToReviewComment(
          prNumber,
          args.replyToId,
          message,
          ghRepo,
        ).catch(() => {});
      else await postIssueComment(prNumber, message, ghRepo).catch(() => {});
      return;
    }
    // Merged/closed PR: you can't push to it, but a mention like "fix this in a
    // follow-up PR" (Kent's case) should still spin up a session — off a fresh
    // branch that opens its own PR — not be silently dropped.
    if (details.state !== "OPEN") {
      await runFollowupMention(args, details);
      return;
    }
    headRef = details.headRefName;
    const model = listAutomations().find(
      (a) => a.eventKey === PR_EVENT_KEY,
    )?.model;
    const link = `[📺 open session](${sessionUrl(prNumber, "mention", ghRepo)})`;
    const title = `Mention · PR #${prNumber} ${details.title}`.slice(0, 100);
    await announceGithubRun({
      prNumber,
      ghRepo,
      kind: "mention",
      branch: headRef,
      title,
      mode: "code",
    });

    const prior = readPrState(prNumber, ghRepo);
    // Reuse the progress comment only when recovering an interrupted run.
    const reuseId = recovering
      ? prior?.activeMention?.progressCommentId
      : undefined;
    const pendingReceiptId = readPrState(prNumber, ghRepo)?.pendingMention
      ?.progressCommentId;
    const progressId = await postOrEditComment(
      prNumber,
      reuseId ?? pendingReceiptId,
      `${REPLY_MARKER}\n🔄 On it — working on @${args.author}'s request… · ${link}`,
      ghRepo,
    );
    updatePrState(
      prNumber,
      headRef,
      (s) => {
        s.activeMention = {
          author: args.author,
          body: args.body,
          kind: args.kind,
          replyToId: args.replyToId,
          inline: args.inline,
          progressCommentId: progressId ?? undefined,
          startedAt: new Date().toISOString(),
        };
        // This run now owns recovery via activeMention; drop the on-receipt marker
        // in the same write so recovery never replays it twice.
        s.pendingMention = undefined;
      },
      ghRepo,
    );

    runOwnsRecovery = true;

    // Code mode in the PR-branch worktree so the agent can make + push changes if asked.
    const worktreeDir = await createWorktreeForPrBranch(
      headRef,
      ghRepo ? repoForFullName(ghRepo)?.id : undefined,
    );
    console.log(
      `[github] Mention reply on PR #${prNumber} (${args.kind}) from @${args.author}`,
    );
    const result = await runGithubAgent({
      prNumber,
      ghRepo,
      kind: "mention",
      prompt: buildMentionPrompt({
        prNumber,
        prTitle: details.title,
        headRef,
        author: args.author,
        commentBody: args.body,
        inline: args.inline,
      }),
      cwd: worktreeDir,
      mode: "code",
      model,
      branch: headRef,
      title,
      resume: true, // keep a conversation across mentions on the same PR
      author: authorForLogin(args.author), // attribute any commits to the person who asked
    });

    const reply = finalSummary(result.text) || "(no reply produced)";
    const out = `${REPLY_MARKER}\n${reply}\n\n<sub>${link}</sub>`;
    if (args.kind === "review" && args.replyToId) {
      // Answer in the inline thread; the progress comment becomes a pointer to it.
      const ok = await replyToReviewComment(
        prNumber,
        args.replyToId,
        out,
        ghRepo,
      );
      if (!ok)
        console.warn(
          `[github] failed to post mention thread reply for PR #${prNumber}`,
        );
      if (progressId)
        await editIssueComment(
          progressId,
          `${REPLY_MARKER}\n✓ Replied in the review thread above. · ${link}`,
          ghRepo,
        );
    } else {
      // Conversation reply: turn the progress comment into the answer.
      if (progressId) {
        if (!(await editIssueComment(progressId, out, ghRepo)))
          await postIssueComment(prNumber, out, ghRepo);
      } else {
        await postIssueComment(prNumber, out, ghRepo);
      }
    }
  } catch (e) {
    console.error(`[github] mention reply error for PR #${prNumber}:`, e);
    // Before activeMention takes ownership, leave pendingMention durable and
    // tell the receipt path to retry. Once owned, existing recovery semantics apply.
    if (!runOwnsRecovery) throw e;
  } finally {
    // Clear recovery state on completion; a killed process leaves it set so the
    // github agent re-runs the mention on startup.
    updatePrState(
      prNumber,
      headRef || `pr-${prNumber}`,
      (s) => {
        s.activeMention = undefined;
      },
      ghRepo,
    );
    releaseLock("code", prNumber, ghRepo);
  }
}

/**
 * Handle a mention on a merged/closed PR: the head branch can't take new commits,
 * so branch fresh off the PR's base and let the run open its own follow-up PR.
 * Called from within `runConversationalMention`, which already holds the code lock.
 */
async function runFollowupMention(
  args: ConversationalMentionArgs,
  details: PrAutomationDetails,
): Promise<void> {
  const { prNumber, ghRepo } = args;
  const baseRef = details.baseRefName || "main";
  const stateLabel = details.state === "MERGED" ? "merged" : "closed";
  // Stable per-thread branch suffix (replyToId is the thread root) so a webhook
  // redelivery replays onto the same branch instead of forking a second one.
  const suffix = args.replyToId ? String(args.replyToId) : String(prNumber);
  const branch = `followup-pr-${prNumber}-${suffix}`.slice(0, 80);
  const link = `[📺 open session](${sessionUrl(prNumber, "followup", ghRepo)})`;
  const followupTitle = `Follow-up · PR #${prNumber} ${details.title}`.slice(
    0,
    100,
  );
  await announceGithubRun({
    prNumber,
    ghRepo,
    kind: "followup",
    branch,
    title: followupTitle,
    mode: "code",
  });

  const progressId = await postOrEditComment(
    prNumber,
    undefined,
    `${REPLY_MARKER}\n🔄 On it — PR #${prNumber} is ${stateLabel}, so I'm starting a fresh follow-up branch off \`${baseRef}\` for @${args.author}'s request… · ${link}`,
    ghRepo,
  );

  const model = listAutomations().find(
    (a) => a.eventKey === PR_EVENT_KEY,
  )?.model;
  const worktreeDir = await createWorktreeForFollowup(
    branch,
    baseRef,
    ghRepo ? repoForFullName(ghRepo)?.id : undefined,
  );
  console.log(
    `[github] Follow-up mention on ${stateLabel} PR #${prNumber} from @${args.author} → branch ${branch}`,
  );

  const result = await runGithubAgent({
    prNumber,
    ghRepo,
    kind: "followup",
    prompt: buildFollowupMentionPrompt({
      prNumber,
      ghRepo,
      prTitle: details.title,
      state: stateLabel,
      baseRef,
      branch,
      author: args.author,
      commentBody: args.body,
      inline: args.inline,
    }),
    cwd: worktreeDir,
    mode: "code",
    model,
    branch,
    title: followupTitle,
    resume: false, // fresh branch → fresh session, don't resume the merged PR's thread
    author: authorForLogin(args.author), // attribute commits to the person who asked
  });

  const reply = finalSummary(result.text) || "(no reply produced)";
  const out = `${REPLY_MARKER}\n${reply}\n\n<sub>${link}</sub>`;
  if (args.kind === "review" && args.replyToId) {
    const ok = await replyToReviewComment(
      prNumber,
      args.replyToId,
      out,
      ghRepo,
    );
    if (!ok)
      console.warn(
        `[github] failed to post follow-up thread reply for PR #${prNumber}`,
      );
    if (progressId)
      await editIssueComment(
        progressId,
        `${REPLY_MARKER}\n✓ Replied in the review thread above. · ${link}`,
        ghRepo,
      );
  } else if (progressId) {
    if (!(await editIssueComment(progressId, out, ghRepo)))
      await postIssueComment(prNumber, out, ghRepo);
  } else {
    await postIssueComment(prNumber, out, ghRepo);
  }
}
