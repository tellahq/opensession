# Runners plan

## Goal

Document the shipped Runner command-delegation foundation and the target design
for persistent, user-owned machines as full execution targets in Open Session.

A Runner is a machine the workspace deliberately attaches and trusts to run
work: a Mac mini with Xcode, a GPU development box, a Windows builder, or a
dedicated Linux machine. It is not an ephemeral Sandbox and it is not merely a
remote terminal.

The target design adds a third execution shape:

| Execution target | Best for                                                  | Lifecycle                                      |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------- |
| **This machine** | Fast, trusted local worktree work                         | The current Open Session host/worktree.        |
| **Sandbox**      | Isolated, reproducible, resumable remote work             | Per-session, provider-backed compute.          |
| **Runner**       | Persistent hardware, platform/toolchain/GPU-specific work | A workspace-owned machine attached on purpose. |

**Current product status:** Runners support scoped, audited command delegation
from interactive sessions. They cannot yet be selected as a session execution
target. Full Runner sessions, Runner terminals, and Runner Portals are not
shipped.

The product should not automatically treat a Runner as a safer Sandbox. A
Runner is normally _more trusted_ and less isolated: it runs as its owner's
local user and may hold local credentials, caches, and hardware access.

## Existing foundation

The current Runner feature is the foundation. Workspace administrators manage
Runners in **Settings → Runners**. A machine pairs with a one-time, ten-minute
code and connects outbound over the tailnet through an authenticated WebSocket.
Interactive sessions receive the `opensession-runners` tools for inventory,
status, reservations, and audited command delegation. Automation-owned sessions
do not receive those tools. Revocation removes the credential and closes the
live connection immediately.

A session's agent remains on its standard This machine or Sandbox runtime and
delegates individual commands to the Runner. It does not materialize or run the
full session there. For current setup and operation, see [Runners](runners.md).

### SSH-to-Runner migration

The currently reachable Mac mini may start as an SSH-managed machine rather
than an already attached Runner. Treat SSH as a **bootstrap and migration
path**, not as the permanent Runner transport:

1. A workspace admin selects an existing, explicitly configured SSH host for
   the Mac mini and verifies its host fingerprint.
2. Open Session uses that access only to inspect prerequisites, install or
   upgrade the Runner component, and install its launchd service.
3. The new Runner then pairs and opens its own authenticated outbound control
   channel to Open Session over the tailnet.
4. Status, command streaming, full-session execution, Portal relay, audit, and
   immediate revocation all use that Runner channel from then on.

This lets the existing Mac mini migrate without asking someone to sit in front
of it, while avoiding a second, weaker SSH-based execution protocol. The
machine is not an available Runner until pairing completes; a failed bootstrap
leaves the old SSH setup untouched and reports diagnostics.

### Kubernetes GPU Runner migration

The GPU devbox currently reached with `kubectl` follows the same principle.
Kubernetes is its deployment and recovery mechanism, not the execution
protocol an agent receives:

1. A workspace admin chooses a preconfigured Kubernetes context and a
   dedicated namespace, then selects or creates the persistent GPU Runner
   workload and its persistent workspace volume.
2. Open Session uses the narrowly scoped Kubernetes credential only to inspect,
   deploy, upgrade, restart, and obtain diagnostics for that workload.
3. The Runner container reports its GPU inventory and opens the same
   authenticated outbound Runner channel as a Mac mini.
4. Commands, full sessions, Portals, logs, reservations, and cancellation flow
   over that channel — never through an agent's arbitrary `kubectl exec`.

The initial UI may call this **Connect a Kubernetes GPU Runner**, but it must
make clear that it targets a deliberate long-lived workload, not an arbitrary
pod chosen by a model. The workload is offline when Kubernetes has not yet
scheduled it; it becomes online only after its Runner channel authenticates.

**Boundary:** SSH and `kubectl` exist only in this admin migration flow. They
are not Runner transports, MCP tools, session execution backends, terminal
backends, or Portal backends. Once a machine/workload is registered, all normal
Runner activity uses the single outbound Runner control protocol; the
bootstrap credential is not consulted again.

## Naming and model

**Runner** is already the product and API concept across the current routes,
CLI, settings UI, registry, and `opensession-runners` MCP server. A Runner is
the machine; a **run host** remains the internal process that executes one
agent turn. Do not conflate the two or reintroduce user-facing compatibility
aliases for the old name.

In the target model, each Runner has:

- a stable id and display name;
- owner/label and optional location note;
- platform and architecture;
- online, busy, offline, or maintenance state;
- last-seen time and runner software version;
- detected capabilities and explicit workspace tags;
- resource inventory: CPU, memory, free disk, and GPU model/VRAM/CUDA or Metal
  availability when present;
- execution permissions: command delegation, full sessions, terminals, and
  Portals, each explicit rather than inferred;
- allowed users, repositories, and workspace roots;
- a short human description such as “office Mac mini for iOS builds” or
  “GPU devbox: local inference and video rendering.”

Capabilities should be structured as well as searchable. For example:

```json
{
  "platform": "darwin",
  "toolchains": ["xcode", "swift", "bun"],
  "hardware": {
    "gpu": { "kind": "nvidia", "model": "RTX 4090", "vramGb": 24 },
    "memoryGb": 64
  },
  "tags": ["ios", "office", "interactive"]
}
```

Free-form tags remain useful for team intent; they must not be mistaken for a
security permission.

## 1. Workspace Runner settings

**Settings → Runners** is workspace configuration, not a personal provider
setting. The shipped page provides inventory, pairing and operator-configured
bootstrap, access policy, maintenance, command permission, and revocation.

The target page contains:

- a Runner inventory with status, capabilities, resource summary, workload,
  last seen, and label;
- an **Add Runner** flow with three deliberate paths: copy the pairing command
  on the target machine, bootstrap a preconfigured SSH-reachable machine, or
  bootstrap a preconfigured Kubernetes Runner workload; all end in the same
  one-time Runner pairing;
- Runner details for label, tags, supported repositories/workspace roots,
  allowed users, and execution permissions;
- a maintenance switch that makes a Runner unavailable for new work without
  revoking it;
- a revoke/remove action that immediately invalidates credentials and closes
  its channel;
- connection diagnostics and a hardware/capability refresh action.

The empty state and Add Runner flow explain the concept in plain language:
“Runners are computers your workspace owns and explicitly trusts for work that
needs their hardware or platform, such as a Mac with Xcode or a GPU devbox.
They are not isolated Sandboxes.” It gives three short steps — choose the
machine, connect it, then choose its permissions — and links to the full
security and service-management documentation.

The connection choice is presented before any command:

| Choice                               | Use when                                                                      | What happens                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect on this machine**          | Someone can use the target Mac/Linux/Windows machine directly.                | Copy one pairing command; the installer detects capabilities and installs the reconnecting service.                                                |
| **Migrate an SSH-reachable machine** | The workspace already administers a machine such as the Mac mini through SSH. | Select the preconfigured host, verify its fingerprint, bootstrap the service, then pair it as a Runner.                                            |
| **Connect a Kubernetes GPU Runner**  | A persistent GPU devbox is currently managed with `kubectl`.                  | Select the preconfigured cluster context and dedicated namespace; Open Session deploys or upgrades the Runner workload, which then pairs outbound. |

Each path ends with a clear success state: Runner name, detected hardware,
permissions, and “online” status. Failure states show the exact failed phase
(SSH/Kubernetes connection, prerequisite check, service/workload install,
pairing, scheduling, or first connection) and a safe retry action. Do not
expose raw pairing tokens or private-key material after their one permitted
use.

The page is workspace-admin managed. Ordinary members may see only Runners
they can choose or use.

The Runner client installs a per-user LaunchAgent, systemd user service, or
Windows scheduled task so a dedicated machine reconnects after restart or
sign-in, as appropriate. The settings flow must make this operational
expectation explicit.

The SSH bootstrap screen may select a named host from the Open Session host's
protected SSH configuration, but must never accept or store a raw private key
in workspace settings. It shows the resolved host/user/port and requires a
pinned host fingerprint before executing anything. SSH credentials remain an
operator concern outside the workspace record.

## 2. Runner control protocol

Keep the versioned outbound Runner control protocol as the single transport.
Only command delegation is currently exposed in the product, although the
channel has typed support for future full-session, terminal, and Portal paths.
SSH or `kubectl` can bootstrap the Runner, but once attached the server never
dials into it; the Runner always connects outbound over the tailnet. There are
no SSH or Kubernetes runtime transport variants.

The protocol needs separate message families for:

- identity, heartbeat, capability/resource refresh, and health;
- command delegation with streamed stdout/stderr;
- workspace materialization and cleanup;
- full agent-run launch, control, event replay, and cancellation;
- terminal attach;
- Portal relay when enabled.

Every operation is tied to a Runner id, session id, short-lived operation
token, and audit record. The existing pairing token establishes the channel; it
is not reused as broad authority embedded in every operation.

Keep the protocol narrow. A Runner should not become a generic VPN or arbitrary
network proxy.

## 3. Internal MCP: `opensession-runners`

The current MCP server is `opensession-runners`. It is interactive-only,
absent from automations and from interactive resumes of automation-owned
sessions.

Current tools:

- `list_runners({ capability?, tag?, online? })` — inventory, suitability, and
  availability;
- `run_on_runner({ runner, command, cwd?, timeoutSeconds? })` — the existing
  streamed command-delegation behavior with clearer Runner identity;
- `runner_status({ runner })` — health, current workload, resources, and
  supported execution modes;
- `reserve_runner({ runner, reason, durationMinutes? })` — optional explicit
  reservation for scarce machines such as the GPU devbox or Mac mini;
- `release_runner_reservation({ runner })`.

Once full-session execution exists, expose a session creation target through
`opensession-sessions.create_session`, rather than making the Runner MCP create
an unrelated hidden session. The agent can ask for a visible worker session
whose execution target is a selected Runner.

Tool descriptions must state that a Runner is a trusted real machine, not an
isolated Sandbox. The agent should inspect capability/status first, avoid
destructive commands, and never assume a machine is available merely because
it exists in the inventory.

## 4. Runner routing and user choice

Keep automatic routing conservative.

- Do not silently send an ordinary session to a Runner.
- Once full-session execution ships, a user may explicitly choose an eligible
  Runner when creating a session.
- An agent may recommend or use a Runner for a focused delegated command when
  the task explicitly needs a capability, such as Xcode, Windows, CUDA, or a
  local model endpoint.
- Workspace policy may require a particular Runner for a tightly scoped class
  of work, but it must remain visible in the session UI.

Preserve the simple top-level default: **This machine** and **Sandbox**. Show
the named Runner choice only under an explicit “Other machines” affordance when
eligible Runners exist. This avoids making every ordinary session choose among
infrastructure.

Once full-session execution ships, a Runner-backed session will display the
Runner's name in its Runtime details. It will not be labelled Sandbox or claim
Sandbox isolation.

## 5. Full-session Runners

Add full-session execution only after the settings inventory and command
delegation are solid.

For a Runner-backed session:

1. The control plane selects an explicitly allowed, online Runner.
2. The Runner creates a session-owned workspace under an Open Session-managed
   root, rather than using an arbitrary existing checkout.
3. It clones/materializes the selected repository and branch with scoped,
   session-specific credentials.
4. It launches the existing run-host protocol there and streams events through
   the Runner control channel.
5. The server remains the durable owner of transcript, queue, approvals,
   collaboration, audit trail, and session metadata.
6. Terminals, diffs, file access, and Portals operate against that session
   workspace through the same session APIs.

This should reuse the remote run-host and sequence/ack replay contract already
used by remote Sandboxes, rather than introduce a second incompatible agent
transport.

Runner workspaces are persistent by policy, but are still session-owned. The
workspace retention, cleanup, and repository credential lifecycle need explicit
settings; no session may casually operate in the user's home checkout.

## 6. GPU and special-machine support

GPU Runners are not just machines with a `gpu` tag. Detect and report:

- GPU vendor, model, VRAM, driver, CUDA/Metal/ROCm availability;
- installed local inference runtimes and model endpoints, if opted in;
- media/ML toolchains such as ffmpeg, ComfyUI, PyTorch, and relevant CLIs;
- current resource use and concurrent-job capacity.

The Runner may advertise a local inference endpoint as a narrowly scoped
capability. Open Session must not automatically route arbitrary customer data
or all model calls to it. A workspace admin explicitly enables it, defines
which models/tasks may use it, and controls who can select it.

Use reservations and visible queueing for scarce hardware. A GPU devbox should
never have two expensive jobs accidentally contend just because both agents saw
the `gpu` capability.

For a Kubernetes Runner, the configuration also shows its cluster context
label, namespace, workload name, persistent-volume status, requested/assigned
GPU resources, and pod scheduling condition. Those are operator diagnostics;
the normal session UI still says simply which Runner is executing the work.

## 7. Portals from Runners

Runner services may use the same authenticated Portal abstraction as Sandboxes.

For a tailnet-reachable Runner, the control plane can reach a private service
directly, but the browser must still receive an Open Session-authenticated
Portal URL. Prefer the same reverse Portal relay model for consistent auth and
because many Runners will sit behind a restrictive firewall.

The Runner may expose only session-registered HTTP/WebSocket ports. It never
becomes a generic tunnel into the office network.

## 8. Security and trust model

Attaching a Runner is equivalent to giving Open Session a shell on that machine.
The current tailnet, one-time pairing, hashed token, and immediate-revocation
requirements remain mandatory.

Add:

- workspace-admin approval for pairing, configuration, and full-session mode;
- per-Runner allowed users, repositories, workspace roots, and execution
  modes, enforced server-side;
- interactive-only MCP enforcement at the runner layer;
- scoped session clone credentials, never the server's full environment;
- explicit local secret policy: do not read or inject a Runner user's arbitrary
  shell environment into sessions;
- audited command/full-session/terminal/Portal operations with Runner and
  session identity;
- bounded command time, output, concurrent runs, disk use, and resource quotas;
- a maintenance/offline state that fails clearly rather than queueing work on a
  sleeping laptop indefinitely.

The SSH bootstrap is privileged administration, not an agent tool. Restrict it
to workspace admins, pin the target host key, log the exact bootstrap action,
and limit it to the reviewed install/status/service commands. An interactive
agent never receives arbitrary SSH access merely because a Runner was added.

Kubernetes bootstrap follows the same boundary. Workspace settings retain a
named, operator-provisioned Kubernetes credential reference rather than raw
`kubeconfig` material. Its RBAC is limited to the dedicated Runner namespace
and the specific workload/PVC/service resources required for migration and
operator-initiated repair. Interactive agents receive Runner tools, never
direct `kubectl` credentials or a generic `kubectl exec` capability.

Runner access is a trust boundary, not a substitute for Sandbox isolation.
Untrusted ticket/webhook automation remains excluded unless a later, separate
security design establishes an isolated Runner profile.

## 9. Rollout phases

### Phase A — shipped product foundation

- Use Runner terminology across the product, API, CLI, settings, and MCP.
- Provide **Settings → Runners** inventory, pairing, operator-configured SSH and
  Kubernetes bootstrap, labels, tags, access policy, maintenance, command
  permission, status, and revocation.
- Install a reconnecting outbound Runner service and detect capabilities and
  resources, including GPU metadata.
- Provide `opensession-runners` command delegation, status, reservations,
  auditing, and policy enforcement.

Migrating specific operator-managed machines, including the SSH-reachable Mac
mini and Kubernetes GPU devbox described above, remains an operational rollout
step rather than a separate execution protocol.

### Phase B — future full-session admission and selection

- Extend current workload and reservation primitives with capacity-aware,
  clearly visible busy/offline UX.
- Expose full-session eligibility checks for users, repositories, and
  capabilities.
- Let session creation present eligible named Runners under Other machines.

### Phase C — future full-session execution

- Materialize session-owned workspaces on Runners.
- Reuse remote run-host transport, durable queues, terminal, diff, and file
  APIs.
- Add Runner-backed session lifecycle and workspace cleanup/retention.

### Phase D — future Portal and GPU integrations

- Add Runner support to the authenticated reverse Portal relay.
- Add opt-in local inference/model endpoint registration and routing policy.
- Add GPU capacity/reservation-aware work dispatch.

## Target acceptance criteria

- A workspace admin can migrate the existing SSH-reachable Mac mini into a
  launchd-managed Runner without storing its private key in workspace settings.
- A workspace admin can migrate and register the existing `kubectl`-managed
  GPU devbox as an online Kubernetes Runner, with its GPU and persistent
  workspace visible in Settings.
- A workspace admin can pair and manage a Mac mini or GPU devbox in Settings.
- An interactive agent can discover an online Runner by capability and run a
  streamed, audited command on it.
- Automations cannot access Runner tools or execute on attached machines.
- Revoking a Runner immediately terminates its live control channel.
- A full Runner-backed session has a durable server transcript and queue while
  its agent, terminal, files, and services execute on the Runner.
- Runner services can be exposed only through authenticated, session-scoped
  Portals.
- Local worktrees, Sandboxes, and Runners remain visibly distinct execution
  targets with no false claim of equivalent isolation.
