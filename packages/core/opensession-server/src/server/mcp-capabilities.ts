/**
 * Lightweight metadata for Open Session's in-process MCP servers.
 *
 * This module must stay dependency-free. The runtime prompt builder imports it,
 * while mcp-catalog.ts imports every real server factory for docs and wiring
 * checks. Keeping the shared names and summaries here lets the prompt describe
 * the live capability set without pulling that factory graph into every run.
 */

export interface InternalMcpCapability {
  /** One-line catalog description used in generated docs. */
  summary: string;
  /** Decision guidance shown only when this server is available to the run. */
  guidance: string;
}

export const INTERNAL_MCP_CAPABILITIES = {
  "opensession-sessions": {
    summary: "See and steer other sessions, and spawn worker sessions.",
    guidance:
      "Create, inspect, steer, or cancel visible sessions and worker tasks. Use this rather than inventing an in-process worker when the user asks for a new session.",
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
      "Request temporary access to a teammate's credential with their approval when ambient credentials cannot satisfy the task.",
  },
  "opensession-publish": {
    summary: "Publish a directory as a durable internal web app.",
    guidance:
      "Publish a workspace directory as a durable internal web app when the deliverable needs to stay live beyond this run.",
  },
  "opensession-repos": {
    summary: "Attach or switch repos, and link a PR to this session.",
    guidance:
      "Attach or switch repositories and link pull requests while preserving this session's multi-repo context.",
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
      "Save uncommitted reports, diagrams, visualizations, or sample data that should be previewable from this session.",
  },
  "opensession-todos": {
    summary: "The user's Desk todo list.",
    guidance:
      "List or update the user's Desk tasks and reminders when they ask to track work.",
  },
  "opensession-schedule": {
    summary: "Schedule a prompt for this session at a future time.",
    guidance:
      "Check back on slow external work (a release workflow, CI, a deploy) by scheduling a prompt to this session and ending the turn, instead of polling, sleeping, or reaching for harness cron tools.",
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
