---
name: verify-opensession
description: Drive the Open Session web UI against an isolated demo server and capture proof for session, workspace, automation, goal, archive, or settings changes.
---

# Verify Open Session

Use this skill for user-visible work in Open Session's primary client, the server-hosted web UI and phone PWA. The repository also ships Electron, native Swift, and Chrome extension clients. This skill does not prove their client-specific behavior.

Never point these commands at `https://os.tella.dev`, port 3850, or `scripts/frontend-dev.ts`. Those paths use production state. The launcher below starts a fresh demo instance with private gateway and SessionKernel ports, process groups, a browser profile, and a state directory.

## Launch

This recipe currently requires Linux with a reachable systemd user manager, Google Chrome, Xvfb, `ss`, and `jq`. From the repository root, install dependencies if `node_modules` is absent, then start one run:

```bash
bun install --frozen-lockfile
export RUN_ID="verify-$(date +%Y%m%d-%H%M%S)-$$"
./.agents/skills/verify-opensession/bin/verify-opensession launch "$RUN_ID"
```

The command prints `APP_URL`, `STATE_DIR`, and `EVIDENCE_DIR`. It starts the real Bun gateway and SessionKernel with a shared scratch credential, `OPENSESSION_DEV=1`, `OPENSESSION_DEMO=1`, and a disposable `OPENSESSION_STATE_DIR` under `/tmp`. The demo seed supplies sessions, transcripts, a repository, pull request state, automations, and a paused goal. External agents, schedulers, webhooks, executor work, and live credentials stay off.

The instance is ready when launch returns successfully. Its log remains at `/tmp/opensession-verify-$RUN_ID/server.log` until cleanup.

Teardown what this run started:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession cleanup "$RUN_ID"
```

Run cleanup after failed attempts too. Each run has a separate port, browser profile, and state directory, so concurrent runs are safe when their `RUN_ID` values differ.

## Doctor

Run this before driving the UI and whenever the page or browser looks wrong:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession doctor "$RUN_ID"
```

Doctor checks the exact server PID, port owner, launch commit, boot ID, disposable state environment, auth status, health endpoint, and private CDP browser. A changed checkout commit fails the check because the running backend may no longer match the files under review. Clean up and launch again rather than driving a stale process.

## Drive

The helper controls the run's private Chrome page over CDP. It uses the accessibility tree for element lookup and dispatches browser mouse and keyboard input. Use exact accessible roles and names from the current feature map.

Open a desktop route:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" open --route /goals --width 1440 --height 900
```

Open the phone web client by changing the viewport. Widths at or below 720 use mobile emulation and a device pixel ratio of 3:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" open --route /session/bks-demo-pr --width 390 --height 844
```

Common actions:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" wait --role heading --name "Goals"
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" click --role button --name "New goal"
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" fill --role textbox --name "Name" --value "Verification goal"
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" press --key Escape
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" url
```

`wait`, `click`, and `fill` require one exact accessible match. Add `--index 1` only when the UI intentionally exposes duplicate names. A lookup failure prints nearby names for that role. Use `snapshot` to inspect the current tree instead of guessing selectors:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" snapshot
```

Read a user-facing API response from the same isolated instance when persistence needs a second view:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession api "$RUN_ID" /api/goals | jq .
```

Read `features/README.md` first, then the relevant feature file. The map lists every known entry point. Verifying one convenient route does not prove the others.

## Evidence

Keep proof under the launcher's printed directory:

```text
artifacts/verification/opensession/$RUN_ID/
```

Capture the state before or during the action and the resulting state. For a web change, save an accessibility snapshot and screenshot at both 1440x900 and 390x844 unless the feature is explicitly client-specific. Example:

```bash
EVIDENCE_DIR="$PWD/artifacts/verification/opensession/$RUN_ID"
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" snapshot --path "$EVIDENCE_DIR/goals-after.aria.txt"
./.agents/skills/verify-opensession/bin/verify-opensession browser "$RUN_ID" screenshot --path "$EVIDENCE_DIR/goals-after.png"
./.agents/skills/verify-opensession/bin/verify-opensession api "$RUN_ID" /api/goals | jq . >"$EVIDENCE_DIR/goals-api.json"
```

A valid proof exercises the real user route, not an internal state setter or test-only endpoint. Show the action and result, not only the final page. For mutations, confirm the saved value through another user-visible view or a read-only API response. Do not claim an engine turn, external message, webhook, push, or integration ran in this demo instance. Those systems are intentionally disabled. Do not replace them with mocks unless the production boundary already uses a mockable adapter, and name that limit in the report.

For screenshots worth returning to the user, include the absolute path as `OPENSESSION_IMAGE: /absolute/path.png`.

## Cleanup

Cleanup stops the exact systemd browser unit, gateway process group, and SessionKernel process group recorded at launch, then removes only `/tmp/opensession-verify-$RUN_ID`. It does not kill by process name and never removes proof:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession cleanup "$RUN_ID"
test -d "$PWD/artifacts/verification/opensession/$RUN_ID"
```

The disposable demo mutation disappears with the state directory. Evidence under `artifacts/verification/opensession/` survives.

## Helpers

Both shipped helpers are executable:

- `bin/verify-opensession` owns launch, doctor, API reads, browser delegation, and cleanup. Invoke it exactly as shown above.
- `bin/browser.mjs` is the CDP implementation. Do not call it directly because it needs run metadata. Use `verify-opensession browser`.

The browser subcommands are `open`, `click`, `fill`, `press`, `wait`, `snapshot`, `screenshot`, `url`, and `eval`. Reserve `eval` for read-only diagnosis. It is not acceptable proof of a user path or mutation.
