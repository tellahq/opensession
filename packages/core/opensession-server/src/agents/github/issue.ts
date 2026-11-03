/**
 * Plain-issue sessions. The `os` label on an issue, or an @mention in one of
 * its comments, starts (or resumes) ONE code session per issue on a branch cut
 * from the repo's default branch. The session answers, or implements and opens
 * its own PR, then reports back on the issue.
 *
 * GitHub numbers PRs and issues from the same sequence, so an issue reuses the
 * per-number PR state file, code lock and deterministic session id under its
 * own number. `issue: true` on the persisted mention markers tells restart
 * recovery to come back here instead of the PR mention path.
 */
import { listAutomations } from "../../server/automations";
import { defaultRepo } from "../../server/config";
import { isTrustedGithubLogin } from "../../server/shared/user-mappings";
import { createWorktreeForFollowup } from "../../server/worktree";
import {
  LABEL_ISSUE,
  PR_EVENT_KEY,
  labelMatches,
  repoForFullName,
} from "./constants";
import {
  REPLY_MARKER,
  editIssueComment,
  getIssue,
  postIssueComment,
  postOrEditComment,
} from "./github-rest";
import { buildIssuePrompt } from "./prompts";
import {
  announceGithubRun,
  authorForLogin,
  finalSummary,
  runGithubAgent,
  sessionUrl,
} from "./run";
import {
  claimLock,
  clearPendingMention,
  readPrState,
  releaseLock,
  setPendingMention,
  updatePrState,
} from "./state";

/** The branch an issue's session works on; stable so re-triggers resume it. */
export function issueBranch(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/**
 * Pure gate for an `issues` webhook. Only a trusted person adding the `os`
 * label to a plain issue starts a session; PR labels arrive as
 * `pull_request` events and are handled there.
 */
export function issueLabelCommand(input: {
  action: string;
  labelName: string;
  isPullRequest: boolean;
  senderIsBot: boolean;
  senderIsTrusted: boolean;
}): "start" | "untrusted" | "ignore" {
  if (input.action !== "labeled") return "ignore";
  if (input.isPullRequest) return "ignore";
  if (!labelMatches(input.labelName, LABEL_ISSUE)) return "ignore";
  if (input.senderIsBot) return "ignore";
  if (!input.senderIsTrusted) return "untrusted";
  return "start";
}

export interface IssueRunArgs {
  issueNumber: number;
  /** The person who labeled the issue or wrote the mention. */
  author: string;
  /** The mention comment; empty when the `os` label started the session. */
  body: string;
  ghRepo?: string;
}

/**
 * `os` label applied. Persists the request before the webhook acks (a shutdown
 * between the ack and the run's own marker is replayed by startup recovery),
 * then runs in the background.
 */
export async function handleIssueLabel(payload: any): Promise<void> {
  const issueNumber: number | undefined = payload?.issue?.number;
  const author: string = payload?.sender?.login || "";
  if (typeof issueNumber !== "number" || !author) return;
  const eventRepo = payload?.repository?.full_name
    ? repoForFullName(payload.repository.full_name)
    : null;
  if (payload?.repository?.full_name && !eventRepo) return;
  const ghRepo = eventRepo?.ghRepo;
  await setPendingMention(
    issueNumber,
    {
      kind: "issue",
      issue: true,
      commentId: 0,
      body: "",
      author,
      receivedAt: new Date().toISOString(),
    },
    ghRepo,
  );
  console.log(
    `[github] Issue #${issueNumber} labeled \`${LABEL_ISSUE}\` by @${author}`,
  );
  void runIssueSession({ issueNumber, author, body: "", ghRepo })
    .then(() => clearPendingMention(issueNumber, ghRepo))
    .catch((e) =>
      console.error(`[github] issue session failed for #${issueNumber}:`, e),
    );
}

/** Run (or, on restart recovery, re-run) an issue's session and report back on the issue. */
export async function runIssueSession(
  args: IssueRunArgs,
  recovering = false,
): Promise<void> {
  const { issueNumber, ghRepo } = args;
  if (!isTrustedGithubLogin(args.author)) {
    console.warn(
      `[github] Ignoring issue #${issueNumber} request from untrusted @${args.author || "unknown"}`,
    );
    return;
  }
  const link = `[📺 open session](${sessionUrl(issueNumber, "issue", ghRepo)})`;
  if (!claimLock("code", issueNumber, ghRepo)) {
    console.log(
      `[github] issue #${issueNumber} session is already running, skipping request`,
    );
    // Nothing queues behind a running turn: say so instead of silently
    // dropping it, and drop the receipt so recovery does not replay it.
    const receiptId = (await readPrState(issueNumber, ghRepo))?.pendingMention
      ?.progressCommentId;
    await clearPendingMention(issueNumber, ghRepo);
    await postOrEditComment(
      issueNumber,
      receiptId,
      `${REPLY_MARKER}\nStill working on the earlier request for this issue. Mention me again once that finishes. · ${link}`,
      ghRepo,
    ).catch(() => null);
    return;
  }

  const branch = issueBranch(issueNumber);
  let runOwnsRecovery = false;
  try {
    const issue = await getIssue(issueNumber, ghRepo);
    if (!issue) {
      throw new Error(`issue #${issueNumber} metadata unavailable`);
    }
    if (issue.isPullRequest) return; // PR mentions are handled by mention.ts
    const repo = (ghRepo ? repoForFullName(ghRepo) : null) ?? defaultRepo();
    const baseRef = repo.defaultBranch || "main";
    const model = (await listAutomations()).find(
      (a) => a.eventKey === PR_EVENT_KEY,
    )?.model;
    const title = `Issue #${issueNumber} ${issue.title}`.slice(0, 100);
    await announceGithubRun({
      prNumber: issueNumber,
      ghRepo,
      kind: "issue",
      branch,
      title,
      mode: "code",
    });

    const prior = await readPrState(issueNumber, ghRepo);
    // Reuse the progress comment only when recovering an interrupted run.
    const reuseId = recovering
      ? prior?.activeMention?.progressCommentId
      : undefined;
    const pendingReceiptId = prior?.pendingMention?.progressCommentId;
    const doing = args.body
      ? `working on @${args.author}'s request`
      : `picking up this issue for @${args.author}`;
    const progressId = await postOrEditComment(
      issueNumber,
      reuseId ?? pendingReceiptId,
      `${REPLY_MARKER}\n🔄 On it — ${doing}… · ${link}`,
      ghRepo,
    );
    await updatePrState(
      issueNumber,
      branch,
      (s) => {
        s.activeMention = {
          author: args.author,
          body: args.body,
          kind: "issue",
          issue: true,
          progressCommentId: progressId ?? undefined,
          startedAt: new Date().toISOString(),
        };
        // This run now owns recovery; drop the on-receipt marker in the same
        // write so recovery never replays it twice.
        s.pendingMention = undefined;
      },
      ghRepo,
    );
    runOwnsRecovery = true;

    const worktreeDir = await createWorktreeForFollowup(
      branch,
      baseRef,
      repo.id,
    );
    console.log(
      `[github] Issue #${issueNumber} session for @${args.author} on ${branch}`,
    );
    const result = await runGithubAgent({
      prNumber: issueNumber,
      ghRepo,
      kind: "issue",
      prompt: buildIssuePrompt({
        issueNumber,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        author: args.author,
        issueAuthor: issue.author,
        issueAuthorTrusted: isTrustedGithubLogin(issue.author),
        commentBody: args.body || undefined,
        branch,
        baseRef,
        ghRepo,
      }),
      cwd: worktreeDir,
      mode: "code",
      model,
      branch,
      title,
      resume: true, // one conversation per issue across label + mentions
      author: authorForLogin(args.author),
    });

    const reply = finalSummary(result.text) || "(no reply produced)";
    const out = `${REPLY_MARKER}\n${reply}\n\n<sub>${link}</sub>`;
    if (progressId) {
      if (!(await editIssueComment(progressId, out, ghRepo)))
        await postIssueComment(issueNumber, out, ghRepo);
    } else {
      await postIssueComment(issueNumber, out, ghRepo);
    }
  } catch (e) {
    console.error(`[github] issue session error for #${issueNumber}:`, e);
    // Before activeMention takes ownership, leave pendingMention durable so
    // the retry path replays it. Once owned, recovery semantics apply.
    if (!runOwnsRecovery) throw e;
  } finally {
    await updatePrState(
      issueNumber,
      branch,
      (s) => {
        s.activeMention = undefined;
      },
      ghRepo,
    );
    releaseLock("code", issueNumber, ghRepo);
  }
}
