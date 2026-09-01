# Gateway handoffs

Open Session can promote gateway-only releases without an active-active window.
The SessionKernel and executor stay on their current release during this narrow
path; changes to either peer, dependencies, protocol surfaces, deployment
machinery, or service units use the coordinated rollout instead.

## Ownership invariants

1. Exactly one gateway may cross the activation boundary. systemd owns the
   stable public TCP socket and passes it to `opensession-ingress.service`, a
   tiny process independent from gateway and protocol-peer rollout. Gateway
   children bind private loopback backend ports.
2. Every gateway acquires the OS-backed `gateway-active.lock` before touching
   shared state, binding a listener, starting a Worker or timer, or contacting
   an integration.
3. A standby may statically import code, validate peers, and hydrate its
   prepared frontend in memory, but waits on authenticated parent IPC before
   acquiring the lease or producing shared effects.
4. The supervisor sends activation only after the old child has exited.
5. After the old child exits, the supervisor atomically moves the immutable
   runtime pointer before activation. Coordinated releases require all three
   processes to report the target generation. Gateway-only releases carry the
   peers' retained generation separately from the gateway's own release.
6. Coordinated rollback parks the target gateway first, restores the pointer
   and both peers, and only then admits the previous gateway. Mixed generations
   never run during recovery.

The lease is an independent fence, not an optimization. If the supervisor is
stale or crashes, a replacement child fails closed while the surviving gateway
still holds the lock.

## Handoff sequence

`deploy/self-deploy.sh` prepares and validates the candidate frontend first. A
generated import-closure manifest then chooses one of three flows:

- Frontend only: restart-free frontend pointer promotion.
- Gateway only: preload candidate, drain old child, observe exit, atomically
  move `current`, activate, then require `/ready`.
- Protocol, executor, or SessionKernel changes: park the preloaded candidate,
  replace both protocol peers behind stable ingress, then activate after the
  gateway, kernel, and executor all report the target generation.
- Supervisor, service-unit, or privileged deploy machinery changes: use the
  root rollout. The systemd-owned socket remains bound while the supervisor is
  replaced.

During a gateway handoff, the old process continues serving while it performs
its bounded shutdown drain. The independent ingress keeps the public TCP
listener bound throughout cut-over. Human page loads and immutable assets come
from the last rendered frontend snapshot immediately, while API and WebSocket
connections wait for the candidate backend. Social crawlers still reach the
backend so session-specific metadata is preserved. Web and native clients
receive `server_restarting`; they retry every 250ms until the candidate
handshake.

## Failure behavior

- Import or preload failure: kill the inert candidate; old gateway remains
  authoritative and `current` does not move.
- Old gateway misses its exit deadline: kill the inert candidate and keep the
  pointer unchanged. Operators investigate the old process rather than risk a
  second writer.
- Candidate fails after activation: park it with no active backend, restore
  `current`, executor, and SessionKernel, then start the previous immutable
  gateway and require matching-generation readiness.
- Candidate and rollback both fail: the supervisor exits so systemd performs a
  clean service-level recovery. The ingress remains active and keeps serving
  the app shell. The OS lease still prevents overlap.
- Frontend preparation failure: no lifecycle marker, pointer, schema floor, or
  service state changes.

The regular watchdog and last-known-good pin remain armed after a successful
handoff and can perform a coordinated rollback if later health probes fail.

## Coordinated peer handoff

For dependency and protocol releases, `prepare-coordinated` preloads the target,
drains the old gateway, atomically promotes `current`, and leaves the candidate
behind its activation barrier. The deploy controller restarts both peers in
parallel while stable ingress serves reloads and parks backend connections.
Only after both peers report the target generation does `activate-coordinated`
release the candidate. The controller commits after the external health gate;
until then it can park the target for a fail-closed peer rollback. Every phase is
atomically journaled in `gateway-handoff.json`, allowing a restarted supervisor
to reconcile against the authoritative `current` pointer. A three-minute
deadline terminates an abandoned preparation and supervisor rather than
guessing protocol compatibility.

Each deploy also writes its generated dependency-impact manifest and runs a
continuous HTTP/WebSocket canary. Sequential requests wait for a 15-second quiet
window and collapse to the newest explicitly requested commit. Root deployment
refuses already-current, stale, non-main, and ordinary unprivileged targets.
The stable `/live` response exposes ingress metrics for accepted,
fallback-served, queued, retried, overload-rejected, and timed-out connections
plus maximum backend wait, so handoff latency and loss are directly observable. Backend parking is bounded to 2,048 connections. When
no generation is selected, retries use capped exponential backoff and do not
open doomed loopback sockets; an overload still gets a short chance to receive
the stable shell before backend-only traffic is rejected. The rendered shell and
immutable assets use a release-aware 64 MiB LRU, avoiding repeated synchronous
snapshot parsing and asset reads during reload bursts. Root rollouts use the same
coordinated transaction. Supervisor source changes only replace the control
process; ingress and its accepted connections remain untouched.
