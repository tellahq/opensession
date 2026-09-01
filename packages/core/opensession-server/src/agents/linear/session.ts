/**
 * Linear agent session lifecycle and the headless agent runner.
 */
import { STRIPE_CONFIRM_TOOLS } from "../../server/runner-shared";
import { shouldPersistModelSwitch } from "../../server/run-events";
import { runAgent, cancelAgentRun } from "../../server/agent-runner";
import {
  configuredServer,
  defaultRepo,
  personaName,
  productName,
} from "../../server/config";
import { getDefaultModel, toPiModel } from "../../server/models";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import {
  createWorktree as createRepoWorktree,
  removeWorktree,
} from "../../server/worktree";
import { unlinkSync } from "fs";
import { homeDir } from "../../server/paths";
import {
  gitIdentityFor,
  gitIdentityEnv,
} from "../../server/shared/user-mappings";
import { createAgentActivity } from "./api";
import type { LinearTokens } from "./oauth";
import { getValidToken } from "./oauth";

const SESSION_DIR = `${process.env.HOME}/.linear-sessions`;

/** Sessions with no activity for this long aren't restored on startup. */
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

// --- Types ---

export interface Participant {
  id: string;
  name: string;
  email: string | null;
}

const PHASES = [
  "awaiting_direction",
  "planning",
  "awaiting_implementation",
  "working",
] as const;

/**
 * Where a session is in its lifecycle. One value at a time, so a combination
 * the previous three booleans could express but no code path meant, such as
 * "awaiting direction while planning", is now unrepresentable.
 */
export type SessionPhase = (typeof PHASES)[number];

/**
 * The fields kept in `<branch>.json`. Saves take a Partial of this and
 * startup hydration spreads the whole record into the live session, so every
 * field the save writes is read back by construction.
 */
export interface StoredSession {
  branch: string;
  claudeSessionId: string | null;
  issueIdentifier: string;
  issueTitle: string;
  worktreeDir: string;
  /** "" when the file predates the Linear agent-session id being recorded. */
  linearSessionId: string;
  phase: SessionPhase;
  issueId: string;
  issueUrl: string;
  participants: Participant[];
  lastActiveUser: Participant | null;
  issueCreator: Participant | null;
  /** Model id for this session's runs (from the session file); unset = default. */
  model?: string;
  updatedAt?: string;
}

/** A stored session plus the parts that only exist while the process runs. */
export interface ActiveSession extends StoredSession {
  accessToken: string;
  issueDescription: string;
  teamId: string;
  abortController?: AbortController;
  planningConversation: Array<{
    role: "agent" | "user";
    content: string;
    timestamp: string;
  }>;
}

/** In-memory active sessions: linearSessionId -> ActiveSession */
export const activeSessions = new Map<string, ActiveSession>();

/** Dedup set for webhook sessions */
export const processedSessions = new Set<string>();

// --- Utilities ---

export function extractPrUrl(result: string): string | null {
  const prUrlMatch = result.match(
    /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/,
  );
  return prUrlMatch ? prUrlMatch[0] : null;
}

export function formatConversationHistory(
  conversation: Array<{
    role: "agent" | "user";
    content: string;
    timestamp: string;
  }>,
): string {
  if (conversation.length === 0) return "";
  return conversation
    .map(
      (msg) =>
        `**${msg.role === "user" ? "User" : personaName()}:** ${msg.content}`,
    )
    .join("\n\n");
}

export function buildParticipantSections(
  participants: Participant[],
  lastActiveUser: Participant | null,
): { participantsSection: string; coAuthorInstruction: string } {
  let participantsSection = "";
  let coAuthorInstruction = "";

  if (participants.length > 0) {
    const names = participants.map((p) => p.name).join(", ");
    participantsSection = `\n**Requested by:** ${names} (via Linear)\n`;
  }

  if (lastActiveUser) {
    const email =
      lastActiveUser.email || `${lastActiveUser.id}@users.linear.app`;
    coAuthorInstruction = `IMPORTANT: When creating commits, include this Co-Authored-By line:
Co-Authored-By: ${lastActiveUser.name} <${email}>`;
  }

  return { participantsSection, coAuthorInstruction };
}

// --- Branch & Worktree ---

export function generateBranchName(
  title: string,
  issueIdentifier?: string,
): string {
  // Heuristic: take first 1-2 words from title, lowercased, hyphen-separated, no special chars
  // Avoids a full Haiku query just for a branch name.
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .split(/\s+/) // Split on whitespace
    .filter((w) => w.length > 0) // Remove empty strings
    .slice(0, 2) // Take first 2 words
    .join("-") // Hyphenate
    .slice(0, 30); // Max 30 chars

  let branch = words || "task";

  if (issueIdentifier) {
    const suffix = issueIdentifier.toLowerCase().replace(/[^a-z0-9]/g, "");
    branch = `${branch}-${suffix}`;
  }

  return branch;
}

export async function createWorktree(
  branch: string,
  _ticketId: string,
  _title: string,
  _description: string,
  _url: string,
): Promise<string> {
  const worktreeDir = await createRepoWorktree(branch, defaultRepo().id);
  console.log(`[linear] Created worktree: ${branch}`);
  return worktreeDir;
}

// --- Session persistence ---

/** A blank record, so a partial save always has every field to merge onto. */
function emptyStored(branch: string): StoredSession {
  return {
    branch,
    claudeSessionId: null,
    issueIdentifier: "",
    issueTitle: "",
    worktreeDir: "",
    linearSessionId: "",
    phase: "working",
    issueId: "",
    issueUrl: "",
    participants: [],
    lastActiveUser: null,
    issueCreator: null,
  };
}

/**
 * Read one session file, migrating files written before `phase` replaced the
 * three booleans. `awaitingInitialDirection` was only ever written as true and
 * never cleared, so on those files it means "awaiting direction" only while
 * there is no engine session id: once a turn has run, direction was given.
 */
function storedFromFile(
  branch: string,
  raw: Record<string, any>,
): StoredSession {
  const claudeSessionId = raw.claudeSessionId ?? null;
  const phase: SessionPhase = (PHASES as readonly string[]).includes(raw.phase)
    ? raw.phase
    : raw.awaitingInitialDirection && !claudeSessionId
      ? "awaiting_direction"
      : raw.awaitingImplementationConfirmation
        ? "awaiting_implementation"
        : "working";

  return {
    branch,
    claudeSessionId,
    issueIdentifier: raw.issueIdentifier ?? "",
    issueTitle: raw.issueTitle ?? "",
    worktreeDir: raw.worktreeDir ?? "",
    linearSessionId: raw.linearSessionId ?? "",
    phase,
    issueId: raw.issueId ?? "",
    issueUrl: raw.issueUrl ?? "",
    participants: raw.participants ?? [],
    lastActiveUser: raw.lastActiveUser ?? null,
    issueCreator: raw.issueCreator ?? null,
    model: raw.model ?? undefined,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Merge a patch over the stored session: named fields move, everything else
 * keeps what is on disk. A key left out (or explicitly undefined) is a
 * deliberate "keep the stored value", not a miscounted argument slot.
 */
export async function saveSessionInfo(
  branch: string,
  patch: Partial<StoredSession>,
): Promise<void> {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<StoredSession>;

  const existing = await loadSessionInfo(branch);
  const data: StoredSession = {
    ...emptyStored(branch),
    ...(existing || {}),
    ...defined,
    branch,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(`${SESSION_DIR}/${branch}.json`, data);
}

export async function loadSessionInfo(
  branch: string,
): Promise<StoredSession | null> {
  try {
    const file = Bun.file(`${SESSION_DIR}/${branch}.json`);
    if (await file.exists()) {
      return storedFromFile(branch, JSON.parse(await file.text()));
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteSessionFile(branch: string): void {
  try {
    unlinkSync(`${SESSION_DIR}/${branch}.json`);
    console.log(`[linear] Deleted session file: ${SESSION_DIR}/${branch}.json`);
  } catch {
    // File might not exist
  }
}

export function deleteWorktree(branch: string): void {
  void removeWorktree(branch, defaultRepo().id);
  console.log(`[linear] Deleted worktree: ${branch}`);
}

// --- Action activity streaming ---

/** Base URL of the Open Session web UI, linked from Linear sessions. */
export const OPENSESSION_UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

export function opensessionSessionUrl(branch: string): string {
  return `${OPENSESSION_UI_BASE}/session/${encodeURIComponent(`linear-${branch}`)}`;
}

/** Compact action row for a tool call: { action: "Read", parameter: "src/foo.ts" }. */
function summarizeAction(
  name: string,
  input: any,
): { action: string; parameter: string } {
  const inp = input || {};
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    return {
      action: mcp[1],
      parameter: `${mcp[2]} ${clip(JSON.stringify(inp))}`.trim(),
    };
  }
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return { action: name, parameter: inp.file_path || "" };
    case "Bash":
      return {
        action: "Ran",
        parameter: clip((inp.command || "").split("\n")[0]),
      };
    case "Grep":
      return {
        action: "Searched",
        parameter: clip(`${inp.pattern || ""} ${inp.path || inp.glob || ""}`),
      };
    case "Glob":
      return {
        action: "Globbed",
        parameter: clip(`${inp.pattern || ""} ${inp.path || ""}`),
      };
    case "Task":
    case "Agent":
      return {
        action: "Spawned agent",
        parameter: clip(inp.description || inp.subagent_type || ""),
      };
    case "WebFetch":
      return { action: "Fetched", parameter: clip(inp.url || "") };
    case "WebSearch":
      return { action: "Searched web", parameter: clip(inp.query || "") };
    case "Skill":
      return { action: "Skill", parameter: clip(inp.skill || "") };
    default:
      return { action: name, parameter: clip(JSON.stringify(inp)) };
  }
}

function clip(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const ACTION_MIN_GAP_MS = 2000;

/**
 * Coalescing sender for action activities: tool bursts post at most one
 * activity per ACTION_MIN_GAP_MS (latest wins, trailing flush) so a busy run
 * doesn't flood the Linear timeline or the API. The full log stays in the
 * web UI; this is a progress feed.
 */
function makeActionStreamer(accessToken: string, linearSessionId: string) {
  let lastSent = 0;
  let pending: { action: string; parameter: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const post = (a: { action: string; parameter: string }) => {
    createAgentActivity(accessToken, linearSessionId, {
      type: "action",
      ...a,
    }).catch((e) => console.error("[linear] Failed to send action:", e));
  };

  return {
    send(toolName: string, input: unknown) {
      const a = summarizeAction(toolName, input);
      const now = Date.now();
      if (now - lastSent >= ACTION_MIN_GAP_MS) {
        lastSent = now;
        post(a);
        return;
      }
      pending = a;
      if (!timer) {
        timer = setTimeout(
          () => {
            timer = null;
            if (pending) {
              lastSent = Date.now();
              post(pending);
              pending = null;
            }
          },
          ACTION_MIN_GAP_MS - (now - lastSent),
        );
      }
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

// --- Headless agent runner (pi engine) ---

export async function runAgentHeadless(
  worktreeDir: string,
  prompt: string,
  linearSessionId: string,
  accessToken: string,
  resumeClaudeId?: string,
  session?: ActiveSession,
): Promise<{ result: string; claudeSessionId: string }> {
  console.log(
    `[linear] Running agent in ${worktreeDir}${resumeClaudeId ? ` (resuming ${resumeClaudeId})` : ""}`,
  );

  // Attribute commits this run makes to the Linear issue creator.
  const commitAuthor = gitIdentityFor(session?.issueCreator?.email);

  // Kept as the loop's stop signal (linear/index.ts + handlers abort it):
  // aborting hard-cancels the engine run by its session id and exits the loop.
  const abortController = new AbortController();
  if (session) {
    session.abortController = abortController;
  }

  let result = "";
  let claudeSessionId = resumeClaudeId || "";
  let lastThoughtTime = 0;
  const THOUGHT_THROTTLE_MS = 5000;
  const actions = makeActionStreamer(accessToken, linearSessionId);

  // The issue actor (last prompting user, else the issue creator): gates
  // per-user `allowedUsers` MCP servers and drives the personal-first
  // subscription pick inside the engine. Account rotation and usage-limit
  // model fallback are runAgent's job now — no rotation loop here.
  const actorEmail =
    session?.lastActiveUser?.email || session?.issueCreator?.email || undefined;

  abortController.signal.addEventListener("abort", () => {
    void cancelAgentRun(claudeSessionId);
  });

  try {
    for await (const event of runAgent({
      // Interactive Linear sessions get the full connector set, as before.
      mcpServers: "all",
      prompt,
      sessionId: claudeSessionId || undefined,
      cwd: worktreeDir,
      mode: "code",
      model: toPiModel(session?.model || getDefaultModel()),
      user: actorEmail,
      author: commitAuthor,
      // Teammate-driven runs keep AWS read access — also keeps the shared
      // run environment identical across interactive kinds (a mixed
      // aws/non-aws env would drain-respawn the server on every alternation).
      aws: true,
      // Kind-only journal: gate marker for the pi engine, no crash
      // journal — this loop tracks its own engine session ids per Linear
      // session and re-drives turns from Linear events.
      journal: { kind: "linear" },
      // Transcript v2: key this run's store appends on the unified session id
      // the UI knows this session by (sessions.ts scanLinearSessions:
      // `linear-<branch>`). Map-only — journal/resume/run-state semantics are
      // untouched (see RunAgentOpts.transcriptSessionId).
      transcriptSessionId: session?.branch
        ? `linear-${session.branch}`
        : undefined,
      // Money-moving Stripe tools need the per-call human confirmation the
      // interactive runner provides; this path has no approval card, so they
      // are stripped from the tool list with this guidance.
      deniedTools: Object.fromEntries(
        Object.keys(STRIPE_CONFIRM_TOOLS).map((name) => [
          name,
          `This Stripe action requires human confirmation — open this session in ${productName()} and retry there; the approval card will appear in that UI.`,
        ]),
      ),
    })) {
      if (abortController.signal.aborted) break;

      if (event.type === "init") {
        claudeSessionId = event.sessionId || claudeSessionId;
      }

      // Stream tool calls (coalesced actions) and thoughts (throttled;
      // text_chunk carries whole completed text parts) to Linear.
      if (event.type === "tool_use" && event.toolName) {
        actions.send(event.toolName, event.toolInput);
      }
      if (event.type === "text_chunk" && event.text && event.text.length > 20) {
        const now = Date.now();
        if (now - lastThoughtTime > THOUGHT_THROTTLE_MS) {
          lastThoughtTime = now;
          createAgentActivity(accessToken, linearSessionId, {
            type: "thought",
            body: event.text.substring(0, 2000),
          }).catch((e) => console.error("[linear] Failed to send thought:", e));
        }
      }
      if (event.type === "model_switch") {
        const durable = shouldPersistModelSwitch(event);
        if (durable && event.toModel && session) session.model = event.toModel;
        createAgentActivity(accessToken, linearSessionId, {
          type: "thought",
          body: durable
            ? `${event.fromModel} is out of usage — continuing this turn on ${event.toModel}. Worktree state carries over.`
            : `${event.fromModel} ${event.switchReason || "fell back"} — using ${event.toModel} for this turn only. Worktree state carries over.`,
        }).catch(() => {});
      }

      if (event.type === "done") {
        claudeSessionId = event.sessionId || claudeSessionId;
        result = event.result || "";
        console.log(`[linear] Agent finished. Session ID: ${claudeSessionId}`);
      }
      if (event.type === "error") {
        result = `Error: ${event.content || "Unknown"}`;
      }
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      console.error(`[linear] agent run error:`, e);
      result = `Error: ${e.message || String(e)}`;
    }
  }

  if (session) {
    session.abortController = undefined;
  }
  actions.stop();
  return { result, claudeSessionId };
}

// --- PR creation ---

export async function createPrWithAttribution(
  worktreeDir: string,
  issueIdentifier: string,
  issueUrl: string,
  issueTitle: string,
  participants: Participant[],
  reviewer?: string | null,
): Promise<string | null> {
  let participantsLine = "";
  if (participants.length > 0) {
    const names = participants.map((p) => p.name).join(", ");
    participantsLine =
      participants.length === 1
        ? `**Requested by:** ${names} (via Linear)`
        : `**Participants:** ${names} (via Linear)`;
  }

  const prBody = `## Summary
Implements ${issueIdentifier}: ${issueTitle}

${issueUrl}
${participantsLine ? `\n${participantsLine}\n` : ""}
## Test plan
- [ ] Verify implementation meets acceptance criteria

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

  try {
    const args = [
      "gh",
      "pr",
      "create",
      "--title",
      `${issueIdentifier}: ${issueTitle}`,
      "--body",
      prBody,
    ];
    if (reviewer) {
      args.push("--reviewer", reviewer);
    }
    const proc = Bun.spawn(args, {
      cwd: worktreeDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${homeDir()}/.cargo/bin:${homeDir()}/.bun/bin:${homeDir()}/.local/bin:${homeDir()}/bin:${homeDir()}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        HOME: homeDir(),
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`[linear] Failed to create PR: ${stderr}`);
      return null;
    }

    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
    return urlMatch ? urlMatch[0] : output.trim();
  } catch (e) {
    console.error(`[linear] Error creating PR: ${e}`);
    return null;
  }
}

// --- Startup ---

export async function loadActiveSessionsOnStartup(
  tokens: LinearTokens,
): Promise<void> {
  console.log("[linear] Loading active sessions from disk...");

  try {
    const { readdirSync } = await import("fs");
    const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));

    // Single-workspace install: every session belongs to the one authorized org.
    const orgId = Object.keys(tokens)[0];
    if (!orgId) return;
    const accessToken = await getValidToken(orgId, tokens);
    if (!accessToken) return;

    let skippedStale = 0;
    for (const file of files) {
      try {
        const branch = file.replace(".json", "");
        const stored = await loadSessionInfo(branch);

        if (
          stored &&
          stored.linearSessionId &&
          (stored.claudeSessionId || stored.phase === "awaiting_direction")
        ) {
          // Don't resurrect long-idle sessions — a week without a run means the
          // ticket moved on without us; the file stays on disk for manual resume.
          const updatedAt = Date.parse(stored.updatedAt || "");
          if (!updatedAt || Date.now() - updatedAt > STALE_SESSION_MS) {
            skippedStale++;
            continue;
          }

          // Spreading the stored record hydrates every persisted field,
          // including any added later; only the run-time-only parts are
          // supplied here.
          const session: ActiveSession = {
            ...stored,
            accessToken,
            issueDescription: "",
            teamId: "",
            planningConversation: [],
          };

          activeSessions.set(stored.linearSessionId, session);

          console.log(
            `[linear] Restored session: ${branch} (Claude: ${stored.claudeSessionId}, Linear: ${stored.linearSessionId})`,
          );
        }
      } catch (e) {
        console.error(`[linear] Error loading session ${file}:`, e);
      }
    }
    if (skippedStale > 0) {
      console.log(
        `[linear] Skipped ${skippedStale} stale session file(s) (idle > 7 days)`,
      );
    }
  } catch {
    console.log("[linear] No active sessions to load");
  }
}
