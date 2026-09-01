/**
 * In-process self-management MCP servers for INTERACTIVE Open Session sessions
 * (web UI + loops) — the same opensession-sessions / opensession-admin tools the Slack
 * agent gets, so you can list/steer sessions and manage automations/MCPs from a
 * interactive session. Built fresh per run from the prompt's author. NEVER pass
 * these to automation runs or to interactive resumes of automation-owned
 * sessions — untrusted ticket text must not reach session-control / config
 * tools. Open Session is Tailscale- and team-gated and already exposes all of this
 * through its UI, so interactive users are treated as admin.
 *
 * Sole exception: opensession-papercuts (append-only friction log, no reads of
 * anything sensitive, no control surface) also goes to automation runs — see
 * papercutsServerFor and the automation guard in the run-rpc builder below.
 */

import { createSessionsMcpServer } from "../agents/slack/sessions-tools";
import { isDevInstance } from "./dev-mode";
import { createRunnersMcpServer } from "./runners-mcp";
import { createAdminMcpServer } from "../agents/slack/admin-tools";
import { createHumansMcpServer } from "../agents/slack/humans-tools";
import { createKeychainMcpServer } from "../agents/slack/keychain-tools";
import { createPublishMcpServer } from "../agents/slack/publish-tools";
import { createAskUserMcpServer } from "../agents/slack/ask-tools";
import { createReposMcpServer } from "../agents/slack/repos-tools";
import { createPortalsMcpServer } from "./portals-mcp";
import { createWalkthroughMcpServer } from "../agents/slack/walkthrough-tools";
import { createSlackComposeMcpServer } from "../agents/slack/slack-compose-tools";
import { createMemoryMcpServer } from "../agents/slack/memory-tools";
import {
  createGoalsMcpServer,
  createGoalSelfMcpServer,
} from "../agents/slack/goal-tools";
import { createPapercutsMcpServer } from "../agents/slack/papercuts-tools";
import { createTodosMcpServer } from "../agents/slack/todos-tools";
import { createSearchMcpServer } from "../agents/slack/search-tools";
import { createAssetsMcpServer } from "../agents/slack/assets-tools";
import { createWorkflowsMcpServer } from "../agents/slack/workflow-tools";
import { createSelfDeployMcpServer } from "./self-deploy";
import { createWebMcpServer } from "./web-mcp";
import { papercutsEnabledForRepo } from "./papercuts";
import { defaultRepo, productName } from "./config";
import { githubCredentialForRun } from "./github-auth";
import { REPOS, sessionRepoId } from "./worktree";
import { registerInteractiveMcpBuilder } from "./run-rpc";
import {
  automationRunMcpForSession,
  selfImproveMcpForSession,
} from "./automations";
import {
  findSession,
  touchNativeSession,
  touchNativeSessionStrict,
} from "./session-cache";
import {
  claimPreviewPathLease,
  releasePreviewPathLease,
} from "./preview-path-leases";
import {
  attachRepo,
  linkPr,
  resolveSessionRepoContext,
  sessionRepoIds,
  switchPrimaryRepo,
} from "./session-repos";
import { makeAskHandler } from "./asks";
import { createScheduleMcpServer } from "./schedule-mcp";
import { activeSandboxFor } from "./session-sandbox";

type PreviewAction = "start" | "status" | "stop";
type PreviewModule = typeof import("./preview");

interface PreviewLifecycleDeps {
  findSession: typeof findSession;
  activeSandboxFor: typeof activeSandboxFor;
  loadPreview: () => Promise<PreviewModule>;
}

const previewLifecycleDeps: PreviewLifecycleDeps = {
  findSession,
  activeSandboxFor,
  loadPreview: () => import("./preview"),
};

/**
 * Execute the same Preview lifecycle for an agent tool as the session UI.
 * Sandboxed workspaces must never fall through to host Preview: the host path
 * is a different checkout and cannot observe or control the sandbox service.
 */
export async function runSessionPreviewAction(
  sessionId: string,
  action: PreviewAction,
  deps: PreviewLifecycleDeps = previewLifecycleDeps,
) {
  const session = deps.findSession(sessionId);
  const worktreeDir = session?.worktreeDir;
  if (!session || !worktreeDir)
    throw new Error("this session has no worktree to preview");

  const sandbox = await deps.activeSandboxFor(session, {
    wake: action === "start",
  });
  if (!sandbox && session.sandbox?.sandboxId) {
    throw new Error(
      `this session's ${session.sandbox.provider} sandbox is not available`,
    );
  }

  const preview = await deps.loadPreview();
  if (sandbox) {
    if (action === "start")
      return preview.startSandboxPreview(sandbox, worktreeDir, sessionId);
    if (action === "stop")
      return preview.stopSandboxPreview(sandbox, worktreeDir);
    return preview.getSandboxPreviewStatus(sandbox, worktreeDir);
  }

  if (action === "start") return preview.startPreview(worktreeDir);
  if (action === "stop") return preview.stopPreview(worktreeDir);
  return preview.getPreviewStatus(worktreeDir);
}

/** The session's primary repo id, for the papercuts toggle (undefined =
 *  session-only session, which logs under no repo and is always enabled). */
function repoIdForSessionId(sessionId: string): string | undefined {
  const s = findSession(sessionId);
  return s ? sessionRepoId(s) : undefined;
}

/** The papercuts server for a session, or {} when its repo opted out
 *  (Settings → Papercuts). Shared with automationMcpServers below — this is
 *  the ONE opensession-* server that is safe for automation runs (append-only
 *  friction log; see papercuts-tools.ts). */
function papercutsServerFor(
  sessionId: string,
  runKind: string,
  by?: string,
): Record<string, unknown> {
  if (!papercutsEnabledForRepo(repoIdForSessionId(sessionId))) return {};
  return {
    "opensession-papercuts": createPapercutsMcpServer({
      sessionId,
      runKind,
      by,
      defaults: () => {
        const s = findSession(sessionId);
        return { repo: repoIdForSessionId(sessionId), model: s?.model };
      },
    }),
  };
}

export function interactiveMcpServers(
  user?: string,
  sessionId?: string,
): Record<string, unknown> {
  const createdBy = user || productName();
  return {
    "opensession-sessions": createSessionsMcpServer({
      createdBy,
      isAdmin: true,
      currentSessionId: sessionId,
    }),
    "opensession-admin": createAdminMcpServer({
      channel: "opensession",
      userId: user || "opensession",
      isDM: false,
      isPrivate: false,
      createdBy,
      isAdmin: true,
    }),
    // Runners are deliberately trusted persistent machines for platform-locked
    // work. Interactive-only: untrusted automation text must never reach one.
    "opensession-runners": createRunnersMcpServer({ user, sessionId }),
    // Long-running goals: create/list/steer persistent, self-pacing missions.
    "opensession-goals": createGoalsMcpServer({ createdBy, isAdmin: true }),
    // Search past sessions' distilled records (session-index.ts). Read-only,
    // but transcripts can hold sensitive material — interactive-only like the
    // siblings (the automation gate in the run-rpc builder below fails closed).
    "opensession-search": createSearchMcpServer(),
    // Self-deploy: ff-only deploy of THIS instance to a sha + restart, with a
    // last-known-good pin, health gate, and watchdog-covered rollback
    // (deploy/self-deploy.sh). Interactive-only like every sibling — a deploy
    // restarts the live server, so the automation fail-closed gate in the
    // run-rpc builder below must keep withholding it from automation runs.
    // Withheld from dev instances too: the script targets the PRODUCTION
    // service/state (opensession.service, ~/.opensession-deploy), so a
    // throwaway preview must never carry a tool that restarts prod.
    ...(isDevInstance()
      ? {}
      : {
          "opensession-self-deploy": createSelfDeployMcpServer({
            user: createdBy,
          }),
        }),
    // Human-in-the-loop: ask a teammate and fold the answer back into this
    // session. Needs the session id so the answer routes home. Withheld (like
    // the others) from automation runs — see the runSessionPrompt call site.
    ...(sessionId
      ? {
          "opensession-humans": createHumansMcpServer({
            sessionId,
            createdBy,
            isAdmin: true,
          }),
          // Borrow a teammate's credential for a stated purpose, with
          // their approval, through the broker (src/server/keychain.ts).
          // Interactive-only for the same reason as its sibling above:
          // an ask is a DM carrying a model-authored purpose string, and
          // untrusted ticket text must never be able to compose one.
          "opensession-keychain": createKeychainMcpServer({
            sessionId,
            user: createdBy,
          }),
          // Publish a directory as a durable internal web app that
          // outlives this session (src/server/deploys.ts). Interactive
          // only: a deploy is arbitrary code that keeps running, so
          // untrusted automation text must never reach it.
          "opensession-publish": createPublishMcpServer({
            sessionId,
            user: createdBy,
            worktreeDir: () => findSession(sessionId)?.worktreeDir || undefined,
          }),
          // Cross-repo: attach secondary repos as isolated worktrees.
          "opensession-repos": createReposMcpServer({
            sessionId,
            attach: (repo, branch) =>
              attachRepo(
                sessionId,
                repo,
                branch,
                githubCredentialForRun(createdBy)?.env,
              ),
            switchPrimary: (repo) =>
              switchPrimaryRepo(
                sessionId,
                repo,
                false,
                githubCredentialForRun(createdBy)?.env,
              ),
            snapshot: () => {
              const s = findSession(sessionId);
              if (!s) return null;
              return {
                primaryRepo: sessionRepoId(s) ?? defaultRepo().id,
                branch: s.branch,
                worktreeDir: s.worktreeDir,
                attached: s.attachedRepos || [],
              };
            },
            repos: () =>
              Object.values(REPOS).map((p) => ({
                id: p.id,
                defaultBranch: p.defaultBranch,
                sharedCheckout: !!p.sharedCheckout,
              })),
            linkPr: (input) => linkPr(sessionId, input),
          }),
          // Durable repo/user/team memory, shared both ways with Slack's
          // channel memory. Write tools are
          // interactive-only — automation runs get read-only injection; see
          // memory-tools.ts for the trust model.
          "opensession-memory": createMemoryMcpServer({
            user,
            // Lets a write refresh THIS session's memory snapshot without
            // disturbing anyone else's cached prompt prefix.
            sessionId,
            repos: () => {
              const s = findSession(sessionId);
              return s ? sessionRepoIds(s) : [];
            },
          }),
          // Read the web: fetch a URL as text, search what was fetched,
          // clone a GitHub repo instead of scraping it. Deliberately no
          // search provider. The session id only picks which scratch dir a
          // clone lands in; the tool list is the same for every session,
          // which is what lets it ride the shared server pool.
          "opensession-web": createWebMcpServer({ sessionId }),
          // Portals are session-scoped supervised HTTP/WebSocket services.
          // The old Preview tool was intentionally replaced rather than
          // aliased: agents should choose Portals for live software.
          "opensession-portals": createPortalsMcpServer({
            sessionId,
            worktreeDir: () => findSession(sessionId)?.worktreeDir || undefined,
            sandbox: async (options) => {
              const session = findSession(sessionId);
              return session ? activeSandboxFor(session, options) : null;
            },
            hasSandbox: () =>
              Boolean(findSession(sessionId)?.sandbox?.sandboxId),
            runner: () => findSession(sessionId),
            setDefaultPath: async (path, options) => {
              const session = findSession(sessionId);
              if (!session) throw new Error("Session not found.");
              if (!options?.exclusiveKey) {
                await touchNativeSessionStrict(sessionId, {
                  previewPath: path || undefined,
                });
                try {
                  releasePreviewPathLease(sessionId);
                } catch (error) {
                  console.error(
                    `Failed to release preview reservation for ${sessionId}:`,
                    error,
                  );
                }
                return {};
              }
              const claim = claimPreviewPathLease({
                key: options.exclusiveKey,
                sessionId,
                path: path || "/",
                ttlMinutes: options.leaseMinutes,
              });
              if (!claim.ok)
                throw new Error(
                  "That staging record is already reserved by another active session. Choose or create another record.",
                );
              try {
                await touchNativeSessionStrict(sessionId, {
                  previewPath: path || undefined,
                });
                return { leaseId: claim.lease.id };
              } catch (error) {
                releasePreviewPathLease(sessionId, {
                  leaseId: claim.lease.id,
                });
                throw error;
              }
            },
          }),
          // Publish a demo walkthrough (video + before/after + writeup) onto
          // the session's Review tab and the PR description.
          "opensession-walkthrough": createWalkthroughMcpServer({
            sessionId,
            by: createdBy,
          }),
          // Human-gated Slack composition: the tool only opens an editable
          // composer. Posting still requires the signed-in person to press Send.
          "opensession-slack": createSlackComposeMcpServer({ sessionId }),
          // AskUserQuestion for engines without a canUseTool hook (Codex):
          // blocks on the same UI question card + Slack escalation as the
          // native Claude tool. claude-runner strips this server so Claude
          // keeps using the native AskUserQuestion instead of a duplicate.
          "opensession-ask": createAskUserMcpServer({
            ask: makeAskHandler(sessionId),
          }),
          // Dynamic workflows: deterministic agent fan-out from a
          // model-authored script (Agents panel). Interactive-only like the
          // siblings — the automation fail-closed gate in the run-rpc builder
          // below withholds it from automation-owned sessions.
          // No defaultModel: agents run on WORKFLOW_DEFAULT_MODEL (Opus), NOT
          // the session's model — a fan-out shouldn't silently inherit
          // whatever the orchestrator happens to be on.
          // No mcpAllowlist/deniedTools either: a script's mcp.* calls get
          // exactly what this user's own interactive runs get (the
          // `allowedUsers` gate still applies via createdBy, and
          // confirm-gated servers are dropped wholesale in workflow-mcp.ts).
          "opensession-workflows": createWorkflowsMcpServer({
            sessionId,
            user: createdBy,
            workspace: (repo, hint) => {
              const session = findSession(sessionId);
              if (!session) return undefined;
              const context = resolveSessionRepoContext(session, repo, hint);
              if (!context) return undefined;
              return {
                cwd: context.dir,
                repo: context.repo,
                baseBranch: context.branch,
              };
            },
            // The in-process servers a SCRIPT may call (mcp.opensession-assets
            // .write_asset and friends). Passing the whole set is safe and is
            // the point: workflow-mcp.ts intersects it with its own allowlist,
            // so this can only ever narrow, and a server this run does not
            // carry stays absent. Rebuilt per host because an McpServer holds
            // exactly ONE transport — mounting the session's own instance on
            // the workflow's in-memory pair would steal it from run-rpc. The
            // recursion is lazy and terminates: this closure runs on a
            // script's first mcp.* call, and the workflows server the rebuild
            // produces is excluded from the allowlist anyway.
            inProcessMcp: () => interactiveMcpServers(user, sessionId),
          }),
          // Per-session scratch assets (previewed in the Assets tab).
          // Works in Ask mode — writes land outside the checkout.
          "opensession-assets": createAssetsMcpServer({ sessionId }),
          // The user's Desk todo list — add/list/complete/drop/update.
          // Interactive-only like the siblings (the automation branch below
          // fails closed): untrusted ticket text must not write to a
          // human's list.
          "opensession-todos": createTodosMcpServer({
            sessionId,
            user: createdBy,
          }),
          // "Check back on this later": a durable kernel-timer prompt delivered
          // to THIS session (scheduled-prompts.ts). Interactive-only: it
          // authors a future turn in a human's session.
          "opensession-schedule": createScheduleMcpServer({
            sessionId,
            user: createdBy,
          }),
          // Friction log — log_papercut/list_papercuts, per-repo toggle in
          // Settings → Papercuts (dropped here when the repo opted out).
          ...papercutsServerFor(sessionId, "prompt", createdBy),
        }
      : {}),
  };
}

// Codex cannot consume Claude SDK in-process MCP servers directly. Expose the
// same interactive opensession-* tools through the run-rpc stdio proxy so Codex
// sessions can inspect/create/steer Open Session sessions too. Goal-driven
// sessions additionally get opensession-goal-self (next-wake/ledger/pause tools),
// matching what the in-process path hands them at the runAgent call sites.
/**
 * The automation-bar server set for an automation-owned session: papercuts +
 * the automation's own report/workflows rebuild + (selfImprove automations
 * only) the scoped spawn/self pair. This is exactly what the run-rpc fallback
 * builder below serves for these sessions. Exported so launchers that proxy
 * opensession-* servers into a detached run host (run-session's hosted pi
 * path) can compute proxy names that resolve to this same fail-closed set,
 * never the interactive siblings.
 */
export function automationSessionMcp(
  session: { automation?: string; worktreeDir?: string | null },
  sessionId: string,
): Record<string, unknown> {
  return {
    ...papercutsServerFor(
      sessionId,
      "automation",
      `${session.automation} (automation)`,
    ),
    ...(automationRunMcpForSession(session, sessionId) || {}),
    ...(selfImproveMcpForSession(session, sessionId) || {}),
  };
}

registerInteractiveMcpBuilder((sessionId, user) => {
  // Automation-owned sessions run on untrusted event/ticket text. Their runs
  // only ever carry the automation-bar set (automationSessionMcp above), but
  // this builder is also run-rpc's FALLBACK resolver for any registered run
  // token, so it must fail closed here rather than hand session-control or
  // admin tools to an automation that asks for them.
  const session = sessionId ? findSession(sessionId) : undefined;
  if (sessionId && session?.automation) {
    return automationSessionMcp(session, sessionId);
  }
  const servers = interactiveMcpServers(user, sessionId);
  const goalId = session?.goalId;
  if (goalId)
    (servers as Record<string, unknown>)["opensession-goal-self"] =
      createGoalSelfMcpServer(goalId);
  return servers;
});

// NOTE: the run-rpc unix socket and the loopback MCP HTTP listener are NOT
// started here. Registering a builder is a cheap in-memory assignment; binding
// a socket is not, and this module sits on the import chain of most of
// src/server — so a module-scope start meant any script, test or one-off bun
// process that touched that chain bound (and unlinked) the LIVE server's
// socket, killing every in-flight run's MCP calls until the heal ticker
// rebound (2026-07-16, 2026-07-17, 2026-08-16). opensession.ts calls
// startRunRpcServer() / startMcpHttpServer() explicitly instead.
