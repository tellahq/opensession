# Detached Agent Host canary qualification

`canary-qualification.ts` is a production-unwired, import-inert qualification
harness for a detached Agent Host candidate. It does not install routes, send
signals, start processes, contact services, or deploy a generation. An operator
must provide policy-approved probes and decide separately whether a qualified
report is sufficient to activate anything.

## Qualification plan

The harness runs each case as one logical operation:

1. Submit one operation constrained to `agent-host`, with infrastructure fallback
   disabled and a physical retry limit of zero.
2. Wait for independent evidence that physical execution started.
3. Apply exactly one injected scenario intervention.
4. Read the visible terminal result and ACK/replay observations.
5. Read Host dispatch, physical-effect, generation, fallback, and path evidence.
6. Read exact transcript, operation, and kernel receipts.
7. Read the terminal transcript entry.

The deterministic scenario matrix is:

| Scenario                  | Required injected events                                      | Terminal  |
| ------------------------- | ------------------------------------------------------------- | --------- |
| `normal`                  | none                                                          | completed |
| `gateway-sigkill-restart` | gateway SIGKILL, gateway restarted                            | completed |
| `host-sigkill-restart`    | Host SIGKILL, Host restarted                                  | completed |
| `disconnect`              | transport disconnected, transport reconnected                 | completed |
| `cancellation`            | cancellation requested, cancellation acknowledged             | cancelled |
| `key-rotation`            | key rotated                                                   | completed |
| `blue-green-drain`        | generation draining, generation activated, generation drained | completed |

“SIGKILL” in this table names evidence supplied by the process probe. The
harness itself has no process or signal capability.

## Fail-closed evidence contract

A case qualifies only when all of the following are established:

- exactly one logical operation and one Host dispatch;
- exactly one model effect, one MCP effect, and one Executor effect, each from a
  distinct independently maintained counter;
- zero physical retries;
- exactly one visible terminal gateway result;
- exactly one transcript receipt, operation receipt, and kernel receipt, all for
  the operation and terminal state;
- exactly one matching visible terminal transcript entry;
- non-empty, non-negative, monotonic ACK and replay sequences, with replay never
  ahead of ACK;
- the execution generation exactly equals the non-empty active generation;
- `infrastructureFallback` is exactly `false`;
- the complete observed path list is exactly `agent-host`, excluding
  `runner-host`, `direct`, mixed, and unknown paths; and
- exact, ordered intervention evidence for the selected scenario.

Missing, duplicate, mismatched, invalid, or extra evidence fails qualification.
Every probe call is wrapped by an injected per-step deadline. A deadline or
probe error fails closed. Probe error text and operation identifiers are not
included in reports.

If a kill leaves physical completion ambiguous, the harness returns
`indeterminate` with `AMBIGUOUS_EFFECT`. It stops collecting downstream success
evidence and never resubmits or retries the physical operation. Indeterminate is
not qualified.

## Probe boundary

Call `qualifyDetachedAgentHostCanary(scenario, probes)` with injected gateway,
Host, process, receipt, transcript, and deadline probes. The deadline probe owns
all clocks and timers, making qualification deterministic under tests and
keeping module import inert.

Reports are deliberately small and redacted:

```ts
{
  version: 1,
  scenario: "host-sigkill-restart",
  outcome: "qualified" | "failed" | "indeterminate",
  codes: ["QUALIFIED" /* or one fixed failure code */],
  redacted: true,
}
```

Codes are a fixed vocabulary. Do not extend the report with raw exceptions,
transcript text, receipt bodies, credentials, keys, process output, or IDs.
Store detailed evidence only in the organization-controlled system that
implements the probes.

## Non-activation

This harness is intentionally not exported from a server composition module and
is not called by boot, deployment, health, readiness, or routing code. Adding a
production probe implementation or using a report as an activation gate is a
separate security and rollout change. Qualification alone must not change the
active generation.
