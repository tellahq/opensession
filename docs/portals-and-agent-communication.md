# Portals and agent-to-agent communication

Open Session has both capabilities as product primitives, not just as names
for cloud sandboxes.

## Portals

A Portal is an authenticated HTTPS route from the Open Session host to a
service running in a session workspace. A repo publishes services by writing
`.ports.conf`:

```sh
WEBAPP_PORT=3300
INSTANT_PORT=5968
WEBAPP_WORKFLOW_PORT=7233
```

Every parsed `*_PORT` entry appears under **Dev services**. A listening entry
gets a link only when Open Session can allocate and install a route; otherwise
it remains visible without an openable URL. The **Portals** panel labels a
listening but unroutable service unavailable, while **Dev services** still
labels it running.

Normal Portal routes support host worktrees, Docker, private Firecracker veth
addresses, and remote sandboxes. Caddy forward-authenticates the browser
against Open Session before proxying each route, so possession of its service
URL does not bypass the app's sign-in boundary. The browser never receives a
MicroVM's private address.

Two optional preview-pool backends are exceptions. A Daytona pool claim returns
a public provider URL directly, while a Firecracker pool claim uses a direct
Caddy proxy without forward auth. These origins do not inherit the Portal
sign-in guarantee.

The normal Portal route registry is process-owned even though Caddy survives
Open Session restarts. Forward auth rejects a retained Caddy route until the
restarted server has rediscovered that exact port, preventing a stale upstream
from being reused as somebody else's Portal. Stopping a dev server removes
every normal service route, not only the webapp route.

Sessions may expose an ad-hoc service by adding a descriptive `*_PORT` entry to
`.ports.conf` and listening on that port. Remote sandboxes use an authenticated
outbound relay: Daytona, E2B, Box, Modal, and lambda-microvm start a short-lived
sidecar for each listening port as status discovers it. Docker and self-hosted
microVM routes are limited to the configured preview-port set; other listening
services remain visible without an openable URL.

The Preview button normally opens the `WEBAPP_PORT` Portal, but can instead open
a preview-pool origin when that feature is enabled for the repo. The service
menu is the multi-port surface. `.agents/start.sh` receives `WEBAPP_PORT`,
`PREVIEW_URL` and `OPENSESSION_BOOT_MODE`, while `.tunnels.env` exposes the
generated Portal URLs back inside the workspace as `PREVIEW_URL`,
`PREVIEW_URL_<port>` and `PORTAL_<service>_URL`. The same contract now applies
to host worktrees and sandbox-only workspaces.

Current boundary: Portals inherit the instance's authenticated team boundary;
there is no per-session ACL narrower than that team boundary yet.

## Agent-to-agent communication

Interactive agents receive the `opensession-sessions` tools. Together they
cover the full worker lifecycle:

| Capability                    | Tool                                           |
| ----------------------------- | ---------------------------------------------- |
| Discover and inspect sessions | `list_sessions`, `get_session`                 |
| Start a peer or worker        | `create_session`, `spawn_task`                 |
| Send or steer work            | `send_to_session`                              |
| Answer a blocked worker       | `answer_session_question`                      |
| Poll and stop delegated work  | `task_status`, `cancel_task`, `cancel_session` |
| Transfer an artifact          | `send_file_to_session`                         |

`send_to_session` steers a live run when possible and otherwise queues a new
turn, so a message is not lost at a run boundary. Queued and just-steered
messages are persisted across Open Session restarts. Every send returns a
stable delivery receipt, carries that id through the queue/steer receipt, and
emits a content-free audit event with source, target and accepted state.
Messages are attributed as `agent <session-id>` (or `worker <session-id>` for a
parent report), never as the human whose identity the session inherited.
Spawned workers are linked to their parent in the UI and instructed to report
back; their report includes a server-computed evidence block. The parent
remains responsible for the final decision.

`send_file_to_session` is binary-safe and works when the sending workspace
exists only inside a sandbox. It copies one relative workspace or Assets file
(maximum 4 MiB) into the recipient's Assets inbox and notifies the recipient
with the exact asset path. It rejects absolute paths and lexical traversal
components. Workspace sources currently do not reject symlinks, and the content
read follows them, so a relative-looking path can escape the workspace or reach
mounted credentials. Do not treat the source-path check as a security boundary.

Security boundary: these cross-session controls exist only for trusted
interactive runs. Automation-owned sessions get the scoped task suite when
explicitly allowed, never the general session-control plane.
