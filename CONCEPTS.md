# Concepts

Open Session is a server that runs coding agents on your own machines. Almost
everything you do with it is one of five nouns: a **project** that is a source
of work, a **workspace** that groups the work on one thing, a **session** where an
agent actually thinks, and the ways a session gets started without you typing —
**automations** and **goals**.

This page is the core model. It is deliberately short on configuration; the
linked docs go deeper on each part.

## The core model

| Concept       | What it is                                                | Relationship                                             |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| **Project**   | a source of work — a git repository, or a feed like Plain | 1 instance has many projects                             |
| **Workspace** | a container grouping the sessions about one piece of work | a project has many; scratch workspaces have none         |
| **Session**   | one conversation with an agent, with its own transcript   | a workspace has many; specialized sessions may have none |
| **Turn**      | one prompt → one agent response, with its tool calls      | 1 session has many turns                                 |

That is the usual hierarchy you navigate: the sidebar is a list of projects,
each holding workspaces, each holding sessions. Repo-less scratch workspaces sit
alongside the projects instead. Interactive sessions normally use
`/workspace/<workspaceId>/session/<sessionId>`. Specialized automation and goal
sessions may be workspace-less and use `/session/<sessionId>`.

Alongside it sits a second, independent axis — _where_ a session's work happens:

| Concept      | What it is                                                       |
| ------------ | ---------------------------------------------------------------- |
| **Worktree** | the git working directory a code session edits in                |
| **Sandbox**  | an optional provider-backed environment used instead of the host |
| **Runner**   | a trusted persistent machine attached for specialized work       |

And a third — _what starts or coordinates work when you are not there_:

| Concept        | Trigger                                    | Memory across runs                                 |
| -------------- | ------------------------------------------ | -------------------------------------------------- |
| **Automation** | a cron schedule or an external event       | none — every run is a fresh session                |
| **Goal**       | its own self-set wake time                 | yes — wakes resume one session over days           |
| **Workflow**   | a script fanning out agents and tool calls | successful calls replay when a workflow is resumed |

## Projects

A project is a source of work. It gets its own band in the sidebar, and the
things inside it become workspaces.

There are two kinds, and the difference is only where the work comes from:

**Repository projects** are git checkouts on the host that you registered.
Their code workspaces usually track branches and worktrees. GitHub changes can
produce pull requests; on code.storage, a pushed branch is the change request.

**Feed projects** are external systems, reached through an integration or an
MCP server. Plain is a project — its items are support tickets. So are Slack,
your videos, your issue tracker. Their items are things that already exist
somewhere else; opening one gets you a workspace for it, created on first touch
and reused forever after.

The same nouns hang off both. A Plain ticket and a `myapp` branch are both
workspaces, both hold sessions, both show up in your lanes. What differs is that a
repository project's workspaces are _created_ by you working, while a feed
project's workspaces are _adopted_ as items arrive.

> **Repository ≠ project.** A repository is one kind of project, not a synonym
> for one. If a doc or a menu says "project", it means the band — which may or
> may not be git-backed.

### Registering a repository project

A repository entry identifies its checkout and default branch. It can carry
setup, dependency and preview commands, plus host-specific review metadata:
`ghRepo` for GitHub, or `host: "codestorage"` plus `csRepo` for code.storage.
They live in `~/.opensession/config.json` — see
[docs/instance-configuration.md](docs/instance-configuration.md).

A repo can also commit its own lifecycle scripts (`.agents/setup`,
`.agents/start.sh`) so every worktree provisions and boots itself without
instance config. That convention is what lets an agent open its own change in a
real browser — see [docs/repo-lifecycle.md](docs/repo-lifecycle.md).

One repository can be marked a **shared checkout**, meaning ordinary sessions
work directly in the main clone rather than in worktrees. Open Session's own
repository is configured that way so sessions improving it are editing the thing
that is running. Unattended automations and PR integrations still use dedicated
worktrees. It has sharp edges; read
[docs/worktrees.md](docs/worktrees.md#the-shared-checkout-exception) before
turning it on for anything else.

### Adding a feed project

A feed project is defined as data, not code: which connected MCP server backs
it, which tool lists its items, and how that tool's fields map onto
title/preview/timestamp. Add one from Connections → Projects. Any MCP server
with a list-shaped tool can become a band.

Config-created feeds default their sessions to the backing MCP server and can
declare an explicit allowlist instead. Code-provided feeds must set `mcpServers`
explicitly to be scoped; omitting it currently exposes all configured servers
available to the user.

## Workspaces

A workspace groups the sessions about one piece of work. Interactive sessions
normally belong to exactly one workspace, which appears as a row in the sidebar.
Automation and goal sessions can exist without one.

The important part: **a workspace can own a worktree**. When it does, it holds a
repo, a branch, a worktree directory and any attached repos, and new sessions
created in it inherit that worktree by default. Sessions that inherit it share a
checkout and contribute to one review unit. Stacked sessions and integration
runs can use dedicated worktrees while remaining in the same workspace.

A workspace with no worktree is fine too — that is what an ask-style workspace
looks like, or a feed workspace for a ticket where there is nothing to check
out, or a fresh one before any code session materializes it.

A scratch workspace has no project at all. It sits outside the project bands in
the sidebar and gives its sessions a shared scratch directory instead of a repo.

Feed items resolve to a workspace through a generic external reference, which
is what makes the linkage stable: the same ticket always reopens the same
workspace instead of spawning a new one.

## Sessions

A session is one conversation with an agent. It has a transcript, a model, a
working directory, a queue of pending prompts, and a state you can see from the
sidebar (running, waiting on you, idle).

Sessions are the unit everything else produces. An automation run creates a fresh
session. A goal owns one session, and each wake resumes it for another turn. That
is deliberate: whatever started it, you can open it, read the whole transcript,
steer it mid-flight, and fork it into a normal conversation.

### Modes

A session's mode decides what it can touch:

- **`ask`** — read-only. No worktree of its own; it shares a per-repo checkout
  pinned to the default branch. A shared-checkout repository may use its main
  clone instead. Cannot write files. Use it for questions, investigation and
  code reading.
- **`code`** — write tools in a branch checkout. A new code workspace normally
  gets an isolated worktree; later sessions share it by default, while stacked
  sessions request another. Ordinary sessions use the main clone when the
  shared-checkout exception is active. This is the default mode.
- **`scratch`** — no repo at all, just a working directory. This is what a session
  in a feed workspace gets when there is nothing to check out.

### Multi-repo sessions

A session has one primary repo and can **attach** more. Each attached repo gets its
own isolated worktree, branched to match the session's primary branch, so a change
spanning two repositories lines up and produces matching review units. Diffs,
file mentions and review controls become repo-aware once a session spans more
than one.

### Turns, queues and steering

You prompt; the agent takes a turn. While a turn is running, anything you send
is either delivered as a steer or queued behind it and delivered as the next
turn — nothing is dropped. A session can also ask _you_ something mid-turn and park
until answered, which is what puts it in the "needs input" lane.

Sessions can spawn other sessions. An orchestrator delegates focused work to workers
(their own context, possibly a different model), reads their reports and keeps
the final call. Spawn depth is capped so this cannot run away.

## Where a session runs

**Worktrees** are the default for new code workspaces. Code sessions added to a
workspace share its worktree by default; stacked sessions can request another.
When the shared-checkout exception is active, ordinary sessions use the main
clone instead. Creating a worktree installs dependencies up front. This is also
where your disk goes:
[docs/worktrees.md](docs/worktrees.md).

**Sandboxes** are optional provider-backed execution environments used instead
of the host. Implementations include local Docker containers, local Firecracker
MicroVMs, and remote container or VM providers:
[docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md).

**Runners** are trusted persistent machines paired with
`opensession runner connect` for platform-, toolchain-, or GPU-specific work.
The Runner connects outbound to Open Session, which can delegate bounded
commands to it. See [docs/runners.md](docs/runners.md).

## Automations

An automation is a prompt plus a trigger. When it fires, it creates a **fresh
session** and runs the prompt in it.

The trigger is a cron schedule, a one-off time, or an external event: a message
in a watched Slack channel, an incoming support ticket, a failure signal from
your logs. The run shows up in the sidebar like any other session, with its full
transcript.

The defining property is that automations are **amnesiac**. Every run starts
clean. That is what makes them safe to point at untrusted input — a support
ticket's text is data the agent reads, never configuration for the run — and it
is why they are scoped tightly:

- an automation can carry an MCP allowlist. An explicit list restricts the run,
  and `[]` means none; omitted currently means all configured servers. Sandbox
  automations require an explicit list;
- runs get a minimal environment; only explicitly allowed short-lived or opt-in
  credentials are projected;
- customer-facing and identity-mutating tools are denied outright;
- `mode` applies here too: an `ask` automation cannot write; a `code` automation
  gets an isolated worktree and can edit and commit. Ordinary automations do
  not receive GitHub credentials, so they cannot currently push or open a
  GitHub pull request. Trusted `github-*` code workflows use a separate,
  repository-scoped credential path. `prReviewer` adds an instruction but does
  not grant publication authority.

Automations are data, not code: create one from the UI or by talking to the
agent. Reusable ones can be packaged as **recipes** — a JSON file in
`recipes/automations/` installable with `opensession automations add <id>`.

## Goals

A goal is the opposite trade from an automation: **one session, pursued over days
or weeks**.

Where an automation fires a fresh amnesiac session on a tick, a goal drives a
single session that is resumed on every wake — so context carries, and the agent
remembers what it already tried. It paces itself (each wake schedules its own
next one, with a floor so a buggy run cannot hot-loop), pauses for human
sign-off when it needs a decision, and stops when its success condition is met.

The mission is just a prompt. Goals are for open-ended, long-horizon work — "get
this metric under X", "keep this migration moving" — where the value is in
continuity rather than in a clean slate.

A goal has a mode like a session: `ask` for research and measurement, `code` for
a persistent worktree across wakes. When the shared-checkout exception is
active, a code goal instead works directly on the default branch, without a
feature branch or pull request.

## Workflows

A workflow is a model-authored script running in an environment-scrubbed Bun
Worker. It can fan out fresh read agents, call allowed MCP tools directly, and
opt individual agents into isolated write worktrees. Write-agent changes are
auto-committed, and `merge()` can land their branches on the parent session's
branch.

Successful agent and MCP calls are journaled and replayed when a workflow is
resumed. The runner enforces concurrency, call-count and timeout limits. The
Worker provides containment, not a hard security sandbox.

## Integrations

An integration connects an external system: Slack, Linear, Plain, GitHub,
Stripe. Each owns its webhook routes and a background loop, and each is off
until you enable it.

Integrations do two things in the model above. They can **back a feed project**
(Plain's tickets, Slack's channels), and they bring work in without the UI: a
Slack thread becomes a session you can reply into from Slack; a pull request review
becomes a session that fixes the comments; a support ticket triggers a triage
automation. The session is always the same object underneath — you can open any of
them in the web UI mid-flight.

## Tools: MCP servers and skills

**MCP servers** are how sessions get capability beyond files and shell. Any Model
Context Protocol server you add becomes tools your agents can call — and, if it
has a list-shaped tool, a candidate feed project. Two properties matter for the
model above:

- servers carry **their own credentials** — agent subprocesses get a minimal
  environment without your tokens;
- a server can be scoped to specific people (`allowedUsers`), and automation
  runs pass no user at all, so a restricted server is invisible to them.
  Fail-closed by design.

**Skills** are prompt-level extensions — a directory with a `SKILL.md` the
engine loads on demand, invocable as a `/`-command in the composer. They load
from the session checkout's `.claude/skills/` and `.agents/skills/`, plus Open
Session's shipped or package-installed skills directory
(`OPENSESSION_SKILLS_DIR` can override it). Host-account and engine-embedded
skills are disabled.

See [docs/extending.md](docs/extending.md) for both, plus integrations and
providers.

## Putting it together

A typical loop, in the vocabulary above:

1. You register the repository **project** `myapp` once, and connect Plain as a
   second project.
2. You start a **session** on `myapp` in `code` mode. That creates a **workspace**
   and cuts a **worktree** on a new branch.
3. The agent takes **turns** — reading, editing, running the test suite in the
   worktree, opening a pull request.
4. Review comments arrive. The GitHub **integration** opens another **session** in
   the same PR workspace, checks the PR branch out in a dedicated integration
   worktree, and pushes fixes back to that branch.
5. A ticket lands in the Plain project. Opening it gets you its **workspace**;
   a triage **automation** has already run a fresh, amnesiac session there and left
   an internal note.
6. Meanwhile a **goal** you set two weeks ago wakes itself every morning,
   remembers everything it has already tried, and moves one long migration
   forward.

## Where to go next

- [docs/worktrees.md](docs/worktrees.md) — how sessions map to git worktrees, and
  where the disk goes
- [docs/repo-lifecycle.md](docs/repo-lifecycle.md) — the `.agents/` lifecycle
  scripts a repository commits so its worktrees provision and boot themselves
- [docs/instance-configuration.md](docs/instance-configuration.md) —
  repositories, identity, branding, integrations, seeds
- [docs/extending.md](docs/extending.md) — MCP servers, recipes, integrations,
  providers
- [docs/runners.md](docs/runners.md) — attaching another machine
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — isolated
  execution
- [docs/setup/](docs/setup/README.md) — installing, and the trust model
