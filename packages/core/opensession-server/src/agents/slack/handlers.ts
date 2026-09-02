/**
 * Core event handlers for the Slack agent.
 *
 * handleMessageEvent  — DM messages
 * handleMentionEvent  — @mention in channels
 * processMessage      — runs a queued message through runAgent (pi engine)
 */

import { copyFileSync, existsSync } from "fs";
import { runCommand } from "../../server/run-command";

import { markdownToSlack } from "../../server/shared/markdown";
import {
  configuredServer,
  defaultRepo,
  personaName,
  productName,
} from "../../server/config";
import { SLACK_SYSTEM_PROMPT_APPEND } from "./prompts";
import {
  sendSlackMessage,
  addReaction,
  removeReaction,
  getUserInfo,
  fetchThreadContext,
  postSlackBlocks,
  updateSlackBlocks,
  openSlackModal,
  slackApiCall,
  getChannelKind,
  slackFileRefs,
  downloadSlackImages,
  MESSAGES,
} from "./slack-api";
import type { SlackFileRef, ThreadContext } from "./slack-api";
import { SlackStreamer, buildToolStatus, isSilentTool } from "./streamer";
import { splitSlackMedia } from "./media";
import { SlackProgress, taskCardTitle } from "./progress";
import { createAdminMcpServer } from "./admin-tools";
import { createGithubMcpServer } from "./github-tools";
import { createSessionsMcpServer } from "./sessions-tools";
import { createHumansMcpServer } from "./humans-tools";
import {
  matchReply as matchHumanAskReply,
  noteAskThreadReply,
} from "../../server/human-asks";
import { triggerPrAction } from "../github/trigger";
import { classifyMention } from "./mention-intent";
import { renderMemoryForPrompt, type MemoryContext } from "./memory";
import { enqueueMessage, getOrCreateQueue, isRestartAbort } from "./queue";
import type { QueuedMessage, SessionQueue } from "./queue";
import { sessionQueues } from "./queue";
import { isStopMessage, cancelSession } from "./cancel";
import { pollForVercelPreview } from "./github-reviews";
import {
  gitIdentityFor,
  githubLoginForTrustedSlackId,
  slackIdToFirstName,
} from "../../server/shared/user-mappings";
import { oneShot } from "../../server/one-shot";
import {
  worktreePathFor,
  getRepo,
  ensureAskCheckout,
  reviveWorktree,
  resolveUniqueBranch,
  sharedCheckoutForNewSessions,
  createWorktree as createRepoWorktree,
} from "../../server/worktree";
import { sessionForThread } from "../../server/slack-links";
import { tryGetSessionControl } from "../../server/session-control";
import { pinForUser } from "../../server/pins";
import { getUiPrefs } from "../../server/ui-prefs";
import { STRIPE_CONFIRM_TOOLS } from "../../server/runner-shared";
import {
  runAgent,
  cancelAgentRun,
  restartContinuationPrompt,
} from "../../server/agent-runner";
import {
  shouldPersistModelSwitch,
  type ImageInput,
} from "../../server/run-events";
import {
  registerSessionMcpServers,
  unregisterSessionMcpServers,
} from "../../server/run-rpc";
import { createAskUserMcpServer, type AskUserHandler } from "./ask-tools";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { ensureGeneratedTitle } from "../../server/generated-titles";
import { invalidateSessionsCache } from "../../server/session-cache";
import {
  getDefaultModel,
  toPiModel,
  interactiveFallbackModel,
  providerFor,
  resolveModel,
  formatModelList,
} from "../../server/models";
import {
  isWorktreeChannel,
  getWorktreeDirForChannel,
  worktreeChannels,
} from "./worktree-channels";
import {
  activeSessions,
  pendingAnswers,
  getSessionKey,
  saveSession,
  loadSession,
  DEFAULT_CWD,
  SESSION_DIR,
  GITHUB_REPO,
  slackBotUserId,
  CANCELLED_ANSWER,
} from "./state";
import type { SlackSession, PendingAnswer } from "./state";

const ALLOWED_USER_ID = process.env.ALLOWED_SLACK_USER_ID;

function pinSlackSession(sessionId: string, slackUserId: string): void {
  const user = slackIdToFirstName(slackUserId);
  // Opt-in, matching the web UI's "Pin new sessions" default.
  if (!user || getUiPrefs(user)["pin-new-sessions"] !== "on") return;
  pinForUser(user, sessionId);
}

async function postOpenSessionCard(
  channel: string,
  threadTs: string,
  sessionId: string,
): Promise<void> {
  const result = await postSlackBlocks(
    channel,
    `Continuing in ${productName()}.`,
    [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: *Continuing session…*",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: `:desktop_computer: Open in ${productName()}`,
              emoji: true,
            },
            url: `${UI_BASE}/session/${encodeURIComponent(sessionId)}`,
            action_id: `opensession:${sessionId}`,
          },
        ],
      },
    ],
    threadTs,
  );
  if (!result?.ok) throw new Error(result?.error || "chat.postMessage failed");
}

async function activateLinkedSession(
  sessionId: string,
  text: string,
  channel: string,
  threadTs: string,
  messageTs: string,
  slackUserId: string,
): Promise<{ status: string; message: string }> {
  const control = tryGetSessionControl();
  if (!control)
    return { status: "error", message: "Session control unavailable." };
  const res = await control.deliverToSession(
    sessionId,
    text,
    slackIdToFirstName(slackUserId) || slackUserId,
    {
      busy: "queue",
      slackReplyTo: { channel, threadTs },
      deliveryId: `slack:${channel}:${messageTs}`,
    },
  );
  if (res.status !== "error") {
    pinSlackSession(sessionId, slackUserId);
    await postOpenSessionCard(channel, threadTs, sessionId).catch((e) =>
      console.warn(
        `[slack] Failed to post linked-session card for ${sessionId}:`,
        e,
      ),
    );
  }
  return res;
}

// Cache admin MCP servers per session to avoid rebuilding identical tool objects
// on every message. Invalidated when memory changes (detected via hash).
const adminMcpServersCache = new Map<
  string,
  { tools: Record<string, any>; memoryHash: string }
>();

// Cache worktree existence checks per worktree dir (30s TTL)
const worktreeExistsCache = new Map<
  string,
  { exists: boolean; expiresAt: number }
>();

// Cache thread context per channel+threadTs (30s TTL)
const threadContextCache = new Map<
  string,
  { context: ThreadContext; expiresAt: number }
>();

// Cached worktree existence check (TTL 30s) — avoids repeated fs.existsSync calls on every message
function cachedWorktreeExists(dir: string): boolean {
  const cached = worktreeExistsCache.get(dir);
  if (cached && cached.expiresAt > Date.now()) return cached.exists;
  const exists = existsSync(dir);
  worktreeExistsCache.set(dir, { exists, expiresAt: Date.now() + 30000 });
  return exists;
}

// Cached thread context (TTL 30s) — avoids refetching the same thread multiple times
async function cachedFetchThreadContext(
  channel: string,
  threadTs: string,
): Promise<ThreadContext> {
  const cacheKey = `${channel}:${threadTs}`;
  const cached = threadContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.context;
  const context = await fetchThreadContext(channel, threadTs);
  threadContextCache.set(cacheKey, { context, expiresAt: Date.now() + 30000 });
  return context;
}

/**
 * Attachments for a queued message: the triggering message's own files first,
 * then any other files seen in the thread context (deduped by id) — so an
 * image posted earlier in the thread also reaches the prompt.
 */
function mergeFileRefs(
  own: SlackFileRef[],
  threadFiles: SlackFileRef[] | undefined,
): SlackFileRef[] | undefined {
  const seen = new Set(own.map((f) => f.id));
  const merged = [
    ...own,
    ...(threadFiles || []).filter((f) => f.id && !seen.has(f.id)),
  ];
  return merged.length ? merged : undefined;
}

// Save the session and mirror claudeSessionId/lastActivity into the
// branch-named session file (written by `wt new-slack`), so opensession can
// dedupe the two into one session as soon as the id exists.
async function persistSession(session: SlackSession): Promise<void> {
  await saveSession(session);
  if (!session.branch) return;
  const branchFile = `${SESSION_DIR}/${session.branch}.json`;
  try {
    const bf = Bun.file(branchFile);
    if (await bf.exists()) {
      const branchData = JSON.parse(await bf.text());
      branchData.claudeSessionId = session.claudeSessionId;
      branchData.lastActivity = session.lastActivity;
      writeJsonAtomic(branchFile, branchData);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

async function branchExists(branch: string): Promise<boolean> {
  try {
    // Check if worktree directory exists
    if (existsSync(worktreePathFor(branch))) return true;
    // Check if branch exists in git (local or registered worktree)
    const gitCheck = await runCommand(
      ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: DEFAULT_CWD },
    );
    return gitCheck.status === 0;
  } catch {
    return false;
  }
}

async function generateBranchName(
  text: string,
  context?: string,
): Promise<string> {
  // The trigger message is often filler ("plz fix") while the real task
  // lives in the thread context — ask a one-shot for a descriptive name
  // from both. The worktree creation this feeds takes minutes, so a few
  // seconds of model call doesn't move the needle.
  let baseName = "";
  const source = [context?.trim(), text.trim()]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2000);
  if (source) {
    const out = await oneShot(
      `Name a git branch for this task: 2-4 words, kebab-case, lowercase letters/digits/hyphens only, max 30 chars, describing the actual task (never filler like "plz-fix" or "try-again"). Output ONLY the branch name, nothing else.\n\nTask:\n"""\n${source}\n"""`,
      { label: "slack-branch-name" },
    );
    if (out) {
      baseName = out
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .slice(0, 30)
        .replace(/^-+|-+$/g, "");
      // A name that still looks like prose (spaces collapsed away entirely,
      // or the model chatted) falls through to the heuristic.
      if (!/^[a-z0-9][a-z0-9-]*$/.test(baseName)) baseName = "";
    }
  }

  if (!baseName) {
    // Heuristic fallback: first 3 words of the message, kebab-cased.
    baseName =
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .slice(0, 3)
        .join("-")
        .slice(0, 30) || "slack-task";
  }

  // Deduplicate: if branch already exists, append a numeric suffix
  if (!(await branchExists(baseName))) return baseName;
  for (let i = 2; i <= 20; i++) {
    const candidate = `${baseName}-${i}`;
    if (!(await branchExists(candidate))) return candidate;
  }
  // Last resort: timestamp suffix
  return `${baseName}-${Date.now().toString(36)}`;
}

async function createWorktree(
  branch: string,
  _userId: string,
  _message: string,
): Promise<string> {
  try {
    const worktreeDir = await createRepoWorktree(branch, defaultRepo().id);
    console.log(`[slack] Created worktree: ${branch}`);
    return worktreeDir;
  } catch (e) {
    console.error(`[slack] Failed to create worktree ${branch}:`, e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// AskUserQuestion via Block Kit
// ---------------------------------------------------------------------------

async function handleAskUserQuestion(
  sessionKey: string,
  input: Record<string, unknown>,
  channel: string,
  threadTs: string,
): Promise<Awaited<ReturnType<AskUserHandler>>> {
  const questions = input.questions as Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;

  if (!questions || questions.length === 0) {
    return { behavior: "allow", updatedInput: input };
  }

  const answers: Record<string, string> = {};

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx]!;
    const questionId = `${Date.now()}-${qIdx}`;

    // Build Block Kit blocks
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: q.header || "Question",
          emoji: true,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: q.question },
      },
    ];

    // Add option descriptions as context
    if (q.options.length > 0) {
      const descriptionLines = q.options
        .map(
          (opt, i) =>
            `*${i + 1}. ${opt.label}*${opt.description ? ` \u2014 ${opt.description}` : ""}`,
        )
        .join("\n");
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: descriptionLines },
      });
    }

    // Action buttons
    const buttons: any[] = q.options.map((opt, optIdx) => ({
      type: "button",
      text: {
        type: "plain_text",
        text: opt.label.substring(0, 75),
        emoji: true,
      },
      action_id: `askq-${questionId}-opt-${optIdx}`,
      value: opt.label,
    }));

    // "Other..." button
    buttons.push({
      type: "button",
      text: { type: "plain_text", text: "Other...", emoji: true },
      action_id: `askq-${questionId}-other`,
      style: "primary",
    });

    blocks.push({
      type: "actions",
      elements: buttons,
    });

    // Post to Slack
    const postResult = await postSlackBlocks(
      channel,
      `Question: ${q.question}`,
      blocks,
      threadTs,
    );
    const blockMsgTs = postResult?.ts || "";

    // Create promise to wait for answer
    const answer = await new Promise<string>((resolve) => {
      const timeoutId = setTimeout(
        () => {
          const pending = pendingAnswers.get(questionId);
          if (pending) {
            pendingAnswers.delete(questionId);
            // Update the message to show it timed out
            updateSlackBlocks(
              channel,
              blockMsgTs,
              `Question timed out: ${q.question}`,
              [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `~${q.question}~\n_Timed out \u2014 skipped_`,
                  },
                },
              ],
            ).catch(() => {});
            // Tell the thread what was skipped and that we're proceeding anyway,
            // so a silent thread doesn't look stuck.
            sendSlackMessage(
              channel,
              `:hourglass_flowing_sand: No answer in 5 min, so I'm skipping *"${q.question}"* and proceeding with my best assumption. Reply anytime if I got it wrong.`,
              threadTs,
            ).catch(() => {});
            resolve("__TIMED_OUT__");
          }
        },
        5 * 60 * 1000,
      ); // 5 minute timeout

      pendingAnswers.set(questionId, {
        resolve,
        messageTs: blockMsgTs,
        channel,
        threadTs,
        sessionKey,
        timeoutId,
        questionText: q.question,
        header: q.header || "Question",
      });
    });

    if (answer === "__TIMED_OUT__") {
      return {
        behavior: "deny",
        message: `Question "${q.question}" timed out after 5 minutes with no response. Proceed with your best assumption, and state clearly in your reply what you assumed for this question so the user can correct it if needed.`,
      };
    }

    if (answer === CANCELLED_ANSWER) {
      // Mark the open modal as cancelled and clean it up visually.
      updateSlackBlocks(channel, blockMsgTs, `Cancelled: ${q.question}`, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `~${q.question}~\n_Cancelled by user_`,
          },
        },
      ]).catch(() => {});
      return {
        behavior: "deny",
        message: "User cancelled the request.",
      };
    }

    answers[q.question] = answer;

    // Update the Block Kit message to show the selected answer
    await updateSlackBlocks(channel, blockMsgTs, `Answered: ${answer}`, [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${q.header || "Question"}*\n${q.question}\n\n*Answer:* ${answer}`,
        },
      },
    ]).catch(() => {});
  }

  return {
    behavior: "allow",
    updatedInput: { ...input, answers },
  };
}

// ---------------------------------------------------------------------------
// /model command — per-session model selection (Claude or Codex models)
// ---------------------------------------------------------------------------

/**
 * Handle "/model" / "/model <name>" in a Slack message. Returns true when the
 * message was consumed as a command (caller should stop processing).
 */
export async function handleModelCommand(
  sessionKey: string,
  text: string,
  channel: string,
  threadTs: string,
): Promise<boolean> {
  if (!/^\/model(\s|$)/i.test(text.trim())) return false;

  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) activeSessions.set(sessionKey, session);
  }

  const arg = text
    .trim()
    .replace(/^\/model\s*/i, "")
    .trim();

  if (!arg || arg === "show" || arg === "list") {
    const current = session?.model || getDefaultModel();
    await sendSlackMessage(
      channel,
      `Current model: \`${current}\`${session?.model ? "" : " (default)"}\n\nAvailable (set with \`/model <name>\`):\n\`\`\`\n${formatModelList(session?.model)}\n\`\`\``,
      threadTs,
    );
    return true;
  }

  const resolved = resolveModel(arg);
  if (!resolved) {
    await sendSlackMessage(
      channel,
      `Unknown model \`${arg}\`. Available:\n\`\`\`\n${formatModelList(session?.model)}\n\`\`\``,
      threadTs,
    );
    return true;
  }

  if (!session) {
    await sendSlackMessage(
      channel,
      `No session in this thread yet — send the task first, then \`/model ${resolved.id}\`. (New sessions start on \`${getDefaultModel()}\`.)`,
      threadTs,
    );
    return true;
  }

  // No busy gate: the switch applies from the next message either way (the
  // model is read at dispatch), and refusing blocked the moment people most
  // want it — right after a run died on a usage limit. See the same removal
  // in src/server/slash-commands.ts for the race this used to stand in for.

  const prevProvider = providerFor(session.model);
  session.model = resolved.id;
  session.lastActivity = new Date().toISOString();
  await saveSession(session);

  let note = "";
  if (prevProvider !== resolved.provider) {
    note =
      " Switching model families starts a fresh engine session (with a transcript handoff when available); the worktree state carries over.";
  }
  await sendSlackMessage(
    channel,
    `Model set to \`${resolved.id}\`. Applies from the next message.${note}`,
    threadTs,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Tool-name normalization + post-push format pass
// ---------------------------------------------------------------------------

/** Pi emits lowercase tool names ("bash", "todowrite"); the streamer
 *  helpers (buildToolStatus / isSilentTool) key on the Claude-style names. */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  patch: "Edit",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  list: "Glob",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  task: "Task",
  skill: "Skill",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  notebookedit: "NotebookEdit",
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name.toLowerCase()] || name;
}

// Formatting hooks are repository policy, not agent code: a repo that wants
// one carries it in its own .pi/plugin (Pi tool.execute.after
// hook), so every pi run in that repo gets it regardless of which loop
// drove it.

// ---------------------------------------------------------------------------
// processMessage — core: runs a queued message through runAgent
// ---------------------------------------------------------------------------

/**
 * A readable provisional name for a session started from Slack: the first line
 * of what the person actually wrote, with the bot mention and any leading
 * whitespace stripped. Takes the card title (the clean Slack text) over the
 * prompt, which by this point may carry an intro and mode instructions the
 * person never typed. "" when nothing usable survives, so the caller keeps its
 * own fallback.
 */
function provisionalTitle(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, " ")
    .trim()
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export async function processMessage(
  sessionKey: string,
  msg: QueuedMessage,
): Promise<void> {
  const { prompt, channel, userName, isNewSession } = msg;
  const threadTs = msg.threadTs;

  // Load or create session
  let createdSession = false;
  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) {
      activeSessions.set(sessionKey, session);
    }
  }

  if (isNewSession && !session) {
    session = {
      channel,
      threadTs,
      userId: msg.userName,
      claudeSessionId: null,
      worktreeDir: msg.worktreeDir || null,
      branch: msg.branch || null,
      repoId: msg.repoId || null,
      // Name it after the message now. The generated summary title below
      // takes ~15s to land, and until it does the UI falls back to the
      // session key — a session called "C0BE8KVFBEX-1787038283.876079".
      title: provisionalTitle(msg.cardTitle || prompt) || undefined,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
    activeSessions.set(sessionKey, session);
    createdSession = true;
    // Persist immediately — the "Open in Open Session" link posted below points
    // at slack-<channel>-<ts>, which only resolves once this file exists.
    await saveSession(session);
  }

  if (!session) {
    console.error(`[slack] No session found for ${sessionKey}`);
    await sendSlackMessage(channel, "No active session found.", threadTs);
    return;
  }

  // A worktree minted upstream for a message that landed in an EXISTING
  // conversational session must be adopted, not dropped: without this the
  // branch-named file `wt new-slack` wrote never gets the engine id mirrored
  // (persistSession keys on session.branch), so it surfaces in the UI as a
  // dead "No engine session to resume" row — while the run itself executes in
  // the repo's main checkout (2026-07-25, screen-export-mixed-dims). Never
  // switch an existing worktree — adopt only when the session has none.
  if (!createdSession && !session.worktreeDir && msg.worktreeDir) {
    session.worktreeDir = msg.worktreeDir;
    session.branch = msg.branch || session.branch;
    if (msg.repoId) session.repoId = msg.repoId;
    await persistSession(session);
  }

  if (createdSession) pinSlackSession(`slack-${sessionKey}`, msg.userId);

  // Auto-name the session from its opening prompt, exactly like a UI-created
  // session. Without this a Slack session wears its session key as a title
  // (scanSlackSessions falls back to `branch`, which for a thread/DM session is
  // the raw <channel>-<threadTs>), because the two other ensureGeneratedTitle
  // callers are UI-only: run-session.ts gates on source === "opensession" and
  // ws-handlers/session-control only fire on create_session.
  if (createdSession) {
    void ensureGeneratedTitle(
      `slack-${sessionKey}`,
      prompt,
      msg.userId,
      session.model,
    ).then((t) => {
      if (t) invalidateSessionsCache();
    });
  }

  // Set up abort controller
  const abortController = new AbortController();
  const sq = getOrCreateQueue(sessionKey);
  sq.abortController = abortController;

  // External MCP servers: runAgent applies the runner-layer gate itself —
  // filterMcpServers keyed on `user: msg.userId` enforces per-user
  // `allowedUsers` (worktree/linked channels bypass ALLOWED_USER_ID so the
  // whole team can drive them; a user-restricted server like brex must stay
  // invisible to everyone else).

  // Set up streaming (stream starts lazily on first content)
  const streamer = new SlackStreamer(channel, threadTs, msg.userId);
  await streamer.setStatus("is thinking...");

  // Live progress card — a native task_card block (the Linear-agent style
  // card), posted as the thread's visible reply and edited in place as work
  // proceeds: "Created and started working on <session link>" header, the
  // model's latest narration + capped plan on the card, the current tool
  // action, and a lone Stop button so the run can be cancelled even if
  // Slack's assistant DM disables the input field while we're working. Works
  // in channels (unlike the DM-only assistant typing status), throttled to
  // ~1 edit/sec.
  const opensessionUrl = `${configuredServer().publicBaseUrl}/session/slack-${encodeURIComponent(sessionKey)}`;
  const progress = new SlackProgress({
    channel,
    sessionKey,
    sessionUrl: opensessionUrl,
    title: taskCardTitle(msg.cardTitle || prompt),
    linkText: session.branch || "this session",
    continuedBy: createdSession ? undefined : userName,
  });
  await progress.start(threadTs);

  // Backwards-compatible alias: every exit path already calls this to render
  // the card's terminal state (and drop the Stop button).
  const dismissStopButton = (label: string): Promise<void> =>
    progress.finish(label);

  // Recreate worktree if it was cleaned up (revived thread)
  if (
    session.worktreeDir &&
    !cachedWorktreeExists(session.worktreeDir) &&
    session.branch
  ) {
    console.log(
      `[slack] [revive] Worktree ${session.branch} was cleaned up, recreating...`,
    );
    // Transient activity line, not the header — otherwise the card stays stuck
    // on "Recreating worktree…" for the whole run after the (quick) recreate.
    progress.setAction("Recreating worktree…");
    await streamer.setStatus("recreating worktree...");
    try {
      // Async: the fetch + worktree add + rebase chain runs for many seconds and
      // used to block the whole event loop via spawnSync.
      const branch = session.branch;
      const wtPath = session.worktreeDir;

      // Non-default repos: the generic revive (fetch + worktree add off the
      // repo's own default branch) covers everything the fusion-specific
      // steps below do, minus the fusion env-file seeding.
      if (session.repoId && session.repoId !== getRepo().id) {
        await reviveWorktree(branch, session.repoId);
      } else {
        // Prune stale registrations
        await runCommand(["git", "worktree", "prune"], { cwd: DEFAULT_CWD });

        // Fetch latest main
        await runCommand(["git", "fetch", "origin", "main", "--quiet"], {
          cwd: DEFAULT_CWD,
          timeoutMs: 30000,
        });

        // Create worktree — reuse existing branch or create from main
        const haveBranch =
          (
            await runCommand(
              [
                "git",
                "show-ref",
                "--verify",
                "--quiet",
                `refs/heads/${branch}`,
              ],
              { cwd: DEFAULT_CWD },
            )
          ).status === 0;
        const addResult = haveBranch
          ? await runCommand(["git", "worktree", "add", wtPath, branch], {
              cwd: DEFAULT_CWD,
              timeoutMs: 60000,
            })
          : await runCommand(
              ["git", "worktree", "add", "-b", branch, wtPath, "main"],
              { cwd: DEFAULT_CWD, timeoutMs: 60000 },
            );

        if (addResult.status !== 0) {
          throw new Error(
            `git worktree add failed: ${addResult.stderr?.trim() || addResult.stdout?.trim()}`,
          );
        }

        // Rebase on latest main
        await runCommand(["git", "pull", "origin", "main", "--rebase"], {
          cwd: wtPath,
          timeoutMs: 60000,
        });

        // Copy env files (quick, no bun install — Claude can do that if needed)
        const envFiles = [
          [".envrc", ".envrc"],
          [
            "packages/core/webapp/.env.local",
            "packages/core/webapp/.env.local",
          ],
          ["packages/core/instant/.env", "packages/core/instant/.env"],
          ["packages/core/temporal/.env", "packages/core/temporal/.env"],
        ];
        for (const [src, dst] of envFiles) {
          try {
            copyFileSync(`${DEFAULT_CWD}/${src}`, `${wtPath}/${dst}`);
          } catch {}
        }
      }

      console.log(`[slack] [revive] Worktree ${branch} recreated`);
      // Reset Claude session since old one is stale after cleanup
      session.claudeSessionId = null;
      await saveSession(session);
    } catch (e) {
      console.error(
        `[slack] [revive] Failed to recreate worktree ${session.branch}:`,
        e,
      );
      await streamer.error(`Failed to recreate worktree: ${e}`);
      await streamer.clearStatus();
      await dismissStopButton("Failed");
      return;
    }
  }

  const cwd = session.worktreeDir || DEFAULT_CWD;

  console.log(
    `[slack] Running agent for ${sessionKey} in ${cwd}${session.claudeSessionId ? ` (resuming ${session.claudeSessionId})` : ""}`,
  );

  let resultText = "";
  let resultSessionId = session.claudeSessionId || "";

  // --- Channel memory + self-management tools (interactive Slack only) -------
  // processMessage only ever runs for whitelisted users (gated at the event
  // handlers; worktree channels are team-only by design), so admin tools are
  // safe here. The powerful automation/MCP tools are further gated to the
  // configured trusted user; channel memory is available to anyone.
  let adminMcpServers: Record<string, any> = {};
  let memoryAppend = "";
  try {
    const kind = await getChannelKind(channel);
    const memCtx: MemoryContext = {
      channel,
      userId: msg.userId,
      isDM: kind.isDM,
      isPrivate: kind.isPrivate,
    };
    memoryAppend = await renderMemoryForPrompt(memCtx, msg.prompt);
    const memoryHash = `${channel}:${msg.userId}:${memoryAppend}`.substring(
      0,
      40,
    ); // Simple hash

    // Check cache: reuse admin tools if memory hasn't changed
    const cached = adminMcpServersCache.get(sessionKey);
    if (cached && cached.memoryHash === memoryHash) {
      adminMcpServers = cached.tools;
    } else {
      const isAdmin = !ALLOWED_USER_ID || msg.userId === ALLOWED_USER_ID;
      adminMcpServers = {
        "opensession-admin": createAdminMcpServer({
          ...memCtx,
          createdBy: userName || msg.userId,
          isAdmin,
          threadTs: msg.threadTs,
        }),
        "opensession-github": createGithubMcpServer({
          requestedBy: msg.userId,
          channel,
          threadTs: msg.threadTs,
        }),
        "opensession-sessions": createSessionsMcpServer({
          createdBy: userName || msg.userId,
          createdByLogin: githubLoginForTrustedSlackId(msg.userId) || undefined,
          isAdmin,
          currentSessionId: `slack-${sessionKey}`,
        }),
        "opensession-humans": createHumansMcpServer({
          sessionId: `slack-${sessionKey}`,
          createdBy: userName || msg.userId,
          isAdmin,
        }),
      };
      adminMcpServersCache.set(sessionKey, {
        tools: adminMcpServers,
        memoryHash,
      });
    }
  } catch (e) {
    console.warn("[slack] failed to build admin tools / memory:", e);
  }
  const ADMIN_TOOLS_PROMPT =
    "\n\n## Self-management\nYou can manage your own setup via the opensession-admin MCP tools: " +
    "channel memory (remember / list_memory / forget) and, for trusted users, automations " +
    "(list/create/update/delete/run_automation — routines on a UTC cron, or event/webhook), one-off " +
    "scheduled runs (schedule_once — 'remind me about this next week', 'run this again in a week', or any " +
    "one-time task at a future time; it posts back to this thread by default and can DM/act via its MCPs), " +
    "and MCP connections (list/add/remove_mcp_server). When a user asks you to remember something, " +
    "set up a recurring job, schedule a reminder or future task, or connect a tool, use these tools rather than just describing how." +
    `\n\n## GitHub PR actions\nWhen asked to review, auto-fix, simplify, or adversarially review a ${defaultRepo().label} PR ` +
    '(e.g. "review PR 4296", "auto-fix PR 4296", "adversarial review PR 4296"), use the opensession-github MCP tools ' +
    "(review_pr / auto_fix_pr / simplify_pr / adversarial_review_pr) — they run the same actions as the PR labels and " +
    "post the results on the PR. Pass the PR number; the tool starts it and reports back, so just relay what it says." +
    `\n\n## Managing other sessions\nYou can see and steer every other ${productName()} session via the opensession-sessions MCP tools. ` +
    "Use list_sessions (filter 'waiting' to find sessions blocked on a question, 'active' for what's running) and get_session " +
    "to inspect state and transcripts. For trusted users: answer_session_question unblocks a session paused on a question, " +
    "send_to_session messages/redirects a running or idle session, cancel_session stops a run, and create_session spins up a new " +
    'ask- or code-mode session. When asked things like "what\'s still running?", "what\'s waiting on me?", or "tell session X to …", ' +
    "use these tools. Combine with the gh CLI (Bash) for deeper PR status (CI checks, review state) beyond the PR link list_sessions already shows." +
    `\n\n## Human in the loop\nYou can pull a teammate into the loop via the opensession-humans MCP: ask_human DMs them (as you, ${personaName()}) and folds their reply back into this session. ` +
    "Use mode 'block' when you can't continue without the answer (your turn pauses until they reply — e.g. \"ask Grant for the copy\"), or 'async' (default) to keep working while you wait. " +
    "For async, deliver_when controls timing: 'now', 'when_done' (when this session next goes idle), 'on_pr' (once a PR is open — best for \"ask John for a review when done\"), or 'at_time' with a natural-language at_time. " +
    "Pass `options` for one-tap button choices, and `context` to attach background (the copy slot, a diff, a screen). Use list_pending_asks / cancel_ask to manage outstanding ones. " +
    'When the user says things like "ask Grant for X", "get John to review when I\'m done", or "check with Jaap before shipping", use ask_human rather than just telling them to do it.';

  // In-process MCP for this run: the slack-context server set (channel memory,
  // github report-back, slack ask handler). Pi reaches these through the
  // run-rpc stdio proxies, which execute against the per-session override
  // registered below — NOT the generic interactive builder.
  const bksId = `slack-${sessionKey}`;
  const askHandler: AskUserHandler = (input) =>
    handleAskUserQuestion(sessionKey, input, channel, threadTs);
  const inProcessMcp: Record<string, unknown> = {
    ...adminMcpServers,
    "opensession-ask": createAskUserMcpServer({ ask: askHandler }),
  };
  registerSessionMcpServers(bksId, inProcessMcp);

  const onAbort = () => {
    void cancelAgentRun(resultSessionId, bksId);
    return true;
  };
  abortController.signal.addEventListener("abort", onAbort, { once: true });

  // Vercel-preview detection (was a Claude PostToolUse hook): track bash
  // commands by tool-use id so PR creation can be spotted in the result.
  const bashCommands = new Map<string, string>();

  // Attachments: download the message/thread images now (refs were captured at
  // event intake) so they reach the engine as native image parts on the opening
  // prompt, instead of the agent having to fetch them afterwards.
  // A durable Slack queue item may return after a service restart. Resume the
  // existing engine turn with hidden harness context instead of submitting the
  // person's original Slack message as a second visible user turn.
  const continuingAfterRestart =
    msg.restartRecovery && !!session.claudeSessionId;
  let runPrompt = continuingAfterRestart
    ? restartContinuationPrompt(prompt)
    : prompt;
  if (memoryAppend) runPrompt = `${memoryAppend}\n\n${runPrompt}`;
  let images: ImageInput[] | undefined;
  // A resumed engine already has its opening attachments in history. Sending
  // them again would create another image-bearing user turn. If no engine id
  // was ever established, this is a true rerun and must download them again.
  if (msg.files?.length && !continuingAfterRestart) {
    try {
      const res = await downloadSlackImages(msg.files);
      if (res.images.length) images = res.images;
      if (res.note) runPrompt += `\n\n${res.note}`;
    } catch (e) {
      console.warn("[slack] Attachment download failed:", e);
    }
  }

  try {
    // Account rotation (meridian pool, sender-personal-first via `user`) and
    // usage-limit model fallback are runAgent's job now. mcpServers stays
    // unset = all configured servers, gated per-user by filterMcpServers
    // inside the runner.
    for await (const event of runAgent({
      // Interactive Slack runs get the full connector set, as before.
      mcpServers: "all",
      prompt: runPrompt,
      promptEntryId: msg.promptEntryId,
      images,
      sessionId: session.claudeSessionId || undefined,
      cwd,
      mode: "code",
      model: toPiModel(session.model || getDefaultModel()),
      // Interactive Slack runs are as interactive as the web UI: when the
      // primary model exhausts (e.g. the small Fable weekly bucket), let
      // runAgent's tier graph carry the turn onto Sol/Opus instead of
      // dead-ending on "no other account is currently usable". Without this the
      // fallback guard in runAgent short-circuits and the comment above is a
      // no-op. onAskUser (below) routes any ask-before-downgrade hop to the
      // Slack question card.
      fallbackModel: interactiveFallbackModel(session.model),
      user: msg.userId,
      author: gitIdentityFor(msg.userId),
      // Interactive Slack runs keep AWS read access via the injected
      // short-lived creds (restores a2655fc9, lost in the pi cutover).
      aws: true,
      inProcessMcp,
      reposNote: SLACK_SYSTEM_PROMPT_APPEND + ADMIN_TOOLS_PROMPT,
      // osSessionId feeds the in-process MCP proxy path; resume-on-boot
      // skips "slack" kinds (the queue re-delivers interrupted messages).
      journal: { osSessionId: bksId, kind: "slack" },
      // Money-moving Stripe tools need the per-call human confirmation the
      // interactive runner provides; stripped from the tool list here.
      deniedTools: Object.fromEntries(
        Object.keys(STRIPE_CONFIRM_TOOLS).map((name) => [
          name,
          `This Stripe action requires human confirmation — open this session in ${productName()} and retry there; the approval card will appear in that UI.`,
        ]),
      ),
      // Claude-path runs (bridge-off degraded mode) keep the native
      // AskUserQuestion flowing to the same Slack question card.
      onAskUser: askHandler,
    })) {
      if (abortController.signal.aborted) break;

      if (event.type === "init") {
        resultSessionId = event.sessionId || resultSessionId;
        console.log(`[slack] engine session initialized: ${resultSessionId}`);
        // Persist the id right away — the opensession UI resolves the live
        // transcript (and dedupes the branch-named session) through it, so
        // waiting until the run ends leaves the session page empty.
        if (resultSessionId && resultSessionId !== session.claudeSessionId) {
          session.claudeSessionId = resultSessionId;
          await persistSession(session);
        }
      }

      if (event.type === "model_switch") {
        const durable = shouldPersistModelSwitch(event);
        if (durable && event.toModel) {
          session.model = event.toModel;
          await persistSession(session);
        }
        if (!durable) {
          await sendSlackMessage(
            channel,
            `:warning: \`${event.fromModel}\` ${event.switchReason || "fell back"} — using \`${event.toModel}\` for this turn only.`,
            threadTs,
          ).catch(() => {});
        }
      }

      // Assistant prose -> the card's narration line (Linear-style). Chunks
      // accumulate; the card renders the latest paragraph.
      if (event.type === "text_chunk" && event.text) {
        progress.appendNarration(event.text);
      }

      // Update the live progress checklist + assistant thread status from tools
      if (event.type === "tool_use" && event.toolName) {
        const name = normalizeToolName(event.toolName);
        const input: any = event.toolInput;

        if (name === "Bash" && event.toolUseId) {
          bashCommands.set(event.toolUseId, String(input?.command || ""));
        }

        // TodoWrite -> the model's own plan IS the checklist (Claude Tag style)
        if (name === "TodoWrite") {
          progress.setTodos(input?.todos);
        } else if (name === "TaskCreate") {
          // TaskCreate -> use activeForm as status (high-level progress)
          const status = input?.activeForm || input?.subject || "Working...";
          progress.setAction(status);
          await streamer.setStatus(status);
        } else if (!isSilentTool(name)) {
          // Write/action tools -> show what's happening; bash commands render
          // monospaced under the action line, like Linear's card.
          const status = buildToolStatus(name, input);
          progress.setAction(
            status,
            name === "Bash" ? String(input?.command || "") : undefined,
          );
          await streamer.setStatus(status);
        }
      }

      // Detect PR creation from the bash result and poll for Vercel preview
      if (event.type === "tool_result" && event.toolUseId) {
        const cmd = bashCommands.get(event.toolUseId);
        if (cmd?.includes("gh pr create")) {
          const prMatch = String(event.content || "").match(
            /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/,
          );
          if (prMatch) {
            const prNumber = parseInt(prMatch[1], 10);
            console.log(
              `[slack] PR #${prNumber} created, polling for Vercel preview`,
            );
            pollForVercelPreview(prNumber, channel, threadTs).catch((e) =>
              console.error(`[slack] [vercel] Preview poll error:`, e),
            );
          }
        }
      }

      if (event.type === "done") {
        resultSessionId = event.sessionId || resultSessionId;
        resultText = event.result || "";
        console.log(`[slack] agent finished. Session ID: ${resultSessionId}`);
      }
      if (event.type === "error") {
        resultText = `Error: ${event.content || "Unknown error"}`;
      }
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      console.error(`[slack] agent run error for ${sessionKey}:`, e);
      resultText = `Error running agent: ${e.message || e}`;
    }
  } finally {
    abortController.signal.removeEventListener("abort", onAbort);
    unregisterSessionMcpServers(bksId);
  }

  if (abortController.signal.aborted) {
    if (isRestartAbort(abortController.signal)) {
      console.log(
        `[slack] run interrupted by server restart for ${sessionKey}`,
      );
      await streamer.clearStatus();
      await progress.restarting();
      return;
    }
    console.log(`[slack] run aborted for ${sessionKey}`);
    await streamer.error("Cancelled by user.");
    await streamer.clearStatus();
    await dismissStopButton("Cancelled");
    return;
  }

  // Update session
  session.claudeSessionId = resultSessionId || session.claudeSessionId;
  session.lastActivity = new Date().toISOString();
  await persistSession(session);

  // Media the reply asked to show comes out first, on the raw text: the
  // markdown conversion below would read the underscores in a path as
  // emphasis, and the 3000-char cap would drop or halve a marker line.
  const shown = splitSlackMedia(resultText);

  // Send result to Slack via streamer (convert markdown -> Slack mrkdwn)
  const formatted = shown.text ? markdownToSlack(shown.text) : "";
  const truncated = formatted
    ? formatted.length > 3000
      ? formatted.substring(0, 3000) + "...(truncated)"
      : formatted
    : // A reply that is only a marker line has already said everything it has to
      // say; the upload is the message.
      shown.media.length > 0
      ? ""
      : "Done! (no text output)";

  await streamer.stop(truncated, shown);
  await streamer.clearStatus();
  // Errors surface as the card's red terminal state instead of a green check.
  await dismissStopButton(resultText.startsWith("Error") ? "Failed" : "Done");
}

// ---------------------------------------------------------------------------
// handleMessageEvent — DM messages
// ---------------------------------------------------------------------------

export async function handleMessageEvent(event: any): Promise<void> {
  const { channel, user, ts, thread_ts } = event;
  const files = slackFileRefs(event.files);
  // An image-only message (no text) is still a real request — the attachment
  // IS the message.
  const text =
    (event.text || "").trim() ||
    (files.length ? "(no message text — see the attached files)" : "");

  if (!text) return;

  // Human-in-the-loop: is this a teammate replying to a question the bot DM'd
  // them on behalf of a session? If so, route it back into that session and stop
  // — do NOT treat it as a new request to the bot. This is the one path that
  // deliberately accepts a message from someone other than the trusted user
  // (matchReply only matches the exact person asked, in that ask's DM). Runs
  // before the allow-list gate below for exactly that reason; it's tightly
  // scoped and every accepted reply is audited.
  const matchedAsk = matchHumanAskReply({
    channel,
    user,
    threadTs: thread_ts,
    text,
  });
  if (matchedAsk) {
    console.log(
      `[slack] Routed reply from ${user} into session ${matchedAsk.sessionId} (ask ${matchedAsk.id})`,
    );
    await addReaction(channel, ts, "white_check_mark").catch(() => {});
    await sendSlackMessage(
      channel,
      ":inbox_tray: Got it — passing that straight to the session. Thanks!",
      thread_ts || ts,
    ).catch(() => {});
    return;
  }

  const isDM = channel.startsWith("D");
  // For DMs: thread_ts means a reply in an existing thread; no thread_ts means
  // a new top-level message (e.g. Slack's "New Chat"). Use ts as the thread
  // anchor so each top-level DM starts its own session/worktree.
  const threadTs = thread_ts || ts;
  const sessionKey = getSessionKey(channel, threadTs);

  console.log(
    `[slack] Message from ${user} in ${channel}: ${text.substring(0, 50)}...`,
  );

  // A DM reply under a message a opensession session posted (automation DMs like
  // the daily recap) drives that session, answered back in the same thread —
  // same rule as channel threads. Before the allow-list gate for the same
  // reason as the human-ask path above: the DM'd person must be able to follow
  // up on a message the bot sent them, and the scope is just as tight (only
  // threads whose anchor message a session posted, only in that person's DM).
  if (thread_ts) {
    const threadSessionId = sessionForThread(channel, thread_ts);
    if (threadSessionId) {
      if (
        await maybeRetriggerAutomation(
          threadSessionId,
          text,
          channel,
          ts,
          thread_ts,
        )
      )
        return;
      if (tryGetSessionControl()) {
        console.log(
          `[slack] DM thread reply in ${channel}/${thread_ts} → session ${threadSessionId}`,
        );
        void addReaction(channel, ts, "eyes").catch(() => {});
        const res = await activateLinkedSession(
          threadSessionId,
          text,
          channel,
          thread_ts,
          ts,
          user,
        );
        if (res.status !== "error")
          noteAskThreadReply({ channel, threadTs: thread_ts, user });
        // Stale link (session deleted) → fall through to the normal DM flow.
        if (res.status !== "error") return;
        console.warn(
          `[slack] Thread-linked session ${threadSessionId} rejected delivery (${res.message}) — falling back`,
        );
      }
    }
  }

  if (ALLOWED_USER_ID && user !== ALLOWED_USER_ID) {
    console.log(`[slack] Ignoring message from non-allowed user: ${user}`);
    return;
  }

  // Handle stop/cancel keywords
  if (isStopMessage(text)) {
    const didCancel = cancelSession(sessionKey);
    if (didCancel) {
      await addReaction(channel, ts, "octagonal_sign");
      await sendSlackMessage(
        channel,
        "Cancelled. Queue cleared.",
        threadTs || ts,
      );
    } else {
      await sendSlackMessage(channel, "Nothing to cancel.", threadTs || ts);
    }
    return;
  }

  // Handle /model — set or show this session's model
  if (await handleModelCommand(sessionKey, text, channel, threadTs || ts)) {
    return;
  }

  // Add eyes reaction to acknowledge
  await addReaction(channel, ts, "eyes");

  // Check for existing session
  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) {
      activeSessions.set(sessionKey, session);
    }
  }

  const userInfo = await getUserInfo(user);
  const userName = userInfo?.real_name || user;

  if (session) {
    // Continue existing session
    console.log(`[slack] Continuing session: ${sessionKey}`);
    session.lastActivity = new Date().toISOString();

    enqueueMessage(sessionKey, {
      prompt: text,
      cardTitle: text,
      channel,
      threadTs: threadTs || ts,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: false,
      files: files.length ? files : undefined,
    });
  } else {
    // New session — always create a worktree
    console.log(`[slack] New session: ${sessionKey}, mode: worktree`);

    let worktreeDir: string | undefined;
    let branch: string | undefined;
    let prompt: string;

    try {
      branch = await generateBranchName(text);
      worktreeDir = await createWorktree(branch, user, text);

      prompt = `${userName} sent me a Slack message:

"${text}"

---

I'm now in a worktree (branch: ${branch}) for this task. Please analyze what needs to be done and help with this request. Start by exploring the codebase to understand the relevant code.`;
    } catch (e) {
      await sendSlackMessage(
        channel,
        `${MESSAGES.error} Failed to create worktree: ${e}`,
        threadTs || ts,
      );
      await removeReaction(channel, ts, "eyes").catch(() => {});
      return;
    }

    enqueueMessage(sessionKey, {
      prompt,
      cardTitle: text,
      channel,
      threadTs: threadTs || ts,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: true,
      worktreeDir,
      branch,
      files: files.length ? files : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// handleMentionEvent — @mention in channels
// ---------------------------------------------------------------------------

const UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

/**
 * Slack card for a triggered PR action. While running: "Open in Open Session" + Stop.
 * Once done: Stop is dropped (it's useless) and a "finished" note is added.
 */
function prActionCardBlocks(
  message: string,
  bksId: string,
  running: boolean,
): any[] {
  const opensessionButton = {
    type: "button",
    text: {
      type: "plain_text",
      text: `:desktop_computer: Open in ${productName()}`,
      emoji: true,
    },
    url: `${UI_BASE}/session/${bksId}`,
    action_id: `opensession:${bksId}`,
  };
  const stopButton = {
    type: "button",
    text: { type: "plain_text", text: ":octagonal_sign: Stop", emoji: true },
    style: "danger",
    action_id: `pr-stop:${bksId}`,
    value: bksId,
  };
  // On completion we just drop the Stop button — the separate "✓ Finished" reply
  // (posted by the caller) is the completion signal, so no redundant footer here.
  return [
    { type: "section", text: { type: "mrkdwn", text: message } },
    {
      type: "actions",
      block_id: `pr-action-${bksId}`,
      elements: running ? [opensessionButton, stopButton] : [opensessionButton],
    },
  ];
}

/**
 * A thread reply of "retrigger" under an automation-posted message re-fires
 * that automation with its original trigger payload (a brand-new run/session)
 * instead of steering the old session. Returns true when the reply was
 * consumed here — including a failed retrigger, which is answered in-thread
 * rather than delivered to the session as a prompt.
 */
async function maybeRetriggerAutomation(
  threadSessionId: string,
  replyText: string,
  channel: string,
  ts: string,
  threadTs: string,
): Promise<boolean> {
  if (!/^retrigger\b/i.test(replyText.trim())) return false;
  // Dynamic import: handlers.ts is pulled in by the agent loop at startup and
  // automations.ts pulls in several slack tool modules — avoid a load cycle.
  const { retriggerAutomationSession } =
    await import("../../server/automations");
  const res = retriggerAutomationSession(threadSessionId);
  if (res.ok) {
    console.log(
      `[slack] Retrigger in ${channel}/${threadTs} → automation "${res.name}"`,
    );
    await addReaction(channel, ts, "repeat");
    await sendSlackMessage(
      channel,
      `:repeat: Re-running *${res.name}* with the original trigger — it'll post fresh results when done.`,
      threadTs,
    );
  } else {
    console.warn(
      `[slack] Retrigger in ${channel}/${threadTs} failed: ${res.reason}`,
    );
    await sendSlackMessage(
      channel,
      `:warning: Couldn't retrigger this run: ${res.reason}`,
      threadTs,
    );
  }
  return true;
}

export async function handleMentionEvent(event: any): Promise<void> {
  const { channel, user, ts, thread_ts } = event;
  const text = event.text || "";
  const files = slackFileRefs(event.files);

  const cleanText =
    text.replace(/<@[A-Z0-9]+>/g, "").trim() ||
    (files.length ? "(no message text — see the attached files)" : "");

  if (!cleanText) return;

  console.log(
    `[slack] Mention from ${user} in ${channel}: ${cleanText?.substring(0, 50)}...`,
  );

  // Worktree channels bypass the ALLOWED_USER_ID check so the whole team can
  // drive the work from the channel.
  const inWorktreeChannel = isWorktreeChannel(channel);
  // A mention in a thread anchored by a message some opensession session posted
  // (automation summaries etc.) drives THAT session instead of starting a new
  // one. Same team-wide bypass as worktree channels: anyone in the thread can
  // follow up.
  const threadSessionId = thread_ts
    ? sessionForThread(channel, thread_ts)
    : undefined;

  if (
    !inWorktreeChannel &&
    !threadSessionId &&
    ALLOWED_USER_ID &&
    user !== ALLOWED_USER_ID
  ) {
    console.log(`[slack] Ignoring mention from non-allowed user: ${user}`);
    return;
  }

  // Thread posted by a session (e.g. an automation's Slack summary): deliver
  // the reply into that session and answer back in this thread. busy: "queue"
  // — if the automation run is still going, the follow-up waits for it rather
  // than steering (the in-thread answer mirror rides the queued message).
  if (threadSessionId) {
    if (
      await maybeRetriggerAutomation(
        threadSessionId,
        cleanText,
        channel,
        ts,
        thread_ts,
      )
    )
      return;
    if (tryGetSessionControl()) {
      console.log(
        `[slack] Thread reply in ${channel}/${thread_ts} → session ${threadSessionId}`,
      );
      void addReaction(channel, ts, "eyes").catch(() => {});
      const res = await activateLinkedSession(
        threadSessionId,
        cleanText,
        channel,
        thread_ts,
        ts,
        user,
      );
      // A stale link (session deleted since the index was built) falls through
      // to the normal mention flow instead of eating the message.
      if (res.status !== "error") return;
      console.warn(
        `[slack] Thread-linked session ${threadSessionId} rejected delivery (${res.message}) — falling back`,
      );
    }
  }

  // For worktree channels, use channel ID as session key (one session per worktree)
  // so all threads share the same Claude session context
  const threadTs = thread_ts || ts;
  const sessionKey = inWorktreeChannel
    ? channel
    : getSessionKey(channel, threadTs);

  // Handle stop/cancel keywords
  if (isStopMessage(cleanText)) {
    const didCancel = cancelSession(sessionKey);
    if (didCancel) {
      await addReaction(channel, ts, "octagonal_sign");
      await sendSlackMessage(channel, "Cancelled. Queue cleared.", threadTs);
    }
    return;
  }

  // Handle /model — set or show this session's model
  if (await handleModelCommand(sessionKey, cleanText, channel, threadTs)) {
    return;
  }

  await addReaction(channel, ts, "eyes");

  const userInfo = await getUserInfo(user);
  const userName = userInfo?.real_name || user;

  // Worktree channel: route to existing worktree session
  if (inWorktreeChannel) {
    const worktreeDir = getWorktreeDirForChannel(channel)!;
    const branch = worktreeChannels.get(channel)!;

    console.log(
      `[slack] Worktree channel mention from ${userName} for branch ${branch} (session: ${sessionKey})`,
    );

    // Check for existing session
    let session: SlackSession | undefined = activeSessions.get(sessionKey);
    if (!session) {
      session = (await loadSession(sessionKey)) ?? undefined;
      if (session) {
        activeSessions.set(sessionKey, session);
      }
    }

    // Fetch thread/channel context
    let context = "";
    let threadFiles: SlackFileRef[] = [];
    if (thread_ts) {
      const tc = await cachedFetchThreadContext(channel, thread_ts);
      context = tc.text;
      threadFiles = tc.files;
    }

    let prompt: string;
    if (session) {
      // Continue existing session
      prompt = context
        ? `${userName} said (in a thread):\n\nThread context:\n---\n${context}\n---\n\nTheir message: "${cleanText}"`
        : `${userName} said: "${cleanText}"`;
    } else {
      // New session for this worktree channel
      prompt = `${userName} tagged me in the #worktree-${branch} Slack channel.

I'm working in worktree branch \`${branch}\` at \`${worktreeDir}\`.
${context ? `\nThread context:\n---\n${context}\n---\n` : ""}
Their message: "${cleanText}"

Please help with this request. Start by exploring the codebase to understand what's relevant.`;
    }

    enqueueMessage(sessionKey, {
      prompt,
      cardTitle: cleanText,
      channel,
      threadTs,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: !session,
      worktreeDir,
      branch,
      files: mergeFileRefs(files, threadFiles),
    });
    return;
  }

  // Regular (non-worktree) channel mention. A quick Haiku classifier decides the
  // route: an explicit PR action runs directly (no worktree), a question runs
  // in-thread in the repo's checkout (no worktree), and a coding task spins up a
  // worktree as before. Repo selection uses the New-session picker's shared
  // Auto router (message + channel name + thread context; no match → default).
  // Fail-open: a null verdict falls through to the default-repo code path.
  //
  // Only thread mentions get surrounding context: a thread is one coherent
  // conversation, while channel history is mostly other people's unrelated
  // requests and would leak into the session prompt. Fetched before the
  // classifier so the repo verdict sees it too (cached, so no extra call).
  let context = "";
  let threadFiles: SlackFileRef[] = [];
  if (thread_ts) {
    const tc = await cachedFetchThreadContext(channel, thread_ts);
    context = tc.text;
    threadFiles = tc.files;
  }
  const channelName = channel.startsWith("D")
    ? null
    : (await getChannelKind(channel).catch(() => null))?.name || null;
  const intent = await classifyMention(cleanText, { channelName, context });
  // The router's verdict; getRepo(null/undefined) = the default repo.
  const repo = getRepo(intent?.repo || undefined);
  const isDefaultRepo = repo.id === getRepo().id;
  if (!isDefaultRepo) console.log(`[slack] mention routed to repo ${repo.id}`);

  if (intent && intent.action !== "none" && intent.prNumber) {
    // Carry the message text as steer so any specific guidance reaches the run.
    const res = await triggerPrAction(
      intent.action,
      intent.prNumber,
      user,
      cleanText,
    );
    if (res.ok && res.bksId) {
      const msg = `On it — ${res.message}`;
      const bksId = res.bksId;
      const posted = await postSlackBlocks(
        channel,
        msg,
        prActionCardBlocks(msg, bksId, true),
        threadTs,
      );
      const cardTs = posted?.ts;
      // When the run finishes: drop the Stop button and report back in-thread.
      if (res.done) {
        const url = res.url;
        void res.done.finally(() => {
          if (cardTs) {
            void updateSlackBlocks(
              channel,
              cardTs,
              msg,
              prActionCardBlocks(msg, bksId, false),
            ).catch(() => {});
          }
          void sendSlackMessage(
            channel,
            `✓ Finished — results are on the PR${url ? `: ${url}` : ""}`,
            threadTs,
          ).catch(() => {});
        });
      }
    } else {
      await sendSlackMessage(channel, res.message, threadTs);
    }
    return;
  }

  // Ask mode: a question/discussion — answer in-thread in the repo's checkout,
  // no worktree or dedicated channel. Non-default repos run in their pinned
  // ask checkout (opensession → its live shared checkout).
  if (intent?.mode === "ask") {
    let askSession: SlackSession | undefined =
      activeSessions.get(sessionKey) ??
      (await loadSession(sessionKey)) ??
      undefined;
    if (askSession) activeSessions.set(sessionKey, askSession);
    let askCwd: string | undefined;
    if (!isDefaultRepo && !askSession) {
      try {
        askCwd = await ensureAskCheckout(repo.id);
      } catch (e) {
        console.warn(
          `[slack] ask-checkout for ${repo.id} failed (falling back to default):`,
          e,
        );
      }
    }
    const intro = context
      ? `${userName} asked me in a Slack thread (with context):\n\n---\n${context}\n---\n\nTheir question: "${cleanText}"`
      : `${userName} asked me in Slack: "${cleanText}"`;
    const repoNote = askCwd
      ? ` I'm in the ${repo.id} repo's checkout for this.`
      : "";
    enqueueMessage(sessionKey, {
      prompt: `${intro}\n\nThis is a question/discussion, not a coding task — don't create a branch or change code. Read the codebase as needed for context and answer concisely.${repoNote}`,
      cardTitle: cleanText,
      channel,
      threadTs,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: !askSession,
      // No worktreeDir → runs conversationally in the default repo's main
      // checkout; a non-default repo verdict pins it to that repo's checkout.
      worktreeDir: askCwd,
      repoId: askCwd ? repo.id : undefined,
      files: mergeFileRefs(files, threadFiles),
    });
    return;
  }

  // Code mode: a real coding task. A thread session that already has a
  // workspace continues in it — minting another worktree here would orphan it
  // (nothing links a second branch file to the thread session, so it shows up
  // in the UI as a dead session). A conversational session falls through: the
  // worktree created below is adopted onto it by processMessage.
  const existingCodeSession: SlackSession | undefined =
    activeSessions.get(sessionKey) ??
    (await loadSession(sessionKey)) ??
    undefined;
  if (existingCodeSession) activeSessions.set(sessionKey, existingCodeSession);
  if (existingCodeSession?.worktreeDir) {
    const intro = context
      ? `${userName} tagged me in a Slack thread with this context:\n\n---\n${context}\n---\n\nTheir message: "${cleanText}"`
      : `${userName} tagged me in a Slack channel with this message: "${cleanText}"`;
    enqueueMessage(sessionKey, {
      prompt: `${intro}\n\nPlease help with this request.`,
      cardTitle: cleanText,
      channel,
      threadTs,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: false,
      files: mergeFileRefs(files, threadFiles),
    });
    return;
  }

  // Spin up a worktree. Every registered repo uses the generic worktree
  // helper; shared-checkout repos resolve to their live checkout.
  let worktreeDir: string | undefined;
  let branch: string | undefined;
  let prompt: string;

  try {
    let where: string;
    if (isDefaultRepo) {
      branch = await generateBranchName(cleanText, context);
      worktreeDir = await createWorktree(branch, user, cleanText);
      where = `I'm now in a worktree (branch: ${branch}) for this task.`;
    } else if (sharedCheckoutForNewSessions(repo)) {
      worktreeDir = repo.repo;
      where = `This task is in the ${repo.id} repo — I'm working directly in its live shared checkout on ${repo.defaultBranch} (shared with other sessions: stage only my own files, commit + push directly, never reset or switch branches).`;
    } else {
      branch = await resolveUniqueBranch(
        await generateBranchName(cleanText, context),
        repo.id,
      );
      worktreeDir = await createRepoWorktree(branch, repo.id);
      where = `This task is in the ${repo.id} repo — I'm in a worktree (branch: ${branch}). Commit and open a PR against ${repo.ghRepo} when done.`;
    }

    const intro = context
      ? `${userName} tagged me in a Slack thread with this context:

---
${context}
---

Their message: "${cleanText}"`
      : `${userName} tagged me in a Slack channel with this message: "${cleanText}"`;

    prompt = `${intro}

${where} Please help with this request. Start by exploring the codebase to understand the relevant code.`;
  } catch (e) {
    await sendSlackMessage(
      channel,
      `${MESSAGES.error} Failed to create worktree: ${e}`,
      threadTs,
    );
    await removeReaction(channel, ts, "eyes").catch(() => {});
    return;
  }

  enqueueMessage(sessionKey, {
    prompt,
    cardTitle: cleanText,
    channel,
    threadTs,
    messageTs: ts,
    userName,
    userId: user,
    isNewSession: !existingCodeSession,
    worktreeDir,
    branch,
    repoId: isDefaultRepo ? undefined : repo.id,
    files: mergeFileRefs(files, threadFiles),
  });
}
