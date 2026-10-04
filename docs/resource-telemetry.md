# Agent resources

Open Preferences, then Debug, and turn on Agent resources. The panel lists local
sessions by CPU and resident memory, with host totals. Stop agent uses the normal
session cancellation path; it does not stop scripts, portals or interactive shells. Close the panel
or hide the browser tab to stop collecting. No telemetry is written to disk.

CPU is measured between samples, with one core equal to 100%. A session may exceed
100%. RSS includes shared pages, so summing process memory can overcount physical
memory. Host memory is the operating system's total minus free memory, including
some reclaimable cache. Processes that start and exit between samples are missed.
Remote runners and sandboxes are not part of these host totals.

## Contributor invariants

- Collection runs in a disposable Bun child, not on the gateway thread. The child
  probes `ps` on macOS and Linux, and reads Linux process counters without
  enumerating threads. Compiled installations re-exec the resource-sampler
  subcommand. No timers or subprocesses start when a module is imported.
- A live SSE subscription starts the sampler. Connections share one sampler;
  the last disconnect kills it. The web runtime releases its scoped connection
  on unmount or when the document becomes hidden. Failures are unavailable data,
  not gateway failures. Reconnection is subscriber-driven, never an idle probe.
- Roots come only from known run-host handles, cached supervised host portals,
  known running scripts, and registered interactive host shells. Metadata reads are targeted and asynchronous.
  Never discover roots by walking session directories or opening actor databases.
- The nearest registered ancestor owns a process. Nested roots are not counted
  twice. Shell and tool children inherit their root's attribution. Detached,
  reparented processes without a registered root cannot be attributed reliably.
- Identity includes process start time. Linux uses kernel start ticks; macOS uses
  `ps` start time at second precision. Known run-host and script identities are
  checked where available. Persisted launch timestamps reject roots born after
  their recorded launch. A sampled root identity stays pinned for that root
  generation, even if its PID disappears and later returns. macOS cannot
  distinguish PID reuse within the same second.
- Raw samples are limited to 20,000 processes and 4 MiB on the pipe. The gateway
  retains attributed history for at most two minutes, 60 snapshots and 1 MiB of
  encoded samples, independently. Oversized samples are not retained. Slow SSE
  consumers are disconnected instead of accumulating queued samples. There is
  no telemetry database. History reads never start sampling.
- The frontend Effect runtime owns scoped SSE, bounded buffering, Schema decoding,
  visibility, retries and cancellation requests. React renders decoded state.
  This is an additive HTTP API; existing native and extension wire models do
  not change.

API: `GET /api/agent-resources/events` streams samples;
`GET /api/agent-resources/history` reads the current bounded history without
collecting; `POST /api/agent-resources/stop` cancels a session's agent through the
existing session-control service. These routes use the normal API auth gate.

Prior art: t3code's resource telemetry separates the collector from its server
and gates live collection on diagnostics subscribers.
