# Simple-mode install harness

Checks the install path on a fresh Ubuntu box. Requirements and the bar it
measures against: [adrs/simple-mode.md](../../adrs/simple-mode.md).

```sh
brew install lima              # once
bun test ./test/simple-mode/harness.test.ts      # ~10-20 min the first time (image + deps)
```

What it does: builds the release artefact for the VM's arch, starts a fresh
Ubuntu 24.04 VM with Lima (`lima.yaml`), runs `install.sh --artifact` in it
exactly as a customer would (no Bun, no clone), waits for the installer's own
user service to answer, and validates the box with Goss (`goss.yaml`). With
`SIMPLE_MODE_STRICT=1` it also runs the definition-of-done checks
(`goss.dod.yaml`: user service, linger, doctor, no tailscale/codex/source),
reboots the VM and checks again, then covers uninstall both ways (a committed
scratch worktree keeps the home; a clean tree is removed). STRICT passes
today. `SIMPLE_MODE_SOURCE=1` is the contributor path (git bundle,
`bun install` in the guest).

Useful:

```sh
SIMPLE_MODE_KEEP=1  bun test ./test/simple-mode/harness.test.ts    # leave the VM up
limactl shell opensession-simple                 # poke at it
SIMPLE_MODE_REUSE=1 bun test ./test/simple-mode/harness.test.ts    # re-run against it
SIMPLE_MODE_NOSUDO=1 ...                         # install as a user without sudo
SIMPLE_MODE_TARGET=host ...                      # no VM: run the steps here (CI runner)
OPENSESSION_TEST_CLAUDE_TOKEN=sk-ant-… ...       # also run one real turn
```

Modes: default installs the release artefact `scripts/build-release.ts` produces (what a customer gets); `SIMPLE_MODE_SOURCE=1` installs from a git bundle of the branch (the contributor path).

Files: `lima.yaml` (the VM), `goss*.yaml` (the assertions),
`harness.test.ts` (the driver, `bun test`), `.work/` (bundle, logs; ignored).
