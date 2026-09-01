# Sandbox, Portals, and sleep/wake plan

## Goal

Make a sandboxed Open Session feel like a durable, shared remote workspace:

- an agent can create and expose arbitrary live services as Portals;
- the Sandbox can sleep and wake without losing the conversation or queued work;
- collaborators can keep reading and contributing to the same session throughout;
- local worktrees remain the fast default for small, trusted work.

This deliberately adopts the useful parts of Amp's Orb experience without
adopting the Orb name or requiring a managed Open Session cloud.

## Status

This began as a proposal. The supervised Portal layer, generated `.ports.conf`
records, six-tool MCP, declared-Portal HTTP controls, outbound relay, sidebar
controls, Sandbox badge, and serialized durable queue are implemented. The
legacy repository Preview start path remains. The main unfinished work here is
an explicit opt-in Project preparation model, provider-neutral `.agents/resume`
and Portal restoration on every wake, and complete provider security and
lifecycle verification. Sections below distinguish current behavior from
targets where the difference matters.

## Product model

Use these user-facing concepts consistently:

| Concept                       | Meaning                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| **This machine**              | The default execution target: a local worktree and its existing setup.    |
| **Sandbox**                   | Isolated compute selected for a session.                                  |
| **Project preparation**       | Optional, credential-free reusable setup state that speeds new Sandboxes. |
| **Awake / Sleeping / Waking** | The lifecycle of a session's Sandbox.                                     |
| **Portal**                    | An authenticated live HTTP/WebSocket service belonging to one session.    |

Do not expose `None`, `bind`, `volume`, provider names, prewarm machinery, or
snapshot implementation details in the normal session flow. Provider and
machine information belongs in the Sandbox details popover.

Collaboration remains on by default. A session is the shared workspace whether
it is local, its Sandbox is Awake, or its Sandbox is Sleeping.

## Why this differs from Amp's snapshots

Amp's public model is straightforward: each new Orb thread gets a fresh Orb
and repository clone, `.agents/setup` prepares it, and the same Orb pauses and
later resumes with `.agents/resume`. Amp documents supervised services with
sticky ports and authenticated Portals.

Open Session already has more execution mechanisms, but they currently leak
into the product:

| Layer              | Current Open Session behavior                                                                                                    | Target presentation                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| New session        | Provider-specific Sandbox, optionally adopted from a prewarm                                                                     | A fresh **Sandbox**.                                                  |
| Project setup      | Warm-on-typing automatically prepares and may publish credential-free templates for template-capable providers                   | Explicitly opted-in **Project preparation ready**.                    |
| Session durability | Provider-specific checkpoints, snapshots, pause, or archival; durable sleep/wake exists only where the provider implements it    | **Sandbox sleeping**.                                                 |
| Wake               | Provider resume/restore; `.agents/resume` remains reserved until a selectable provider wires it                                  | **Waking Sandbox**, with the hook run before work resumes.            |
| Services           | Supervised Portals through `opensession-portals` and generated `.ports.conf`, alongside the legacy repository Preview start path | Multiple supervised **Portals**, without a competing Preview concept. |

Keep the stronger implementation layers. Simplify the visible model to fresh
Sandbox, optional Project preparation, and session-specific sleep/wake.

## 1. Supervised multi-Portal service layer

The current session-scoped service supervisor owns each service's process
group, readiness checks, lifecycle, and cleanup. Services survive an agent
turn but are stopped or marked unavailable when the session or Sandbox is
destroyed.

The legacy repository Preview start path still exists. The target is for its
canonical repository app to be the default Portal service, not a competing
product concept named Preview.

The supervisor maintains a session-local `.ports.conf` registry with the
stable service name, Sandbox-local port, description, state, process identity,
and optional default route. Open Session owns its generated records; agents
may inspect them but should not maintain them manually.

## 2. `opensession-portals` MCP

`opensession-portals` is the current interactive service MCP and has no
`opensession-preview` compatibility alias. It exposes these tools to eligible
interactive code sessions:

- `start_portal({ name, command, port?, description? })`
- `start_declared_portal({ id })`
- `list_portals()`
- `stop_portal({ name })`
- `restart_portal({ name })`
- `set_portal_path({ name?, path })`

Use `start_declared_portal` for `.agents/portals.json` recipes so Open Session
applies the trusted command, port contract, readiness timeout, and Sandbox
workload identity. Use `start_portal` for ad-hoc services.

`start_portal` runs only in the current session workspace. It allocates a port
when omitted, supplies `PORT` and the public Portal URL environment, waits for
the service to listen, registers the authenticated Portal, and returns its
Open Session URL.

It must never accept an arbitrary upstream URL or host. The agent may create
any app or service, but it may expose only a process in its own session.

This is the intended response to a request such as: “make me a little app that
I can test UI with.”

## 3. Reverse Portal relay for remote Sandboxes

Daytona, E2B, Box, Modal, and AWS Lambda MicroVM use the outbound Portal relay,
with the Open Session-owned Portal route as the user path. Provider preview
URLs are not part of the browser flow.

```text
Sandbox service
  -> outbound authenticated Portal relay
  -> local relay endpoint on Open Session
  -> Caddy authentication
  -> browser
```

The relay is separate from agent run control, but follows the same
outbound-connectivity model that remote Sandboxes already use.

Security constraints:

- HTTP and WebSocket traffic only; never a generic TCP or shell tunnel.
- Each relay has short-lived credentials bound to one Sandbox and session.
- A relay may serve only ports registered for its owning session.
- Caddy proxies only to a local relay endpoint, never to an agent-provided or
  provider-provided upstream.
- Closing, sleeping, recreating, or destroying a Sandbox immediately revokes
  its relay routes.
- Provider preview URLs and tokens are used only for qualification/internal
  diagnostics, never in UI, transcripts, MCP results, or browser requests.

Docker can reach private service addresses directly behind the same Portal
abstraction. Users and agents receive the same
Open Session Portal URLs for every provider.

## 4. Agent instructions and repository declarations

Add this concise capability guidance to eligible code-session instructions:

> Use session Assets for simple static artifacts, diagrams, reports, or
> standalone HTML that does not need a running process. Use Portals for
> interactive apps, running web servers, API-backed UI, multiple routes,
> authentication, or anything the user should open and test live. Create the
> app, call `opensession-portals.start_declared_portal` for a
> `.agents/portals.json` recipe or `start_portal` for an ad-hoc service, verify
> it with `list_portals`, then tell the user which Portal is ready.

Inject repository-specific context when present:

> `.agents/portals.json` contains this project's reusable Portal recipes.
> `.ports.conf` lists this session's running Portal services.

Retain and document `.agents/portals.json`, expanding it from UI-only
skill-backed starters into the repository's Portal/service declaration where
useful. The agent must still be able to create ad-hoc Portals without changing
repository configuration.

Update `docs/repo-lifecycle.md` with:

- static Assets versus live Portals;
- declared Portal recipes/services;
- ad-hoc agent-created Portals;
- generated `.ports.conf` semantics;
- sleep/wake behavior and `.agents/resume` expectations.

## 5. Complete the Portals sidebar

Keep the side panel focused on services; do not make it a second machine
inspector. It should show default repository and agent-created Portals
together, including:

- name, description, route, and readiness;
- Awake, Starting, Sleeping, Waking, or Failed state;
- open embedded or in a separate window;
- stop/restart controls where safe;
- an empty state explaining that the agent can create a live Portal.

Opening the sidebar to inspect a Sleeping Sandbox must not wake it. Explicitly
opening a Portal or sending a message may wake it.

## 6. Session creation and the Sandbox pill

New Session offers two primary execution choices:

- **This machine** — default, fast, trusted local worktree.
- **Sandbox** — isolated compute.

When Sandbox is selected, provider, machine profile, and Project preparation
status are nested details, not equal top-level choices.

Sandboxed sessions show a single top-bar control:

```text
● Sandbox
```

The label never changes to a provider name or workspace implementation term.
The dot and accessible description show Preparing, Awake, Sleeping, Waking, or
Needs attention.

Clicking it opens a compact Runtime popover containing provider, machine
profile, Project preparation status, current lifecycle progress, logs,
diagnostics, Sleep/Wake/Recreate controls, and shortcuts to terminal/Portals.
There is no additional permanent Runtime sidebar tab.

## 7. Sleep/wake and durable queues

The durable queue already persists sends and serializes queue draining so one
drain owns a potentially slow wake. The target is one provider-neutral
lifecycle:

```text
Preparing -> Awake -> Sleeping -> Waking -> Awake
                     \-> Needs attention
```

The transcript is server-owned and must remain fully readable in every state.
Sleeping affects compute only; it never makes a session appear deleted or
unavailable.

Target behavior while a Sandbox is Sleeping or Waking:

- the composer remains enabled;
- sends persist immediately in the normal durable queue;
- the UI says “Queued — waking Sandbox”;
- only the first queued message begins a wake;
- later messages preserve their order and do not start another wake;
- after the provider wakes, `.agents/resume` runs, Portal relay/service state
  restores as appropriate, and only then does the queue drain;
- a failed wake preserves the queue and offers Retry in the Sandbox popover.

The provider-neutral resume step is still outstanding. Daytona and Box resume without the
hook. Run `.agents/resume` after every successful provider wake, before
restoring Portals or draining queued work.

## 8. Project preparation and acceleration

Warm-on-typing currently prepares projects automatically for template-capable
providers and may seal a reusable template. Prewarming defaults on when a
supported provider is configured unless explicitly disabled. The target is an
explicit per-project opt-in while keeping reusable artifacts credential-free:
private `.env` files and other session authority must be added only after
shared preparation state restores.

Keep the existing implementation layers where they make sense:

- base runner image;
- provider-specific project snapshots/templates;
- session-specific pause/resume durability;
- warm-on-typing acceleration.

Present only these normal user-facing facts:

- **Project preparation ready** — new Sandboxes start faster.
- **Sandbox sleeping** — this session resumes where it left off.

Keep host dependency caches and preview pools in advanced workspace
acceleration settings. Do not conflate them with Sandbox Project preparation.

## 9. Explicit non-goal: transplanting a live local session

Do not silently move a running local session into a remote Sandbox. After this
plan is stable, add **Continue in Sandbox** for an idle local session as an
explicit linked continuation from a commit or confirmed patch. It is a separate
state-transfer feature.

## 10. Verification and security gate

Before certifying a provider for arbitrary agent-created remote Portals, and
when guarding against regressions, prove:

- unauthenticated Caddy requests cannot reach a test service;
- provider URLs/tokens never appear in browser-visible data, logs, transcripts,
  or MCP results;
- the relay permits only its owning Sandbox's registered HTTP/WebSocket ports;
- relay credentials expire and routes revoke on sleep, destroy, or archival;
- agent-created Portals survive normal agent turns and restore or accurately
  report stopped state after wake;
- sleeping transcripts remain readable;
- multiple queued messages initiate one wake and execute in order;
- the Portal relay and security matrix covers Daytona, E2B, Box, Modal, and
  AWS Lambda MicroVM;
- the durable sleep/wake and queue matrix covers the providers that implement
  pause/resume: Daytona and Box. Record Docker as not exposing
  provider pause/resume. E2B and Modal are ephemeral here, while AWS Lambda
  MicroVM has a hard lifetime; none currently exposes this durable contract.

## Acceptance outcome

Open Session provides a durable shared session whose compute can sleep, wake,
run multiple real services, and hand users secure live Portals. It retains the
small-team advantage of choosing a local worktree when that is the faster,
more appropriate execution target.
