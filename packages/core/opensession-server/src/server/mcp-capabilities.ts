/**
 * Lightweight metadata for Open Session's in-process MCP servers.
 *
 * This module must stay dependency-free. The runtime prompt builder imports it,
 * while mcp-catalog.ts imports every real server factory for docs and wiring
 * checks. Keeping the shared names and summaries here lets the prompt describe
 * the live capability set without pulling that factory graph into every run.
 *
 * Every MCP tool sits behind mcp_search, so a run can only find a tool it
 * already knows to look for. The guidance below is that knowledge: it is
 * rendered into the run prompt for each mounted server (see
 * renderInternalMcpCapabilities), and it is the one place a new tool has to
 * announce itself. It was dropped from the prompt in ae4df8f32 and
 * suggest_task then went unused for weeks because no run knew it existed.
 */

export interface InternalMcpCapability {
  /** One-line catalog description used in generated docs. */
  summary: string;
  /** When to reach for this server, rendered into the run prompt whenever
   *  the server is mounted. Name the tools a run must know about unprompted;
   *  a schema can be looked up, an intention cannot. */
  guidance: string;
}

export const INTERNAL_MCP_CAPABILITIES = {
  "opensession-sessions": {
    summary: "See and steer other sessions, and spawn worker sessions.",
    // create_session is admin-only; the humanResume and automationSelf shapes
    // mount spawn_task instead, and this text is shared, so it names both.
    // suggest_task is a drive-by channel. Follow-ups to the current work
    // used to land there too, which flooded threads with cards for things
    // the same session would have picked up anyway; those stay in the reply.
    guidance:
      "Create, inspect, steer, or cancel visible sessions and worker tasks. A request for a new session means a top-level one: `create_session` with `standalone: true` (or `spawn_task` where that is the only one offered), not a child or in-process worker, unless a child, worker, or sub-session is explicitly asked for. `suggest_task` is only for a drive-by finding: self-contained work unrelated to the current request that this session will not pick up (a bug seen on the way). Follow-ups and next steps go in your reply as a plain suggestion so the person decides. Suggest each at most once; do not start it. After `send_to_session`, wait for the reply with `wait_for` kind `session_turn`, not a timer.",
  },
  "opensession-admin": {
    summary: "Manage automations, MCP connections and channel memory.",
    guidance:
      "List, create, update, or run automations and manage configured MCP connections.",
  },
  "opensession-runners": {
    summary: "Run bounded commands on trusted persistent machines (Runners).",
    guidance:
      "Use only for an OS, hardware, or toolchain unavailable locally. A Runner is trusted and persistent, not a Sandbox: list and inspect it first, run bounded commands in the session-owned workspace, and reserve or release scarce machines when needed.",
  },
  "opensession-goals": {
    summary: "Create and steer long-running, self-pacing goals.",
    guidance:
      "Create or steer a durable, self-pacing mission that should keep making progress across turns.",
  },
  "opensession-search": {
    summary: "Search and read the distilled record of past sessions.",
    guidance:
      "Search the durable record of past sessions when earlier work, decisions, or findings may answer the task.",
  },
  "opensession-self-deploy": {
    summary:
      "Promote frontend-only releases without restart, or standard-deploy other source changes.",
    guidance:
      "Deploy an ordinary frontend, backend, protocol, or dependency change to a specific commit. Deployment may be autonomous, but check status and batch a burst of commits into one rollout. A strictly frontend-only diff is bundled and promoted without restarting services; other runtime changes use the health-gated three-service rollout. Rebuild-frontend cannot publish shared-checkout source. Changes to live deploy controllers, service templates, credential installers, the run-host helper, or root-managed systemd artifacts require the documented full root deploy instead.",
  },
  "opensession-humans": {
    summary: "Ask a teammate and fold their answer back into this session.",
    guidance:
      "Ask a specific teammate for knowledge or a decision and route their answer back into this session.",
  },
  "opensession-keychain": {
    summary:
      "Borrow a teammate's credential for a stated purpose, with their approval.",
    guidance:
      "Borrow a teammate's credential with their approval when ambient access is insufficient. `request_mac_keychain` uses Apple's native prompt for one macOS Keychain service/account and one HTTPS call. Only HTTP status returns, never secret values or response content. This does not access 1Password vaults.",
  },
  "opensession-publish": {
    summary: "Publish a directory as a durable internal web app.",
    guidance:
      "Publish a workspace directory as a durable internal web app when the deliverable needs to stay live beyond this run.",
  },
  "opensession-repos": {
    summary:
      "Attach or switch repos, link a PR to this session, label PRs, and check whether a PR is ready to merge.",
    guidance:
      "Attach or switch repositories and link pull requests while preserving this session's multi-repo context. Use label_pull_request to label a PR in any registered repo, including one your shell cannot reach. Use check_pr_ready for one deterministic merge-readiness verdict (checks, reviews, conflicts, draft, branch rules) instead of reading transcripts or raw gh output.",
  },
  "opensession-memory": {
    summary:
      "Durable repo / user / team memory, shared with Slack channel memory.",
    guidance:
      "Search or manage durable repo, user, and team facts. Store only information worth carrying into future sessions, especially when the user says to remember it.",
  },
  "opensession-web": {
    summary:
      "Read a URL as text, search what was fetched, clone a GitHub repo. No web search.",
    guidance:
      "Fetch a known URL as text, search fetched content, or clone a GitHub repository. It does not provide general web search.",
  },
  "opensession-portals": {
    summary: "Supervised HTTP/WebSocket services for this session's workspace.",
    guidance:
      "Start and manage supervised HTTP or WebSocket services for this workspace instead of leaving an unmanaged background process.",
  },
  "opensession-desktop": {
    summary:
      "See and drive the Sandbox desktop: screenshot, click, type, keys, windows.",
    guidance:
      "Drive GUI software or a real browser on the Sandbox desktop when a task cannot be done from the shell: screenshot first, act in desktop pixels, screenshot again. The person can watch in the Desktop tab.",
  },
  "opensession-walkthrough": {
    summary:
      "Publish a walkthrough (video, before/after, writeup) onto the Review tab and the PR.",
    guidance:
      "Publish visual proof of a user-visible change to the Review tab and pull request.",
  },
  "opensession-slack": {
    summary: "Open an editable Slack composer. The human still presses Send.",
    guidance:
      "Open an editable Slack draft when the task needs human-reviewed communication. The human still presses Send.",
  },
  "opensession-local-files": {
    summary:
      "Ask the person watching for files from their own computer, including large video.",
    guidance:
      "`request_local_files` asks the person watching for files on their computer (large video is fine) and returns paths here.",
  },
  "opensession-plain-discussion": {
    summary:
      "Reply to the customer or run a Stripe action from a Plain Ask Sidekick discussion, behind the teammate's Approve/Deny card.",
    guidance:
      "In a Plain discussion session, send a customer reply or run a proposed Stripe refund/cancellation only through these tools; each waits for the teammate's approval in Plain.",
  },
  "opensession-ask": {
    summary: "Ask the human a blocking question.",
    guidance:
      "Pause on a blocking question card when a decision only the human can make is required.",
  },
  "opensession-workflows": {
    summary: "Deterministic agent fan-out from a model-authored script.",
    guidance:
      "Author a deterministic script for the same operation across many independent items, with agent fan-out and direct MCP calls.",
  },
  "opensession-assets": {
    summary: "Per-session scratch assets, previewed in the Assets tab.",
    guidance:
      "Save uncommitted reports, diagrams, visualizations, or sample data that should be previewable from this session. Publish existing workspace files with write_asset.sourcePath, especially binary outputs such as DOCX, PDF, and ZIP files.",
  },
  "opensession-charts": {
    summary:
      "Validate a Vega-Lite spec and get the ```vega-lite fence that renders as an interactive chart.",
    guidance:
      "Show quantitative results as an interactive chart: pass a Vega-Lite spec (and optionally the rows) to make_chart, then paste the returned ```vega-lite fence into your reply. Prefer this to a hand-built HTML chart asset or a static image of a chart.",
  },
  "opensession-todos": {
    summary: "The user's Desk todo list.",
    guidance:
      "List or update the user's Desk tasks and reminders when they ask to track work.",
  },
  "opensession-schedule": {
    summary: "Schedule a prompt for this session at a future time.",
    guidance:
      "Check back on slow external work (a release workflow, CI, a deploy) by scheduling a prompt to this session and ending the turn, instead of polling, sleeping, or reaching for harness cron tools. For another session's reply, use `wait_for` kind `session_turn` instead.",
  },
  "opensession-papercuts": {
    summary: "Append-only friction log.",
    guidance:
      "Log environment or tooling friction as it happens. Do not use it for ordinary task difficulty or planned product work.",
  },
  "opensession-report": {
    summary: "Publish this run's durable HTML report into the Reports view.",
    guidance:
      "Publish the run's finished HTML report into the durable Reports view.",
  },
  "opensession-databases": {
    summary:
      "Create, fill and query named SQLite databases kept by Open Session, browsed in the Databases view.",
    guidance:
      "Keep tabular data that a later turn, session or run will query again (collected metrics, scraped rows, triage state) in a named database: create_database with a schema, insert_rows for bulk data, query_database to read it back. Prefer it to a CSV asset when the data will be updated or joined later.",
  },
  "opensession-turn": {
    summary: 'Say "looked, nothing to report" instead of ending on silence.',
    guidance:
      "Declare a clean, silent unattended outcome when the run genuinely found nothing worth reporting.",
  },
  "opensession-health": {
    summary:
      "Read this instance's own disk, memory, load, process fleets and agent status.",
    guidance:
      "Inspect this instance's disk, memory, load, process fleets, and agent status.",
  },
  "opensession-audit": {
    summary: "Read one day's rolled-up audit digest.",
    guidance:
      "Inspect one UTC day's audit totals, run outcomes, model usage, recurring errors, papercuts, and troubled sessions.",
  },
  "opensession-self": {
    summary:
      "A self-improving automation reading and rewriting its OWN prompt.",
    guidance:
      "Read or improve this automation's own prompt. It cannot modify another automation.",
  },
  "opensession-github": {
    summary:
      "Trigger the PR behaviours (review / auto-fix / simplify / adversarial).",
    guidance:
      "Trigger the configured pull request review, auto-fix, simplify, or adversarial behavior.",
  },
  "opensession-goal-self": {
    summary: "A running goal's own cadence controls and fact ledger.",
    guidance:
      "Manage this running goal's cadence, status, and durable fact ledger.",
  },
} as const satisfies Record<string, InternalMcpCapability>;

export type InternalMcpServerName = keyof typeof INTERNAL_MCP_CAPABILITIES;

/**
 * The `## Tools` section of the run prompt: one guidance line per mounted
 * internal server, in catalog order whatever order the mount map has, so the
 * bytes are identical for every run with the same shape and the prompt-cache
 * prefix stays shared. Servers the run does not carry are not mentioned;
 * unknown keys (external MCP connections) are skipped. Empty when nothing
 * internal is mounted.
 */
export function renderInternalMcpCapabilities(
  inProcessMcp: Record<string, unknown> | undefined,
): string {
  const mounted = new Set(Object.keys(inProcessMcp ?? {}));
  const lines = (
    Object.keys(INTERNAL_MCP_CAPABILITIES) as InternalMcpServerName[]
  )
    .filter((name) => mounted.has(name))
    .map(
      (name) => `- \`${name}\`: ${INTERNAL_MCP_CAPABILITIES[name].guidance}`,
    );
  if (!lines.length) return "";
  return (
    "## Tools\nThese servers are in reach through `mcp_search` (find the exact tool and its " +
    "schema) and `mcp_call`. What each is for:\n" +
    lines.join("\n")
  );
}
