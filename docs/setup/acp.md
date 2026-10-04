# ACP adapter (experimental)

The server includes an experimental Agent Client Protocol v1 adapter. It owns a
JSON-RPC stdio subprocess for each turn, negotiates features, streams text and
tool results, and loads a stored agent session when the agent supports it.

**This adapter is not yet connected to the model picker or production session
persistence.** Production turns still use Pi. There is no instance configuration
setting that enables ACP yet. Do not add `acp/<id>` as a production model until
that integration is complete.

## Configure an adapter

Server integrations can create an adapter using `createAcpAdapter` from
`src/server/acp-adapter.ts`. Executable configuration must come from a trusted
operator, not a prompt or an automation input:

```ts
const adapter = createAcpAdapter({
  id: "example",
  name: "Example agent",
  command: "example-agent",
  args: ["--acp"],
  env: { EXAMPLE_AGENT_PROFILE: "coding" },
});
```

Install and sign in to the agent using its own instructions. The adapter does
not install software or authenticate the agent. A missing executable produces
an explicit startup error. The agent starts in the turn's workspace directory.
Only a small environment allowlist and the operator's explicit `env` reach it;
gateway credentials are not inherited. Environment overrides may contain
secrets and must not be published in repository files.

Call `run` with the existing turn options. Use `sessionId` to resume. An agent
without `loadSession` fails a resume explicitly instead of starting an empty
conversation. Negotiated capabilities and the configured instance id accompany
the `init` event. Two adapter instances do not share their live handles.

## Tool and permission boundaries

The adapter accepts already scoped stdio MCP definitions in `acpMcpServers`.
Resolving Open Session's MCP bridge and allowlists remains the integrating
caller's responsibility. `mcpServers: "all"` and unresolved nonempty allowlists
are refused. No grant is inferred from an omitted connector definition.

Only unrestricted local code and scratch runs are suitable. Ask mode, remote
workspaces, publication policies, denied or confirmation-required tools, and
in-process MCP servers are refused because agent-owned tools cannot enforce
those policies. Permission requests select `allow_once` only in code or scratch
mode. Other requests are denied. Persistent `allow_always` grants are never
selected. Client filesystem and terminal methods are advertised as unsupported
and receive method-not-found errors if requested anyway.

Cancellation sends `session/cancel` and kills the owned process group on Unix.
Completion, failure and early stream closure also kill and reap the process.
Windows cleanup currently kills only the direct process.

## Current limitations

- No production model-picker, doctor or instance-config integration.
- No durable ACP transcript/session slot or restart recovery integration.
- No interactive permission card or Open Session MCP bridge resolution.
- No steering, rewind or native fork.
- Reasoning updates are deliberately omitted: the current live event contract
  cannot represent a separate thought block. Plans become runner notices.
- ACP v2 preview, client filesystem services and client terminal services are
  not implemented.

Prior art: t3code's capability boundary and ACP client informed this design;
this implementation uses Open Session's existing stream contract and server
conventions.
