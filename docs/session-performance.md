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
