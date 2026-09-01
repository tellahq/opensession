# Effective config

`GET /api/sessions/:id/effective-config` prints a forecast for a session's next
interactive `prompt` turn, including a prompt that resumes an existing engine
session. Each row names the file or code path that produced it.

The report combines `mcp-config.json`, session, automation, or feed MCP scope,
the session model or instance-wide interactive default, workspace model
presets, and run-policy resolvers. It does not report Pi enablement, provider
credentials, or engine readiness. It also does not forecast scheduled
automations, goal wakes, create turns, or other journal kinds.

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3850/api/sessions/os-…/effective-config | jq .
```

Query parameters:

| Param       | Meaning                                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`      | Claimed prompt user when sign-in is off. With sign-in enabled, the verified identity wins through `requestUser`. Automation-owned sessions drop the prompt user. In this report, a server's `allowedUsers` gate may also be cleared by the session creator (`startedBy`). No shared-server key is returned. |
| `verbose=1` | Add the static ask-mode bash allowlist.                                                                                                                                                                                                                                                                     |

On a signed-in instance, an ordinary interactive session is evaluated for the
signed-in caller. A request authenticated as the `Automation` machine identity
therefore reports `identity.user: "Automation"`, not the session owner.

Auth is the same as every other session route. The endpoint is read-only and
does not pick from or mutate an account pool.

## Reading the output

Every leaf is a row:

```json
{
  "value": ["grafana", "incident"],
  "source": "session-run-inputs.ts MCP scope",
  "stability": "load-dependent",
  "note": "…"
}
```

Only `account.pinned` is currently marked `load-dependent`. Its ID is the
persisted `session.accountId`; its Claude-account display-name lookup can change.
The endpoint does not predict a pool selection. The report is a forecast, not a
contract: fallback routing and account selection are resolved at dispatch.

## Sections

| Section        | Answers                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution`    | A coarse Runner, sandbox, or host target, plus working directory, branch, session mode, and sandbox selection.                                                                                                                                      |
| `gate`         | Whether hard-coded run kind `prompt` passes `runGateReason`. This is not a Pi enablement or engine-readiness check, so `allowed` can be true even when dispatch will refuse.                                                                        |
| `model`        | Requested ID, Pi dispatch ID and provider, model preset, effort, fast mode, fallback, steer support, and account-pool type.                                                                                                                         |
| `account`      | The persisted `session.accountId` pin and its Claude-account display name when found. It does not predict account selection, reason, availability, rotation, required models, or pool-dry state.                                                    |
| `mcp`          | The resolved allowlist. The response does not expose whether it came from the automation, session, feed, or unscoped branch. It also lists configured and allowlisted servers with their inclusion result, plus the in-process `opensession-*` set. |
| `tools`        | The unattended-policy flag and tools stripped from the model's list, with their source catalogs.                                                                                                                                                    |
| `agents`       | Oracle and orchestrator-worker subagents resolved for the routed provider.                                                                                                                                                                          |
| `memory`       | The `~/.opensession/memory` scopes included when session context is enabled.                                                                                                                                                                        |
| `placement`    | A coarse mode and `restartSafe`, which is currently always `true`. It does not report shared-server placement, a reason, or a pool key.                                                                                                             |
| `identity`     | The attributed run user, resolved commit author, per-user GitHub login when applicable, and resolved instance paths. It omits the MCP OAuth grant user and the simple-mode sole GitHub account.                                                     |
| `instructions` | Sources composing the Pi system prompt. Contents are never returned; `AGENTS.local.md` remains instance-private.                                                                                                                                    |

## Important caveats

**MCP creator grants.** The report evaluates `allowedUsers` against both the
prompt user and `startedBy`. Live dispatch for an automation-owned session
withholds that creator grant, so `mcp.servers` can overstate creator-gated MCP
visibility and OAuth-grant availability for those sessions.

**Execution placement.** Do not use `execution.target` to diagnose an
unavailable selected sandbox or detached-host eligibility. The report can say
`host` where dispatch will fail rather than cross a sandbox boundary. It also
does not inspect `OPENSESSION_PI_DETACH`, local host support, or the
`disable-run-hosts` file; a reported detached host may run in process instead.

**`gate.unattendedKind` and `tools.unattended`.** An interactive resume of an
automation-owned session uses run kind `prompt`, so `gate.unattendedKind` is
false, while the automation's denials make `tools.unattended` true. This keeps
the automation's restricted tool policy on a manual resume.

## How it stays honest

The endpoint reuses `resolveSessionRunInputs`, `routeModel`,
`filterMcpServers`, `runToolPolicy`, and `sessionMemoryScopes`. The shared
session-run-input decision keeps MCP scope, automation denials, and run-user
handling aligned with an interactive prompt dispatch.

Account selection and execution placement are not resolved through dispatch
and must be treated as incomplete forecasts. The MCP creator-grant exception
for automation-owned sessions is described above.

`explainMcpServers` only attributes `filterMcpServers` output, and
`describeStrippedTools` only attributes `runToolPolicy` output. Those helpers
are pure and tested in
`packages/core/opensession-server/src/server/effective-config.test.ts`.

## Calling it from a script

Importing or calling `buildSessionEffectiveConfig` does not bind a socket.
`interactive-mcp.ts` only registers an in-memory builder at module scope;
`opensession.ts` explicitly starts the run-rpc and MCP HTTP listeners during
boot. The import remains lazy so basic config inspection does not eagerly load
every interactive tool builder.

A standalone call still reads the configured session and instance state. Point
`OPENSESSION_STATE_DIR` at isolated state for a probe, or call the endpoint over
HTTP to inspect the running server's actual configuration.
