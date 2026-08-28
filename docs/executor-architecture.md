# Executor architecture

Open Session separates authoritative session decisions and run-host launch
policy from the gateway process.

```text
Clients -> gateway <-> session-kernel service
                   \-> executor launcher -> run host -> engine
                       + fixed policy
```

Over authenticated loopback RPC, the gateway uses the independently supervised
session-kernel service for authoritative prompt admission and durable run,
queue, ask, timer, outbox, and lifecycle decisions. It uses the executor
launcher for detached local run-host launch policy. The gateway retains HTTP
and WebSocket handling, schedulers, run journals, transcript writes,
projections, and physical effects.

The executor launcher can only start, inspect, or stop a detached local run host
from a persisted `RunHostSpec`. It cannot execute an arbitrary command, accept
an arbitrary path, or change systemd properties.

## Control protocol

The gateway and executor communicate over `executor.sock` in the active session
state directory. The socket is mode `0600`. Messages are newline-delimited JSON
using `@tellahq/opensession-protocol/executor`.

Every request carries a request id. Launches are idempotent by host id and the
SHA-256 hash of the persisted spec. Reusing a host id with different spec bytes
is rejected. Major protocol versions are negotiated before launch and an
incompatible service fails closed.

Linux units receive a shared bearer token through systemd credentials. The
token prevents detached run-host units from using the control protocol through
the normal launch environment. It is defense in depth, not a hard isolation
boundary: the gateway, executor, and local agents still use one Unix identity.
A future executor security boundary requires run hosts to use a distinct
identity or the executor to authenticate peer processes through the kernel.

Before recording and launching, the executor verifies the persisted spec's
SHA-256 and matching host id. The root-owned helper then validates the host-id
format, exact configured host directory, spec presence, and hash format before
applying its fixed `systemd-run` policy. The run host recomputes the hash at
startup and refuses spec bytes changed after executor validation.

The installer grants the service user passwordless sudo for the root-owned
helper and four fixed `systemctl` invocations used to restart the gateway or
executor and check executor readiness. It does not grant passwordless access to
raw `systemd-run` or arbitrary `systemctl` arguments. If the executor restarts
while a launch is in progress, the next request reconciles the existing unit and
host socket instead of starting a second run.

## Capacity controls

Before persisting a detached launch, the gateway checks the active and pending
host count, Linux `MemAvailable`, and CPU PSI `some avg10`. A launch waits with
bounded backoff when a present signal is over its limit. Missing `/proc` signals
fail open so non-Linux development remains usable. After the admission timeout,
the turn fails visibly instead of falling back into the gateway process and
consuming the same scarce resources.

Gateway settings can be placed in `~/.opensession.env`:

| Setting                                         | Default | Purpose                                  |
| ----------------------------------------------- | ------: | ---------------------------------------- |
| `OPENSESSION_RUN_HOST_MAX_ACTIVE`               |     128 | Active plus admitted detached hosts      |
| `OPENSESSION_RUN_HOST_MIN_AVAILABLE_MB`         |    4096 | Memory headroom retained for the machine |
| `OPENSESSION_RUN_HOST_RESERVED_MB`              |    1024 | Memory reserved for each pending launch  |
| `OPENSESSION_RUN_HOST_MAX_CPU_PRESSURE`         |      85 | Maximum CPU PSI `some avg10` percentage  |
| `OPENSESSION_RUN_HOST_ADMISSION_TIMEOUT_S`      |     900 | Maximum capacity wait before refusal     |
| `OPENSESSION_ONESHOT_CONCURRENCY`               |       4 | Concurrent gateway one-shot jobs         |
| `OPENSESSION_OPENING_TURN_CONCURRENCY`          |       8 | Concurrent session opening turns         |
| `OPENSESSION_KERNEL_TIMER_CONCURRENCY`          |       8 | Concurrent durable timer effects         |
| `OPENSESSION_KERNEL_OUTBOX_CONCURRENCY`         |       8 | Concurrent general outbox effects        |
| `OPENSESSION_KERNEL_OPENING_OUTBOX_CONCURRENCY` |     100 | Concurrent opening-turn effects          |

The independently supervised executor does not read `~/.opensession.env`. Set
`OPENSESSION_EXECUTOR_LAUNCH_CONCURRENCY` (default 8) with an `Environment=`
systemd drop-in on `opensession-executor.service`. The session kernel likewise
keeps the application/secrets environment outside its service boundary. Its
worker count scales to available CPUs (16 on the production host), while the
root deploy installs a dedicated 4G `MemoryHigh` / 6G `MemoryMax` capacity
drop-in for the authoritative kernel process.

All overrides are bounded integers. Invalid or out-of-range values log an error
and retain the built-in default.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Executor unavailable before detached launch | Delegated launch fails closed and does not invoke the direct helper. `runAgentHosted` logs the failure and falls back to in-process execution unless launch effects are ambiguous. |
| Executor incompatible | Detached launch fails without a direct-helper fallback. `runAgentHosted` logs the failure and falls back to in-process execution. |
| Executor disconnects after launch request | The gateway checks the host locally and retries through the executor, then preserves recovery state if the launch remains uncertain. |
| Executor restarts during an active run | Run host and engine continue; the gateway remains attached directly. |
| Gateway restarts during an active run | Existing run-host journal and socket reattachment recover the turn. |

The executor is not the parent of active run hosts. Hosts run in transient
systemd units, so restarting `opensession-executor.service` affects only launch
requests currently crossing the control socket.

## Deployment

Linux system scope installs three units:

- `opensession.service`: gateway, schedulers, projections, transcripts, and
  physical effects.
- `opensession-session-kernel.service`: authoritative durable session decisions.
- `opensession-executor.service`: fixed-policy local run-host launch.

The gateway `Requires=` the kernel service and `Wants=` the executor. The
executor has no `PartOf=` relationship. Linux user scope installs the gateway
and kernel units but disables the executor and detached local runs.

A source release is one pinned gateway + kernel + executor version. Both rollout
paths restart and readiness-check the executor and kernel before starting the
gateway; a kernel replacement always happens while the gateway is stopped. The
executor can still be restarted independently for operational recovery because
it is not the parent of active run hosts, but that is not a source deployment.

The standard `deploy_self` path reuses the installed root-owned units,
credentials, helper, sudo policy, and drop-ins. The full root
`deploy/deploy.sh` path synchronizes those privileged artifacts before switching
the same immutable release. Use the full path when a release changes its live
deploy controllers, `opensession*.service`, credential installers, fixed
run-host helper/installer, or a systemd artifact managed by the root script.
Other operator-managed artifacts keep their own rollout procedures. Generic
installations that change service-rendering behavior may also need
`opensession service install` rerun explicitly.

During the first upgrade only, installations that already granted the previous
fixed `systemd-run` launch command keep using it until the service installer
puts the root-owned helper in place.

Set `OPENSESSION_EXECUTOR=0` to deliberately bypass the sidecar and select the
fixed direct helper path for an otherwise supported detached host. Existing run
hosts are unaffected. An unavailable configured executor never falls through to
the direct helper, although the run may fall back to in-process execution after
logging the detached-launch failure.

Detached local hosts require Linux with a booted systemd and the installed
run-host helper. Other platforms keep using the in-process runner.

## Scope

The executor is an independently restartable launch-policy boundary, not a hard
security sandbox. Its unit does not load the application EnvironmentFile and
receives only path settings plus its systemd credential directory. The gateway,
executor and run hosts still share one Unix identity; a future privilege boundary
requires a distinct executor identity and peer credentials.

Normal production detached launch has one path through the executor. The direct
fixed helper remains only as an explicit operator bypass for recovery and
development.
Active hosts are still controlled directly through their private host protocol;
the executor is not their parent and does not own session lifecycle.

### Agent Host execution binding

An Agent Host turn carries an immutable Executor binding: executor and root IDs,
generation, deadline, and an opaque Agent Host access capability. That access
capability authorizes only bounded control-plane dispatch requests. It is
branded separately from an `ExecutorGrant` and is never valid at an
`ExecutorBroker` or Executor daemon. The control plane must issue a fresh,
exact operation-scoped `ExecutorGrant` for each eventual dispatch.

A separate additive Agent operation v1 foundation now defines a distinctly
branded `AgentGatewayDispatchGrant`, non-secret model and MCP descriptors, and a
gateway receipt ledger. It remains production-unwired: the gateway does not
issue the grant, route Host operation messages, resolve provider/MCP access, or
open the ledger at boot. The grant is never persisted. Recovery must reacquire
short-lived authority while durable identity remains bound to the exact turn
fence and domain-separated descriptor/payload digests. This foundation does
not make an Agent operation an Executor operation and never accepts an
`ExecutorGrant` in its place.

The Agent Host contracts define these boundaries but do not route production
turns or wire boot. The disabled detached process and systemd socket-activation
foundation is documented in [Agent Host deployment](agent-host-deployment.md).
Installing its privileged templates requires a full root deploy; installation
does not enable or start them.

## Rollback compatibility

The session-kernel schema has a tracked compatibility version. Before restarting
the kernel service, self-deploy records the highest schema that may have opened
the durable database and refuses an automatic rollback to a revision with an
older or missing reader. This turns an unsafe rollback into an explicit operator
action instead of letting an old binary replay indeterminate physical work.
