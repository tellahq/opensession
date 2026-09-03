export type SessionSource = "slack" | "linear" | "opensession" | "cli";

/**
 * Generic linkage from a session/workspace to an external object surfaced by
 * a feed (a video, eventually a Plain thread, …). `kind` matches the feed's
 * refKind; `id` is the item's stable external id. The successor to per-source
 * foreign keys like plainThreadId — see the feeds design.
 */
export interface ExternalRef {
  kind: string;
  id: string;
  url?: string;
  title?: string;
}

/**
 * Cumulative token/cost accounting for a session, updated after every run.
 * Cost is the USD price returned by the engine for each completed provider
 * message. `contextTokens` is the size of the most recent turn's full prompt
 * (input + cache read + cache creation) — the live "how full is the window"
 * number, shown against `contextWindow`.
 */
// Moved to the protocol package; re-exported for existing import sites.
export type { SessionUsage } from "@tellahq/opensession-protocol/session";
import type { SessionUsage } from "@tellahq/opensession-protocol/session";

/**
 * What the last automated (os-review) run concluded about a PR, as the UI needs
 * it: the same verdict and 1-5 confidence its PR comment ends with, plus whether
 * the branch has moved on since. Mirrored in the frontend's types.ts.
 */
export interface OsReviewSummary {
  /** approve | comment | request_changes. */
  verdict?: string;
  /** 1-5: how safe the reviewer thought this was to merge. */
  confidence?: number;
  findings: number;
  /** P0/P1 findings — what would block a merge. */
  blocking: number;
  /** The branch has moved on since this verdict — it describes older code. */
  stale: boolean;
  at: string;
}

export interface SessionSafetyState {
  status: "paused_for_safety";
  /** Plain-language explanation safe to show to every session participant. */
  explanation: string;
  automaticReconciliationRunning: boolean;
  pausedAt: string;
  operation: string;
  /** The actor found enough durable evidence for an administrator to repair
   * the session without blindly replaying an ambiguous effect. */
  repairAvailable: boolean;
}

export interface UnifiedSession {
  id: string;
  /** Source chat copied into this session before its first turn. */
  duplicatedFromSessionId?: string;
  /** Historical marker retained while old session files age out. */
  local?: boolean;
  claudeSessionId: string | null;
  source: SessionSource;
  branch: string | null;
  worktreeDir: string | null;
  /** Creator identity persisted by Open Session, or derived from the owning
   * agent session store for Slack/Linear sessions. Null when the origin does
   * not record one. Prefer this over inferring identity from title/content. */
  createdBy?: string | null;
  /** Verified GitHub login when the native session store has one. */
  createdByLogin?: string;
  /** Legacy UI-facing alias for createdBy. */
  startedBy: string | null;
  title: string;
  lastActivity: string;
  createdAt: string;
  isRunning: boolean;
  /** Present whenever the owning actor has fenced this session. Safety state
   * overrides stale engine/run projections and is never represented as running. */
  safety?: SessionSafetyState;
  /** A queued prompt is actively owned by the drain loop or its idle watcher. */
  queueOwnerActive?: boolean;
  /**
   * When the in-flight run started (ISO), for the "in progress" elapsed ticker
   * in the sidebar. Only set while isRunning; sourced from the run journal, so
   * it survives a page refresh (external CLI/tmux runs have no journal record,
   * so it's absent there and the UI falls back to a client-observed start).
   */
  runStartedAt?: string;
  /**
   * The run-state machine's view of this session (src/server/run-state.ts),
   * stamped by the session-cache enrichment. Only present when not "idle" —
   * lets the UI and session-control tools distinguish running / ask_blocked /
   * interrupted / failed without re-deriving it from busy flags. In-memory
   * (restart-fresh) by design.
   */
  runState?: string;
  /** DERIVED, never read off the session file: the mapper resolves it from the
   *  engine ids and the worktree (`resolveTranscriptPath` in sessions.ts), so a
   *  `transcriptPath` written into a session file is ignored. A test that wants
   *  a session with history writes the transcript where the derivation points
   *  (`h.writeEngineTranscript`), rather than setting this. */
  transcriptPath: string | null;
  prUrl?: string;
  prState?: "OPEN" | "MERGED" | "CLOSED";
  /** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
  prMergeable?: string;
  // Rich PR fields, populated from the batched gh pr list for the Reviews
  // table's columns (so the list never fetches per-PR).
  prNumber?: number;
  prTitle?: string;
  prIsDraft?: boolean;
  prAdditions?: number;
  prDeletions?: number;
  prChangedFiles?: number;
  prReviewDecision?: string;
  /** Person keys ("kent") of teammates with a pending review request. */
  prReviewRequested?: string[];
  /** Person keys whose latest submitted PR review stands (approved /
   *  changes requested / commented). Open PRs only. */
  prReviewedBy?: string[];
  prAuthor?: string;
  prUpdatedAt?: string;
  prChecks?: { total: number; passed: number; failed: number; pending: number };
  /** What the last automated review concluded on this PR. */
  prOsReview?: OsReviewSummary;
  mode?: "ask" | "code" | "scratch";
  /** Primary repo this session works in (registered repo id). */
  repo?: string;
  /**
   * The session has no repo, on purpose: a scratch session, or an Ask session
   * created with the repo turned off.
   *
   * A positive marker rather than `!repo`, because a missing repo is
   * ambiguous in the stored data: 2543 of the ask sessions on this instance
   * record no repo yet sit in a real checkout (the field postdates them), and
   * treating those as repo-less would drag every one of them into the Ask
   * band. Server code should still ask `sessionRepoId()`, which reads the
   * path; this field is how CLIENTS get the same answer without one.
   */
  repoLess?: boolean;
  /** Workspace this session belongs to; null/undefined = standalone. NOT a
   *  project — a project is the level above (a repo band or a feed band).
   *  See CONCEPTS.md. */
  workspaceId?: string | null;
  /** That workspace's name, stamped on the row by the sessions route so a
   *  client can title a workspace row without waiting for (or holding) the
   *  workspace list. Absent on standalone sessions. */
  workspaceName?: string;
  /** Parent/orchestrator session when spawned as a worker sub-session. */
  parentSessionId?: string;
  /** Started by a server-side agent action rather than a person's composer. */
  agentStarted?: boolean;
  /** The session whose agent created this as an internal helper. Visible
   *  create_session results omit this and stay in the user's workspaces. */
  spawnedBy?: string;
  /** The user's standing Desk (concierge) session — hidden from lists. */
  desk?: boolean;
  /** How many spawn_task hops away from a human-created session this is
   *  (opensession-sessions spawn_task loop guard: refused at depth ≥ 2). Absent =
   *  0 = created by a human or by create_session. */
  spawnDepth?: number;
  /** Secondary repos this session also works in (cross-repo sessions). */
  attachedRepos?: AttachedRepo[];
  /** The branch beneath this one when this session was stacked on another's. */
  stackedOn?: StackedOn;
  /** PRs manually linked to this session (beyond branch/attached-repo ones). */
  linkedPrs?: LinkedPr[];
  /**
   * Every PR associated with this session (primary branch + attached repos +
   * manual links), enriched from the bulk PR cache. The singular pr* fields
   * above stay the primary branch's PR for existing list/Reviews consumers.
   */
  prs?: SessionPrRef[];
  /**
   * Root-relative route the agent recorded as the place to test this change
   * (e.g. `/settings/tags`). Appended to the Preview (local dev) and Staging
   * (PR deploy) URLs so a click lands directly on the feature under test.
   */
  previewPath?: string;
  /** Agent-published demo walkthrough (opensession-walkthrough). */
  walkthrough?: SessionWalkthrough;
  /** Slack messages a teammate sent from this session. */
  slackShares?: SessionSlackShare[];
  automation?: string;
  /** Immutable trust provenance for workflow-spawned automation descendants. */
  automationDescendantPolicy?: AutomationDescendantPolicy;
  /** Total live runs in this automation. Present on the bounded sidebar list. */
  automationRunCount?: number;
  /** Stable automation id for linking back to its settings. Older sessions may
   *  only have `automation`, which the settings route also accepts by name. */
  automationId?: string;
  archived?: boolean;
  /** Why this session is archived — powers the "Auto-archived" filter. */
  archivedReason?: "manual" | "idle" | "auto" | "plain";
  /**
   * This row is a SUMMARY, not the whole session — it came from the archived
   * index (`GET /api/sessions?archived=only&slim=1`), which carries what the
   * Archived surfaces render and drops the rest. Anything that reads beyond
   * those fields must hydrate first (`GET /api/sessions/:id`). Absent on every
   * row from the full list.
   */
  slim?: boolean;
  plainThreadId?: string;
  /** Generic external-object linkage (feed items: videos, …) — the
   *  successor to per-source foreign keys like plainThreadId (see
   *  the feeds design). A session can carry several. */
  externalRefs?: ExternalRef[];
  /** Model id for runs in this session; unset = default (OPENSESSION_MODEL). */
  model?: string;
  /** Workspace model-preset instructions captured when this session was created. */
  presetNote?: string;
  /** Sticky pstack engineering mode, enabled with /pstack <task>. */
  pstackMode?: boolean;
  /** Pi reasoning variant for runs in this session; unset = model default. */
  effort?: string;
  /** Use OpenAI's priority service tier for ChatGPT OAuth Codex runs. */
  fastMode?: boolean;
  /**
   * Pinned provider account for runs in this session. The id belongs to the
   * active model's Claude or Codex pool. Unset = auto (personal-first, shared
   * pool fallback); an exhausted soft pin falls back to another eligible account.
   */
  accountId?: string;
  /** Codex thread id, when this session has run on a codex-provider model. */
  codexThreadId?: string;
  /** Pi session id (`ses_…`), when this session has run on an
   *  pi/* model. Its own slot (not the claude slot) so a migration to
   *  the pi engine keeps the claude history resumable/readable. Legacy
   *  session files from before this field may still carry a `ses_…` id in
   *  claudeSessionId — readers fall back on the id shape. */
  /** Pi engine session id (the pi session header uuid), when this session has
   *  run on a pi/* model. Own slot, no legacy mirror — nothing pre-pi ever
   *  read a pi id, so there is no compat ride to keep. */
  piSessionId?: string;
  /** Provider whose engine last drove a run — lets the next run detect an
   *  in-place cross-provider switch and bridge context. */
  lastEngineProvider?: "claude" | "codex" | "pi";
  /** Model that last actually drove a run. Anthropic and OpenAI models both
   *  report provider "pi", so provider alone can't detect a family
   *  switch (which lands on another server as a fresh engine session and
   *  needs a transcript bridge) — this can. */
  lastEngineModel?: string;
  /** /model switches, newest last — rendered as dividers in the conversation.
   *  `from` is the model in effect before the switch (for a "X → Y" divider). */
  modelHistory?: Array<{
    model: string;
    from?: string;
    at: string;
    by?: string;
  }>;
  /** Cumulative token/cost accounting for this session's runs. */
  usage?: SessionUsage;
  goal?: string;
  /** Goal record id, when this session is driven by a Goal (src/server/goals.ts). */
  goalId?: string;
  /**
   * The session's last run died on a terminal failure (usage limits exhausted
   * on every account, credit/API errors) — a human must act before the session
   * can continue, so the UI surfaces it as "Needs input" instead of Backlog.
   * Cleared by the next run that ends cleanly.
   */
  lastRunError?: { message: string; at: string };
  /**
   * Manual sidebar-lane override (Needs input / In progress / In review / Done /
   * Backlog). When set it wins over the derived lane in the sidebar, letting a
   * human pin a session where they want it. Set from the status-override
   * registry in getAllSessions; unset = derive the lane as usual.
   */
  manualStatus?: "needsinput" | "inprogress" | "review" | "merged" | "pending";
  /**
   * True when `title` is a manual rename (title-override registry) rather than
   * a derived/generated one. The sidebar names shared-worktree rows after the
   * branch because generated titles drift — a manual rename is explicit user
   * intent and should win there too.
   */
  titleOverridden?: boolean;
  /**
   * A pending "please review this" pointed at a teammate, set from the info
   * panel's Reviewer picker. Surfaces the session in a "Needs review" band at
   * the top of the reviewer's sidebar. Set from the review-request registry in
   * getAllSessions; cleared by picking "No reviewer" (or re-assigning).
   */
  reviewRequest?: {
    to: string;
    recipients?: string[];
    by: string;
    at: string;
    accepted?: { by: string; at: string };
  };
  loop?: {
    prompt: string;
    intervalMinutes: number;
    lastRunAt?: string;
    setBy?: string;
  };
  // Other IDs that resolve to this session. The same Claude session can be
  // tracked by multiple files (e.g. a Slack run writes both <branch>.json and
  // <channel>-<threadTs>.json) and external deep links may use any of them.
  aliasIds?: string[];
  /** Slack threads this session posted to (automation runs capture their own
   *  posts here) — a reply in one of these threads drives THIS session instead
   *  of starting a new one (thread index in slack-links.ts). */
  slackThreads?: Array<{ channel: string; threadTs: string }>;
  // Source-specific
  linearIssue?: { identifier: string; title: string; url?: string };
  slackThread?: { channel: string; threadTs: string };
  /** The MCP allowlist this session was created with, copied from its file.
   *  Read by `sessionMcpScopeSource` (session-run-inputs.ts) as the "session"
   *  scope; absent or empty means the run sees every server the prompter may. */
  mcpServers?: string[];
  /** Sandbox opt-in (see docs/self-hosting-sandboxes.md): mirrors the session file's field.
   *  Runs route through the named provider when config + kill-switch allow;
   *  `sandboxId` is set once a provider materializes the sandbox (Phase 1+).
   *  `workspace` records how the workspace was materialized: "volume" means it
   *  lives ONLY inside the sandbox (no host worktree — Phase 2). */
  sandbox?: {
    provider: string;
    sandboxId?: string;
    workspace?: "bind" | "volume";
    /** Provider-neutral compute lifecycle. The transcript and queue stay live
     * while this moves between states. */
    lifecycle?:
      | "preparing"
      | "awake"
      | "sleeping"
      | "waking"
      | "needs_attention";
    lastLifecycleError?: string;
  };
  /** Persistent, explicitly trusted machine selected for this session. Unlike
   * a Sandbox, a Runner is not an isolation boundary. */
  runner?: {
    id: string;
    name: string;
    workspacePath: string;
    lifecycle?: "preparing" | "awake" | "offline" | "needs_attention";
    lastLifecycleError?: string;
  };
}

// Slack session file format (two variants exist). This is the one record type
// for a Slack session: the loop's in-memory shape (SlackSession in
// src/agents/slack/state.ts) narrows it to the fields the loop always has.
// saveSession merges over whatever is already on disk rather than projecting a
// fixed field list, so keys written by other writers survive a write.
export interface SlackSessionFile {
  branch?: string | null;
  userId?: string;
  message?: string;
  /** Provisional session name: the first line of the Slack message that
   *  started it. The generated summary title replaces it in the UI ~15s later
   *  (generated-titles.ts); without it the session wears its raw
   *  `<channel>-<threadTs>` key until then, which is what scanSlackSessions
   *  falls back to. */
  title?: string;
  worktreeDir?: string | null;
  claudeSessionId?: string | null;
  createdAt?: string;
  lastActivity?: string;
  channel?: string;
  threadTs?: string;
  model?: string;
  codexThreadId?: string | null;
  /** Registered repo id this session works in; unset/null = the default repo
   *  (the instance default repo), which is the historical shape, so old session files stay
   *  valid. */
  repoId?: string | null;
  /** Pi engine session id, written by agent-session-sync for pi/* runs (its
   *  own slot — pi uuids are shape-indistinguishable from claude ids, so the
   *  claude slot can't carry them unambiguously; a claude-slot mirror rides
   *  along for the owning loop's resume path). */
  piSessionId?: string | null;
}

// Linear session file format
export interface LinearSessionFile {
  branch: string;
  claudeSessionId: string | null;
  issueIdentifier?: string;
  issueTitle?: string;
  worktreeDir?: string;
  linearSessionId?: string;
  issueId?: string;
  issueUrl?: string;
  participants?: Array<{ id: string; name: string; email: string | null }>;
  lastActiveUser?: { id: string; name: string; email: string | null } | null;
  updatedAt?: string;
  model?: string;
  /** Pi engine session id (see SlackSessionFile.piSessionId). */
  piSessionId?: string | null;
}

// CLI session file format (~/.claude/sessions/*.json)
export interface CLISessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

// Open Session session file format
/**
 * A secondary repo attached to a session for cross-repo work. Each gets its own
 * isolated worktree (never the shared main checkout), so the agent can branch,
 * commit, and open a PR there independently of the primary repo.
 */
export interface AttachedRepo {
  repo: string; // repo id (key in worktree.ts REPOS)
  branch: string;
  dir: string; // worktree path
}

/**
 * The branch a stacked session was cut from — the layer directly beneath it.
 * Recorded at worktree creation, when we still know which session we branched
 * off; `baseRefName` on the PR can't stand in for it, because GitHub rebases
 * a stack's bases as lower layers merge.
 */
export interface StackedOn {
  repo: string; // repo id
  branch: string; // the parent layer's branch
  sessionId?: string; // the session that owns that branch, when it is one of ours
}

/**
 * A pull request manually linked to a session, beyond the ones derived from
 * its own branch (primary repo) and attached repos. Keyed by repo+branch —
 * the whole PR pipeline (pr-info, the bulk PR cache) is branch-keyed — with
 * number/url/title stored as a fallback label for repos outside the PR cache.
 */
export interface LinkedPr {
  repo: string; // repo id (key in worktree.ts REPOS)
  branch: string; // the PR's head branch
  number?: number;
  url?: string;
  title?: string;
}

/**
 * One PR associated with a session, resolved at list time: the primary
 * branch's PR, an attached repo's PR, or a manually linked one. Enriched from
 * the bulk PR cache when covered; a linked PR outside the cache keeps its
 * stored url/number/title with no live state.
 */
export interface SessionPrRef {
  repo: string;
  branch: string;
  /** How the session came to own this PR. "discovered" = found via the session
   *  link in the PR body's attribution footer, for PRs the agent opened on a
   *  branch the session doesn't own (see sessionRefFromPrBody). */
  source: "primary" | "attached" | "linked" | "discovered";
  url?: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  number?: number;
  title?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  /** MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe. */
  mergeable?: string;
  additions?: number;
  deletions?: number;
  checks?: { total: number; passed: number; failed: number; pending: number };
}

/** One before/after screenshot pair in a session walkthrough. Paths are
 *  absolute, under the walkthrough uploads dir (staged copies — never the
 *  agent's worktree/tmp originals, which vanish when the worktree is pruned). */
export interface WalkthroughShot {
  before?: string;
  after?: string;
  caption?: string;
}

/**
 * A Cursor-style PR walkthrough the agent publishes when it finishes a
 * user-visible change: a short demo video, before/after screenshots, and a
 * writeup. Rendered inline in the session's Review tab and mirrored into the
 * GitHub PR description (video + images as instance links there — the
 * server is tailnet-only, so GitHub's camo proxy can't inline them).
 */
export interface SessionWalkthrough {
  /** Markdown writeup: what changed, root cause, how it was verified. */
  summary: string;
  /** Absolute path to the staged demo video (mp4/webm/mov), if any. */
  video?: string;
  videoTitle?: string;
  shots?: WalkthroughShot[];
  publishedAt: string;
  publishedBy?: string;
  /** Transcript entry of the `publish_walkthrough` call that produced this —
   *  the card renders directly after that turn. Absent on walkthroughs
   *  published before this was recorded (and on engines whose transcript the
   *  v2 store never saw), which is what the viewer's timestamp fallback is
   *  for. */
  publishedEntryId?: string;
}

/**
 * A Slack message sent from this session, kept so the composer that sent it
 * collapses into a receipt instead of offering to send the same update again.
 */
export interface SessionSlackShare {
  channelId: string;
  channelName: string;
  /** Link to the message. Absent when Slack didn't return one. */
  permalink?: string;
  at: string;
  by?: string;
  /** The merged PR this share announced, for the in-transcript share card. */
  prNumber?: number;
  /** Message timestamp. Undo needs it, and Slack only returns it sometimes. */
  ts?: string;
  /** Receipt to drop on undo, so the same update can be shared again. */
  announcementKey?: string;
}

export interface AutomationDescendantPolicy {
  automationId: string;
  automationName: string;
  /** Immutable launch-time scope. Empty stays empty on every later turn. */
  mcpServers: string[];
  repo: string;
  publicationRepo: string;
  baseBranch: string;
  allowedRunners: string[];
  publication: "branch-pr-only";
}

export interface NativeSessionFile {
  id: string;
  /** Source chat copied into this session before its first turn. */
  duplicatedFromSessionId?: string;
  claudeSessionId: string;
  branch: string;
  worktreeDir: string;
  /** Secondary repos this session also works in (cross-repo sessions). */
  attachedRepos?: AttachedRepo[];
  /** PRs manually linked to this session (beyond branch/attached-repo ones). */
  linkedPrs?: LinkedPr[];
  /** Root-relative route the session opens by default, set through
   * opensession-portals. Unset = open the app root. */
  previewPath?: string;
  /** Agent-published demo walkthrough (opensession-walkthrough). */
  walkthrough?: SessionWalkthrough;
  /** Slack messages a teammate sent from this session. */
  slackShares?: SessionSlackShare[];
  createdBy: string;
  /** Verified GitHub login of the creator — stamped when GitHub web sign-in
   *  is active (web-auth.ts), and backfilled onto older sessions by the
   *  one-time boot migration (resolved from createdBy via the identity
   *  table). Absent on automation sessions and unresolvable creators. */
  createdByLogin?: string;
  createdAt: string;
  lastActivity: string;
  title?: string;
  mode?: "ask" | "code" | "scratch";
  repo?: string; // which registered repo this session works in
  /** Deliberately repo-less (scratch, or Ask with the repo turned off). See
   *  the note on UnifiedSession.repoLess for why this is stored rather than
   *  derived from a missing `repo`. */
  repoLess?: boolean;
  workspaceId?: string | null; // Workspace this session belongs to
  /** The branch this session's worktree was cut from, when it was stacked on
   *  another session's branch rather than on the trunk. Drives the stacked-PR
   *  base (`gh pr create --base`) and the "link this stack" action. */
  stackedOn?: StackedOn;
  /** Parent/orchestrator session when this session was spawned as a visible worker sub-session. */
  parentSessionId?: string;
  /** Started by a server-side agent action rather than a person's composer. */
  agentStarted?: boolean;
  /** The session whose agent created this as an internal helper (see
   *  UnifiedSession.spawnedBy). Visible create_session results omit it. */
  spawnedBy?: string;
  /** The user's standing Desk (concierge) session — fixed title, suppressed
   *  from the session lists, opened via the Desk overlay. */
  desk?: boolean;
  /** spawn_task hop count from a human-created session (loop guard; see
   *  UnifiedSession.spawnDepth). Stamped by opensession-sessions' spawn_task. */
  spawnDepth?: number;
  /** This session was opened as a worker that owes its parent a report
   *  (spawn_task, or create_session without reportBack:false). */
  reportBack?: boolean;
  /** When this worker last reported back to its parent (send_to_session to
   *  parentSessionId). Suppresses the failure beacon: a worker that already
   *  said its piece doesn't need the server saying it again. */
  lastReportToParentAt?: string;
  /** When the server last told this worker's parent that a run died here
   *  (handoff-evidence beacon) — throttles repeats. */
  parentNotifiedAt?: string;
  automation?: string; // name of the automation that created this session
  automationId?: string; // id of that automation — lets a Slack thread reply "retrigger" re-fire it
  /** Immutable trust provenance for workflow-spawned automation descendants. */
  automationDescendantPolicy?: AutomationDescendantPolicy;
  /** The triggering event payload of the automation run that created this
   *  session (truncated like the prompt embed). A "retrigger" replays the
   *  automation with this exact payload. */
  automationEvent?: string;

  plainThreadId?: string; // Plain thread this session is triaging
  externalRefs?: ExternalRef[]; // generic feed-item linkage (the feeds design)
  model?: string; // model id for this session's runs; unset = default
  /** Original selection displaced by an automatic usage fallback. `null` means
   *  the session inherited the instance default; retried on the next prompt. */
  autoFallbackModel?: string | null;
  /** Workspace model-preset instructions captured when this session was created. */
  presetNote?: string;
  pstackMode?: boolean; // sticky pstack engineering mode, toggled with /pstack or /poteto-mode
  effort?: string; // Pi reasoning variant for this session's runs; unset = model default
  fastMode?: boolean; // OpenAI priority service tier for ChatGPT OAuth Codex runs
  accountId?: string; // pinned Claude/Codex provider account; unset = auto pool
  codexThreadId?: string; // codex thread id once the session has run on a codex model
  piSessionId?: string; // pi engine session id (uuid) once the session has run on a pi/* model
  /** Provider whose engine last actually drove a run in this session. Lets the
   *  next run detect an in-place cross-provider switch (Claude↔Codex) and hand
   *  the incoming engine a transcript bridge so context carries over. */
  lastEngineProvider?: "claude" | "codex" | "pi";
  lastEngineModel?: string; // model that last drove a run (family-switch detection)
  modelHistory?: Array<{
    model: string;
    from?: string;
    at: string;
    by?: string;
  }>;
  usage?: SessionUsage; // cumulative token/cost accounting for this session's runs
  /** Most recent run folded into usage. Internal recovery idempotency marker;
   *  omitted from UnifiedSession and every client payload. */
  usageRunId?: string;
  archived?: boolean;
  archivedAt?: string;
  archivedReason?: "manual" | "idle" | "auto" | "plain";
  goal?: string; // pinned goal, appended to every prompt until cleared
  goalId?: string; // Goal record this session is driven by (src/server/goals.ts)
  lastRunError?: { message: string; at: string }; // last run died on a terminal error; cleared on the next clean run
  loop?: {
    prompt: string;
    intervalMinutes: number;
    lastRunAt?: string;
    setBy?: string;
  };
  /** Slack threads this session posted to (see UnifiedSession.slackThreads). */
  slackThreads?: Array<{ channel: string; threadTs: string }>;
  mcpServers?: string[]; // External MCP servers to load for this session; empty = none (minimal context)
  /** Sandbox opt-in (see docs/self-hosting-sandboxes.md): recorded at create time when the
   *  creator asked for a sandbox. `provider` is the effective provider id at
   *  creation ("local" until a real provider is configured); `sandboxId` is
   *  set once a provider materializes a sandbox for the session (Phase 1+);
   *  `workspace` records the materialized mode — "volume" workspaces live only
   *  inside the sandbox (no host worktree; Phase 2). */
  sandbox?: {
    provider: string;
    sandboxId?: string;
    workspace?: "bind" | "volume";
    lifecycle?:
      | "preparing"
      | "awake"
      | "sleeping"
      | "waking"
      | "needs_attention";
    lastLifecycleError?: string;
  };
  runner?: {
    id: string;
    name: string;
    workspacePath: string;
    lifecycle?: "preparing" | "awake" | "offline" | "needs_attention";
    lastLifecycleError?: string;
  };
}

// Moved to the protocol package; re-exported for existing import sites.
export type { TranscriptEntry } from "@tellahq/opensession-protocol/session";

export interface FileWatcherState {
  path: string;
  lastMtime: number;
  lastByteOffset: number;
  viewers: Set<any>;
}
