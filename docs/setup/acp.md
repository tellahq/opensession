# ACP agents

Open Session can run an Agent Client Protocol v1 CLI in a local code or scratch
session. The agent supplies its own models, authentication and native tools.
Open Session owns its transcript, worktree, process lifecycle and MCP grants.

## Add an agent

Install the CLI and sign in using the agent's instructions. Add an `acp` array
to your instance `config.json`:

```json
{
  "acp": [
    {
      "id": "example",
      "name": "Example agent",
      "command": "example-agent",
      "args": ["--acp"],
      "env": { "EXAMPLE_AGENT_PROFILE": "coding" }
    }
  ]
}
```

Use a command on the server's PATH or an absolute executable path. IDs must be
unique lowercase letters, numbers, hyphens or underscores, beginning with a
letter or number. Names and commands are required; arguments and environment
values must be strings. Only trusted operators should configure agents.

Select **Example agent** (`acp/example`) in the model picker. Missing binaries
remain visible but disabled with an installation/configuration reason.
`opensession doctor` also checks configured executables. An unavailable agent
never silently falls back to Pi.

The process starts in the session worktree. It receives a minimal environment
(PATH, HOME, USER, SHELL, LANG, TMPDIR and SYSTEMROOT where present), plus its
explicit `env`. Gateway credentials are not inherited. Secrets in `env` belong
in the private instance config, never in repository files. Effective config
shows the instance id, command, arguments and environment **names**, not values.

## Capabilities and conversation continuity

Capabilities are versioned and negotiated from `initialize`. Before the first
turn the picker uses conservative capabilities. Steering, conversation rewind
and native fork are unavailable; the web composer queues instead of steering.
Image support and stored-session loading come from the agent's response.

Each instance has isolated live handles. Agent session IDs are namespaced by
instance and stored in an ACP-specific session slot. Subsequent turns use
`session/load` when supported. Otherwise Open Session starts a fresh agent
session with a bounded portable transcript handoff. A failed advertised load
is an explicit error, not a silent fresh conversation.

Text, reasoning summaries, tool input/output and plans persist in the same
owned transcript store as Pi. Reasoning uses assistant activity entries marked
`isReasoning`; it is not included in the final answer. Replay notifications
from `session/load` do not duplicate transcript entries. Non-text tool content
is preserved as structured JSON text, and tool image content also supplies
renderable image sources.

## MCP and permissions

ACP v1 agents receive already scoped **stdio** MCP connectors. URL-only
HTTP/SSE connectors are not granted. Configured `allowedUsers` rules still
apply. In-process Open Session tools are represented by the existing stdio MCP
proxy, with a per-turn token restricted to exactly that turn's mounted server
names. The token cannot request direct workspace execution.

External stdio connectors are refused when the turn has confirmation-required
tools: the adapter cannot enforce those approvals inside an agent-owned MCP
connection. Publication policies, denied tools, remote workspaces and ask mode
are likewise refused rather than weakened. Automation policies are not bypassed.

Permission requests in unrestricted code/scratch mode select `allow_once`.
Requests without a one-time approval option are denied. Persistent
`allow_always` grants are never selected. Client filesystem and terminal
services are advertised as unsupported; agents must use their own tools.

## Cancellation and restart

Each turn owns one agent process. Cancellation sends `session/cancel` and kills
the process group on Unix. Finish, failure and early stream closure also kill
and reap it. Windows currently kills only the direct process; use Unix hosts
for CLIs that launch descendants.

An interrupted ACP turn is marked failed/interrupted after a server restart.
Open Session does not resurrect its process or automatically re-prompt it.
Send another prompt to continue using the saved agent session or portable
handoff. ACP v2 preview, native steering/rewind/fork and client-side terminal
services are not implemented.

Prior art: t3code's capability boundary and ACP client informed this design;
this implementation adapts it to Open Session's stream contract and owned store.
