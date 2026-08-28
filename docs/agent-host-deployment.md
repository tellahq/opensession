# Detached Agent Host deployment foundation

The detached Agent Host topology is installed but **not activated**. No gateway
route selects it, no socket instance is enabled, and there is no gateway-local
or runner-host fallback. Do not enable a generation until the gateway routing,
SessionKernel signing composition, ledger calibration, and recovery policy have
all been approved.

## Process and filesystem boundary

A future generation is a matched pair:

- `opensession-agent-host@<generation>.socket` creates the root-owned
  `/run/opensession/agent-host-<generation>.sock`. Its mode is `0660`, owner is
  root, and its group is exactly `opensession-gateway`.
- `opensession-agent-host@<generation>.service` runs as the exact
  `opensession-agent-host` user. It accepts only the inherited descriptor named
  `agent-host`, proves that it is a listening AF_UNIX socket, and verifies the
  exact numeric `opensession-gateway` UID with `SO_PEERCRED` before reading a
  protocol frame. Production never unlinks, binds, chmods, or replaces the
  socket path.
- Each generation receives `/var/lib/opensession/agent-host/<generation>` as a
  private `0700` `StateDirectory`. Its `recovery-ledger.sqlite` is opened by
  that generation only. The ExecStartPre doctor opens and closes the same
  ledger serially before the service becomes its sole writer.

The process has a 24-hour maximum lifetime and a bounded 15-second application
drain inside systemd's 20-second stop bound. The unit uses systemd hardening
compatible with Bun JIT/FFI and SQLite. In particular, it does not claim
`MemoryDenyWriteExecute` or an untested syscall allowlist.

## Service identities

`deploy/install-agent-host-topology.sh` idempotently creates four distinct,
nologin system accounts and groups:

- `opensession-gateway`
- `opensession-session-kernel`
- `opensession-agent-host`
- `opensession-executor`

It also creates root-controlled runtime, state, and credential parents and
installs the service/socket templates. It does not change the `User=` of any
current service and does not enable or start Agent Host units.

## Credentials

Secrets are never accepted in argv or ordinary environment variables. A future
generation requires these root-owned source files:

- `/etc/opensession/credentials/agent-host/<generation>/ledger-keyring.json`
- `/etc/opensession/credentials/agent-host/<generation>/supervision-keyring.json`

Systemd projects them as `agent-host-ledger-keyring` and
`agent-host-supervision-keyring`. The entrypoint requires each projected file
to be a root-owned, regular, single-link `0400` file and rejects absent,
oversized, redirected, or malformed values. The ledger credential is strict
JSON with `version: 1`, one active key ID, and at most four keys. Encryption keys
are exactly 32 bytes and lookup keys are at least 32 bytes, encoded as canonical
unpadded base64url. The public supervision credential is the strict protocol-v2
Ed25519 public keyring.

The private supervision signing key belongs only to the future
`opensession-session-kernel` identity. The uninstalled template at
`deploy/systemd/agent-host-unactivated/opensession-session-kernel.service.d/agent-host-signing-credential.conf`
shows the only permitted systemd credential projection. Never place that key in
an Agent Host unit. Installing that drop-in is a separate production activation
step and is intentionally outside this foundation.

Startup and doctor failures emit only a generic message. Credential contents,
paths supplied by a caller, and nested parsing errors are not logged.

## Installation and rollout

These files are root-deploy-managed artifacts. After review, installing them
requires the full root rollout:

```sh
sudo deploy/deploy.sh <commit-sha>
```

A light self-deploy is insufficient. The initial rollout only creates identities,
directories, and disabled unit templates. Do **not** run the full deploy merely
to test this foundation, and do not manually start, enable, or restart a unit.
Validate source changes with the focused Bun tests instead.
