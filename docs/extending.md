# Extending Open Session

Six extension points, in rough order of how often you will reach for them.
Adding capability should mean touching one of these — if you find yourself
editing `opensession.ts`, that is usually a sign the thing you want is missing an
extension point rather than that you need to edit the entry file.

Before extending, read what is already there. Two catalogs under
`docs/generated/` are produced from the code itself by
`bun scripts/gen-catalogs.ts`, and a test fails when they go stale:

- [generated/mcp-tools.md](generated/mcp-tools.md) — every tool the built-in
  `opensession-*` servers expose, with the run classes that can call it.
- [generated/engines.md](generated/engines.md) — the engine adapters, what
  turns each one on, and which engine a model routes to.

## 1. MCP servers — give sessions new tools

The lowest-effort way to add capability, and the one that requires no Open Session
code at all. Any [Model Context Protocol](https://modelcontextprotocol.io)
server becomes tools your sessions can call.

Add it in the Connections UI, or in `mcp-config.json`:

```json
{
  "mcpServers": {
    "mytool": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

Two things worth knowing:

- **`allowedUsers`** scopes a server to specific people. With it set, runs by
  anyone else never see those tools. Automation runs pass no user at all, so a
  restricted server is invisible to them — deliberately fail-closed, so untrusted
  ticket text can never reach a sensitive tool.
- Servers carry **their own credentials**. Runs do not inherit Open Session's
  full server environment; each MCP server receives only its own configured or
  granted credentials.

The MCP config is watched. Changes invalidate its parsed cache, and the next use
reloads it, so adding or changing a server does not require a service restart.
Changing the _enforcement_ code does.

Open Session's own tools are different: the `opensession-*` servers run
in-process and are handed to runs by code in
`packages/core/opensession-server/src/server/interactive-mcp.ts`,
`packages/core/opensession-server/src/server/automations.ts`,
`packages/core/opensession-server/src/agents/slack/handlers.ts`, or
`packages/core/opensession-server/src/server/goal-runner.ts`. Add every built-in
server to `packages/core/opensession-server/src/server/mcp-catalog.ts`, then run
`bun scripts/gen-catalogs.ts`. `mcp-catalog.test.ts` automatically checks
interactive wiring; automation, Slack, and goal wiring must currently be kept in
sync manually.

## 2. Feeds — turn MCP objects into projects

A config feed maps a connected HTTP MCP server's listing tool into a sidebar feed
and project workspaces without new runtime code. Create one from **Connections →
New project**, or add a `ConfigFeed` to `~/.opensession/feeds.json`:

```json
{
  "feeds": [
    {
      "id": "mytool",
      "title": "My Tool",
      "refKind": "mytool",
      "mcpServers": ["mytool"],
      "items": {
        "server": "mytool",
        "tool": "list_items",
        "path": "items",
        "map": {
          "id": "id",
          "title": "name",
          "preview": "description",
          "ts": "updatedAt",
          "url": "url"
        }
      }
    }
  ]
}
```

`items` selects the MCP tool and maps dot-paths from its result onto feed items.
`mcpServers` scopes sessions created from the feed; the validated API and package
installer default it to the listing server. Optional `context`, `panel`, and
`filters` add opening-prompt context, a workspace tab, and sidebar controls. See
the full contract and defaults in
`packages/core/opensession-server/src/server/feeds-config.ts`.

Feed config edits apply without a restart. Existing item results can remain
cached for about 60 seconds.

## 3. Automation recipes — package a repeatable job

A prompt plus a trigger. Drop a JSON file in `recipes/automations/` and it
becomes installable with `opensession automations add <id>`.

See [recipes/README.md](../recipes/README.md) for the schema, the house style for
writing the prompt, and — more importantly — the line between what belongs in
the repository and what belongs in your instance config. Short version: if a
stranger could run it on their own repository and get a sensible result, it can
ship; if it needs a paragraph of your company's context, it is instance config.

Scheduled automations can also declare `inputs`. Slack inputs collect bounded
time windows and flatten them with a tool-less one-shot model. Report-history
inputs inject the newest structured reports directly by default; add a `reduce`
block to reduce them again. Slack checkpoints retain a cursor after a successful
run, not raw source data. `outputs` currently supports durable Reports plus an
optional server-side Slack notification derived from a report's structured
urgency and confidence. Keep Slack disabled while evaluating a new analysis
routine: the main model does not need the Slack MCP merely because Slack is an
input or a future output.

## 4. Integrations — react to an external system

An integration is an agent module that can own webhook routes and background
work. Slack, Linear, Plain, GitHub, and Stripe all use this seam.

Append an entry to `packages/core/opensession-server/src/server/integrations/registry.ts`:

```ts
{
  id: "mytool",
  label: "My Tool",
  doc: "docs/setup/mytool.md",
  enableFlag: "ENABLE_MYTOOL_AGENT",
  env: [
    { name: "MYTOOL_API_KEY", required: true, description: "API key" },
    { name: "MYTOOL_WEBHOOK_SECRET", description: "verifies inbound signatures" },
  ],
  load: async (ctx) => {
    const { MyToolAgent } = await import("../../agents/mytool/index");
    return new MyToolAgent();
  },
}
```

That single entry is enough for onboarding to offer it, `opensession
integrations enable mytool` to work, `opensession doctor` to report a missing
credential by name, and `loadAgents()` to construct it. **Nothing in
`opensession.ts` changes.**

The agent implements `AgentModule`
(`packages/core/opensession-server/src/agents/types.ts`): `name`, `getRoutes()`,
`startup()`, `shutdown()`, and `health()`, plus optional `getFeed()`. Start
polling or other background work from `startup()`. Model your first one on
`packages/core/opensession-server/src/agents/linear/`; it is the smallest
complete example.

Rules the registry enforces, and why:

- **Array order is boot order**, because agents register webhook routes in
  sequence. Append; do not reshuffle.
- A module that throws on import is **logged and skipped**, never fatal. One
  broken integration must not take the server down.
- `requires` is an extra runtime gate — Stripe uses it to stay unloaded without a
  signing secret, since every webhook would fail verification anyway.
- `always: true` means "load regardless of config and self-gate internally".

This is a boot path, so it needs a real restart.

## 5. Sandbox providers — run sessions somewhere else

`packages/core/opensession-server/src/server/sandbox/` holds the local and Docker
providers at the root, with Daytona, E2B, Box, Modal, MicroVM, and Lambda
MicroVM under `adapters/`. Implement `SandboxProvider.ensure()`, `get()`, and
`destroy()`, returning a `Sandbox` that implements `exec()`, `launchRun()`,
`ports()`, and `status()`.

Add the provider ID in `provider.ts`, instantiate and select it in
`index.ts`, and update `PROVIDER_IDS`, `RUNNABLE_SANDBOX_PROVIDERS`, and
`SANDBOX_PROVIDER_CERTIFICATIONS` in `config.ts`. Add its provider-specific
configuration, dial-back, qualification, and conformance support as needed.

Read [self-hosting-sandboxes.md](self-hosting-sandboxes.md) first, particularly
the path-parity section: the sandbox's filesystem layout must match the host's,
and "tidying" that is a well-signposted way to break every provider at once.

The authoritative live-certification gate is
`SANDBOX_PROVIDER_CERTIFICATIONS` in
`packages/core/opensession-server/src/server/sandbox/config.ts`;
[self-hosting-sandboxes.md](self-hosting-sandboxes.md) explains the evidence and
operational limits. Implementing another provider is easier than making one
trustworthy.

## 6. Skills — teach agents a workflow

`.agents/skills/<name>/SKILL.md` is markdown an agent loads when relevant. No
code, no registration. This is the cheapest way to encode "how we do X here" —
a review checklist, a deployment runbook, a design vocabulary.

Generic skills shipped by Open Session live in this repository under
`.agents/skills/`, and every run loads that directory whatever repo the
session is working on. A session's own checkout adds to the set with its
`.claude/skills/` or `.agents/skills/`, and a name the checkout defines beats
the shipped one. Product-specific workflows belong in that product's
repository instead.

The list of directories is
`packages/core/opensession-server/src/server/skill-paths.ts`, read by both the
runner and the composer's "/" menu so the menu cannot offer a skill a turn would not
load. Start a message with a skill's name to run it: `/bro`, or `/skill:bro`
if you prefer pi's own spelling. A skill with `disable-model-invocation: true`
stays out of the system prompt and only runs when someone asks for it by name.

If you catch yourself pasting the same three paragraphs into prompts, that is a
skill.

## Handing one of these to somebody else

Any of the above that is data (an MCP server entry, a feed descriptor, an
automation recipe, a skill) can be bundled into a **package**: a git
repository with an `opensession-plugin.json` manifest, installed with
`opensession plugins add <owner/repo>`. It is the unit that makes an extension
publishable, and it deliberately carries no runtime code. See
[packages.md](packages.md).

## What not to extend

**The runner.** `agent-runner.ts`, `pi-runner.ts` and `host-client.ts` are
runner internals with a lot of load-bearing behaviour around restarts,
reattachment and account rotation. Changes there need a real restart and are easy
to get subtly wrong — a mistake usually shows up as sessions that look fine and
silently never progress.

**The entry file.** `opensession.ts` is deliberately thin. If your change needs
to go there, check whether the right move is a new extension point instead.

## Security when you extend

Everything above runs against untrusted input at some point — a customer ticket,
a pull-request diff, an issue body. The invariant is that constraints are
enforced at the tool and environment layer, never in a prompt:

- Automation runs never inherit `~/.opensession.env`; their environment is
  explicit. Host automations still request short-lived AWS credentials and can
  opt into Claude or Codex CLI credentials.
- Automations can carry an MCP-server allowlist. Omitted means all configured
  servers for host runs, so explicitly name only the servers a job needs.
  Sandbox automations require an explicit list; use `[]` for none.
- Customer, identity, and money protections are literal tool-ID catalogs in
  `AUTOMATION_DENIED_TOOLS` and `STRIPE_CONFIRM_TOOLS`. When adding a dangerous
  tool, add its exact ID and tests to the appropriate catalog, or keep its server
  interactive-only.

If your extension needs a credential, prefer giving it to the MCP server rather
than the run. If it needs a dangerous capability, gate it on the run being
interactive. Treat anything your extension reads — a ticket, a diff, a page —
as data, never as instructions.
