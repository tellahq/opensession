# Session performance contract

The session renderer exposes `window.__sessionPerf()` in development and production.
It returns recent samples, counters, and p50/p95/max summaries.

Telemetry is scoped to the current page lifetime. Each metric keeps its latest
200 samples independently, so a high-frequency scroll metric cannot evict rare
stream or input measurements. `recent` contains the latest 100 samples across
all metrics, and counters are cumulative with no reset API. Reload before
measuring one run; for counters, before/after deltas can also isolate the run.

Runtime targets:

- input event p95: under 50 ms. The Event Timing observer requests the minimum
  16 ms duration threshold, so `input_event_ms` includes responsive interactions
  rather than only the browser's default 104 ms-and-slower tail.
- first stream delta in a coalesced batch to the animation-frame flush p95
  (`first_delta_to_paint_ms`): under 50 ms. This is recorded before subscribers
  are notified and React renders, not after a browser paint.
- transcript React render-duration p95 (`react_transcript_commit_ms`): under 8 ms.
  Despite its name, this records the Profiler's `actualDuration` for every
  transcript mount and update; it neither isolates streaming renders nor
  measures commit work.
- send handler start to the next animation-frame callback for a non-busy
  optimistic send p95 (`send_to_optimistic_paint_ms`): under 50 ms. This is not a
  confirmed browser paint.
- 100-delta/s renderer workload: no `long_task_ms` over 100 ms.

Fixture generators live in
`packages/core/opensession-server/src/frontend/lib/session-performance-fixtures.ts`.
`makeSessionFixture` supports 200, 2,000, and 10,000 entries, and
`makeStreamDeltas` defaults to 100 deltas/s for one second.

The production transcript stack also has a browser-rendered, network-free motion
fixture at `/__fixtures/transcript-motion?seed=7&speed=1`. CI builds that bundle,
launches headless Chrome, and runs 24 deterministic seeds across phone, desktop,
reduced motion, 6x CPU throttling, and an in-flight phone viewport resize:

```sh
bun packages/core/opensession-server/src/frontend/tools/transcript-motion-fixture-server.ts &
OPENSESSION_URL=http://127.0.0.1:4899 \
  bun packages/core/opensession-server/src/frontend/tools/transcript-motion-fuzz.ts \
    --seeds 24 --speed 8 --out /tmp/transcript-motion-report.json
OPENSESSION_URL=http://127.0.0.1:4899 \
  bun packages/core/opensession-server/src/frontend/tools/transcript-motion-fuzz.ts \
    --profile stream --seeds 1 --speed 1 --out /tmp/transcript-stream-report.json
```

That browser gate rejects API requests, runtime errors, ResizeObserver loop
warnings, stale streaming rows, horizontal overflow, settled drift above 1 px,
a phone keyboard pulse that leaves follow mode more than 4 px from the live
edge, more than 64 mounted transcript rows, CLS above
0.15 (0.2 under 6x CPU), a frame above 300 ms (1,200 ms throttled), or a long
task above the same whole-scenario budgets.

CI also runs `--profile stream --seeds 1 --speed 1`: a 10,000-entry transcript
receives 100 deltas over one real second. It requires all 100 frames to arrive,
at most 70 frame-coalesced store publications, and no stream-time long task over
100 ms. This stream-specific gate enforces the tighter runtime target without
confusing it with initial React work or the motion fixture's viewport changes.

For a scoped run, compare the before/after deltas of `stream_frames_received` and
`stream_paints`. Despite its name, `stream_paints` counts animation-frame-driven
`LiveTurnStore` snapshot publications before React renders, not display paints.

## Wire budgets

Run the deterministic, isolated transport gate with:

```sh
bun run test:wire-budgets
```

It also runs in `bun run check`. Tests measure pre-compression UTF-8 bytes of
`JSON.stringify`, using the real SQLite transcript store, opening watch socket,
history frame builder, live fan-out (legacy and feed sockets), and sidebar row
projection. They are not browser timing, compressed traffic, or heap budgets.

Named budgets in `server/wire-budgets.test.ts` cover a 1,200-entry session with
large command output, file edits and inline images, plus 500 active and 1,000
archived sidebar sessions:

| Payload                                  | Fixture budget               |
| ---------------------------------------- | ---------------------------- |
| Tool-heavy opening snapshot              | 1 MiB and at most 1,400 rows |
| Older history page                       | 512 KiB and at most 200 rows |
| Live 16-token text batch or tool preview | 2 KiB per frame              |
| 500-row initial sidebar projection       | 384 KiB                      |
| Single sidebar row update                | 1 KiB                        |

The baseline fixture encodes approximately 138 KB for the opening snapshot,
182 KB for a 200-row history page and 126 KB for the sidebar. These are
representative-workload ceilings, not hard caps on arbitrary user content.
The existing opening window retains at least 132 rows, then seeks conversation
boundaries up to 1,400 rows or 850,000 estimated bytes. Its unconditional row
floor and near-limit message previews can exceed the 1 MiB fixture target.

Reconnect has explicit runtime limits: durable transcript catch-up sends at
most 199 changed entries and 1 MiB of encoded append JSON; the ephemeral feed
replays at most 128 frames and 1 MiB of encoded frame JSON. Overflow falls back
to the existing snapshot protocol. A valid small gap sends deltas without
repeating the cumulative active text. Feed retention accounts for UTF-8 bytes,
not JavaScript character count.

Tool results open with 256-character previews. Live tool frames use the same
preview, summarize inputs above 4 KiB and replace inline images with existing
`os-blob:` references. Full content remains in durable storage and is available
through the full-entry endpoint once committed. Live durable appends retain the
store's 32 KiB per-entry bound. No client schema changes are required.

The initial sidebar query excludes archives (except an explicitly selected
archived session); archives remain available through their dedicated query.
Updates project a single row rather than repeating the entire list. The gate
pins the production projection and query, not an HTTP route's enrichment I/O.
Active text snapshot size, actor RPC allocation, legacy transcript fallback,
run-host transport and total active session cardinality are not hard-capped by
these fixture tests.
