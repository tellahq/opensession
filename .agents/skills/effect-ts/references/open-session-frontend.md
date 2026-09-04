# Effect in the Open Session frontend

Scope: `packages/core/opensession-server/src/frontend/`. The server,
SessionKernel, executors, protocol package, iOS app, Electron shell, and Chrome
extension contain no Effect and should stay that way unless a documented
decision changes it. Pins: `effect`, `@effect/atom-react`,
`@effect/platform-browser` at `4.0.0-rc.112` in
`packages/core/opensession-server/package.json`.

## Where Effect lives today

| File | Role |
|---|---|
| `lib/effect-lifecycle.ts` | `makeEffectLifecycle<Key>()`: one `Scope` + `FiberMap.makeRuntime` per runtime object. Exposes `run`, `sleep`, `cancel`, `repeat`, `stream`, `acquire`, `stop`. Every failure is reported through `reportError` and the runtime keeps going; interrupts are silent. `effectDelay(ms, action)` is the TestClock-friendly delay. |
| `lib/effect-browser-events.ts` | `browserSignalStreams`: `Stream`s for `visibilitychange`, `focus`, `online`, `pageshow`, `beforeunload` built on `Stream.fromEventListener` / `Stream.callback`. |
| `lib/poll.ts` | The shared visibility-aware poller. `Stream.tick` supplies the cadence, the visibility stream refreshes on foregrounding, and a keyed request fiber aborts superseded or stopped fetches. |
| `lib/session-socket-runtime.ts` | Keyed fibers for reconnect, heartbeat, presence lease, typing, visibility; owns the browser listeners; publishes `connectedAtom` through `effect/unstable/reactivity/Atom`. Consumed by `hooks/useWebSocket.ts`. |
| `lib/session-list-runtime.ts` + `lib/session-list-state.ts` | Visibility-aware polling with fallback timers and debounced invalidation; `Effect.tryPromise(pollLive)`. Consumed by `hooks/useSessions.ts`. |
| `components/EffectRegistryProvider.tsx` | App-owned `AtomRegistry` via `@effect/atom-react/RegistryContext`. Must stay inert under SSR. |
| `lib/effect-imports.test.ts` | Fails the build if any frontend file imports the root `effect`, `@effect/atom-react`, or `@effect/platform-browser` entry instead of a subpath. |

## The boundary rule

Effect owns process-local lifecycles: timers, retries, cancellation,
concurrency limits, and event subscriptions. React owns rendering and local
state. The only way they meet is a plain object:

```ts
export interface SessionListRuntime {
  configure(options: {
    pollInterval: number
    pollLive: (signal: AbortSignal) => Promise<void>
  }): void
  start(): () => void   // synchronous, idempotent, Strict Mode safe
  refresh(): void
  invalidate(options?: { refreshArchived?: boolean }): void
}
```

- Construction performs no work. `start()` is synchronous and returns a
  synchronous `stop`. React Strict Mode calls start, stop, start; the second
  start must not reuse fibers or requests from the first.
- No Effect runs during render. Hooks call `runtime.start()` inside
  `useEffect` and read plain values or atoms.
- Callbacks passed into the runtime are wrapped with `observed(...)`: a throw
  is reported and the fiber continues on the next tick.
- Use `Effect.tryPromise((signal) => fetch(url, { signal }))` so interruption
  aborts the real request. `session-list-runtime.ts` passes that signal through
  `useSessions.ts` into `fetchSessionsSnapshot`; do not add a second
  `AbortController` in the hook.
- Subpath imports only: `import * as Effect from "effect/Effect"`. The root
  barrel pulls the whole library into the bundle.

## Atoms

`@effect/atom-react` currently backs one value, `connectedAtom: Atom<boolean>`,
read with `useAtomValue`. Either grow it into a real connection snapshot
(`phase`, `handoffPending`, `lastOpenAt`) that more than one hook reads, or
remove the registry. Do not move SWR resources or component state into atoms.
`Atom.make(effect | stream)` yielding `AsyncResult` is the idiomatic shape for
shared async values such as frontend-version checks.

## Tests

Follow `lib/session-socket-runtime.test.ts` and `lib/session-list-runtime.test.ts`:

```ts
await Effect.runPromise(Effect.provide(program, TestClock.layer()))
```

- Schedules and delays: `Effect.forkChild` the work, `TestClock.adjust(...)`,
  then `Fiber.join`.
- React-facing runtimes: inject `makeLifecycle` so the test controls fibers,
  and assert `start`/`stop`/restart are synchronous.
- Every new runtime needs: construction-is-inert, Strict Mode restart,
  callback-throws-are-reported-and-recovered, listeners-fenced-on-stop.
- Run `bun test packages/core/opensession-server/src/frontend/lib` for the
  focused suite and `bun run check` before committing.

## Bundle budget

Measured with `bun build --minify --target=browser --external=react`, gzip:

| Set | Size |
|---|---|
| Current usage (lifecycle + socket + list runtimes + atom-react) | 30.9 KB |
| + `effect/Schedule`, `effect/Semaphore`, `Effect.retry`/`timeout` | +1.2 KB |
| + `effect/Schema` | +13.5 KB |
| + `@effect/platform-browser/BrowserSocket` + `effect/unstable/socket` | +16.8 KB |

Re-measure before adding `Schema`, `HttpClient`, `BrowserSocket`, or `Atom.kvs`.

## What stays native

- SWR resources (`hooks/useApiResources.ts`, `lib/api-swr.ts`) and their keys.
- `lib/api/request.ts` and its ~90 Promise callers; do not wrap in `HttpClient`.
- `lib/transcript-view-store.ts`, `lib/live-turn-store.ts` (uSES stores, rAF
  publish, identity-preserving snapshots).
- Durable outbox formats and reconciliation: `lib/prompt-outbox.ts` storage
  shape, client ids, ordering, `navigator.locks`; all of `lib/ws-command-outbox.ts`.
- `lib/drafts.ts` persistence and reconciliation.
- rAF, scroll, gesture, DOM measurement, and plain component listeners.
- The native `WebSocket` wrapper and its close-code logic in `useWebSocket.ts`
  (4001 reload, 1006 auth probe, 1012 handoff).
- Zod for wire validation; do not introduce `Schema` as a second schema library
  unless `packages/core/protocol` adopts one for every client.

## Implemented baseline

- `pollWhileVisible` uses `Stream.tick`, browser visibility events, and a keyed
  request fiber while preserving its `(task, milliseconds) => stop` boundary.
- Session-list requests receive Effect's `AbortSignal`; refresh, invalidation,
  route changes, and unmount interrupt superseded fetches.
- Setup restart health checks use `Schedule.spaced("1 second")` under a
  30-second timeout, with `TestClock` coverage.

## Ranked next steps

1. **Retry policy as data.** Replace the hand-rolled loops in
   `lib/prompt-outbox.ts` (`retryDelay`, `schedule()`, `flushSessionOwned`),
   `lib/api/repos.ts`, `hooks/usePrData.ts`, `lib/drafts.ts` with
   `Effect.retry(eff, { schedule: Schedule.exponential(...).pipe(Schedule.jittered), times, while })`.
   For `PromptOutbox`, move only the sender and retry driver onto a
   per-session `FiberMap` fiber; freeze the v1 storage shape; test with `TestClock`.
2. **Transcript range concurrency** in `hooks/useTranscript.ts`:
   `Semaphore.makeUnsafe(6)` + `FiberMap` keyed by range + `Effect.timeout("15 seconds")`;
   keep `TranscriptViewStore.mergeRange` and scroll anchoring untouched.
3. **Decide the Atom story** (grow or remove).

Deliberately not now: `Schema` for the WS protocol, `BrowserSocket`,
`HttpClient`, `Context.Service` layers (no third lifecycle consumer yet),
and any server-side adoption.

## Review checklist

- Runtime object with synchronous `start`/`stop`; no Effect in render.
- Subpath imports; `bun test .../lib/effect-imports.test.ts` passes.
- Fibers keyed in a `FiberMap`; setting a key cancels its predecessor.
- Fetches receive the `AbortSignal` from `Effect.tryPromise`.
- Failures inside callbacks are reported, not swallowed, and do not kill the loop.
- Timing covered by a `TestClock` test; Strict Mode restart covered.
- Bundle delta measured when a new `effect/*` module is imported.
