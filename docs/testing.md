# Server tests

Run a focused file with `bun scripts/test-isolated.ts ./path/to/file.test.ts`.
The isolated runner gives each test process a disposable home and strips the
operator environment. Run `bun run check` before committing.

## Waiting for asynchronous work in tests

Do not use a sleep or a zero-delay timeout to wait for background work. Await
its completion API, a specific persisted event, or an explicit test gate. An
empty queue is not proof of idleness: its current item may still be in flight.

`DrainableWork` in `src/server/drainable-work.ts` tracks an existing queue's
scheduled callbacks and asynchronous work without changing its scheduling.
Use `schedule()` for microtask fan-out and `run()` for work that starts now.
`drain()` resolves when all tracked work has finished, including work added
while draining. Failures remain the processing caller's responsibility; drain
is an idle barrier, not an error collector. Stop or await producers first: it
cannot wait for work that has not yet been submitted.

For transcript delivery, await `drainTranscriptBus()` and then the watch
handle's `drain()`: delivery and asynchronous durable reconciliation are two
different completion boundaries. For runtime list-row updates, await
`drainSessionListRuntimeSync()`, which includes the index publication promises.
For deliberately held interleavings, signal when a fake operation is entered
and explicitly release it; do not guess when it started with a timeout.

Timers that are themselves under test (timeouts, retry delays, yielding to the
event loop) are different from sleeps used to guess completion. Preserve such
behavioral tests or use a controllable clock, rather than replacing their timer
with an unrelated drain.
