# Portals and agent-to-agent communication

Open Session has both capabilities as product primitives, not just as names
for cloud sandboxes.

## Portals

A Portal is an authenticated HTTPS route from the Open Session host to a
service running in a session workspace, on this machine or inside the
session's Sandbox. The Portals panel lists the Portals a repository declares in
`.agents/portals.json` with a Start button, plus every service currently
listening in the workspace.

The agent has the same surface through `opensession-portals`:
`start_declared_portal` for a declared Portal, `start_portal` for any command,
`list_portals`, `stop_portal`, `restart_portal`, and `set_portal_path` for the
route a Portal should open on. Open Session allocates the port, runs the
process under a session-scoped supervisor with `PORT` and `PORTAL_URL`, waits
for it to listen, and returns the URL. Supervisor records live in the
workspace's `.ports.conf` next to the stable `*_PORT` entries repository
tooling reads:

```sh
# opensession-portal {"name":"web","key":"WEBAPP_PORT","command":"...","port":3300,"state":"awake"}
WEBAPP_PORT=3300
INSTANT_PORT=5968
```

Every listening `*_PORT` service is a Portal. Host services map to
`https://<host>:<port+6000>`; Sandbox services get an allocated route in
20000–27999 that relays over the Sandbox's authenticated outbound connection,
so the browser never receives a provider URL. Caddy forward-authenticates
every request against Open Session before proxying it, so possession of a
Portal URL does not bypass the app's sign-in boundary. A browser that opens
a Portal without a web session (a phone's Safari, opened from the native app
or the home-screen web app, keeps its own cookies) is redirected to the app
to sign in and then returned to the Portal; the cookie is host-scoped, so
one sign-in covers every Portal port on that host
(`src/server/portal-sign-in.ts`, `src/frontend/lib/portal-return.ts`).
Fetches and asset loads still get the plain 401. The route registry is
process-owned even though Caddy survives restarts: forward auth rejects a
retained route until the restarted server has rediscovered that exact port.

Portals follow the Sandbox lifecycle. While a Sandbox sleeps the panel still
shows its Portals, without URLs and without waking anything; the next wake
restarts every Portal that was awake, with the same command and port, after
`.agents/resume` has run. A provider that stops and restarts a Sandbox on its
own (an idle timeout) leaves the registry intact and the processes gone; the
next request to such a Portal relaunches the dead ones while it rebuilds the
relay (`src/server/sandbox-portal-recovery.ts`), so the first load waits for
the service rather than answering 502. Stopping a Portal removes its route.

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
