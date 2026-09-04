# Fibers, Scopes, and Child Processes

Verified against `effect@4.0.0-rc.112`. v4 renamed `Effect.fork` to
`Effect.forkChild` and `Effect.forkDaemon` to `Effect.forkDetach`; `Scope.extend`
is now `Scope.provide`; child processes moved to `effect/unstable/process`
(`ChildProcess`, `ChildProcessSpawner`) and the platform packages provide the
spawner.

## Table of Contents

- [Fork variants](#fork-variants)
- [Scope patterns](#scope-patterns)
- [acquireRelease](#acquirerelease)
- [Keyed fibers with FiberMap](#keyed-fibers-with-fibermap)
- [Concurrency limits](#concurrency-limits)
- [Cancellation at the edge](#cancellation-at-the-edge)
- [Child processes](#child-processes)
- [Killable background process](#killable-background-process)

## Fork variants

| Variant | Lifetime | Cleanup | Use |
|---|---|---|---|
| `Effect.forkChild` | dies with the parent fiber | automatic | concurrent work inside one operation; TestClock tests |
| `Effect.forkScoped` | dies with the enclosing `Scope` | registered on the scope | layer background loops, runtime objects |
| `Effect.forkIn(scope)` | dies with a specific scope | registered on that scope | host-controlled lifetimes |
| `Effect.forkDetach` | independent | **yours** | only when you own an explicit teardown |

All accept `{ startImmediately?: boolean; uninterruptible?: boolean | "inherit" }`.

```ts
import { Effect, Fiber } from "effect"

const program = Effect.gen(function*() {
  const fiber = yield* Effect.forkChild(work)
  const result = yield* Fiber.join(fiber)

  yield* Effect.forkScoped(backgroundLoop)  // stops when the scope closes
})
```

## Scope patterns

Inline scope:

```ts
const output = yield* Effect.scoped(
  Effect.gen(function*() {
    const handle = yield* spawner.spawn(command)   // adds Scope
    return yield* collect(handle)
  })
)
```

Host-controlled scope (a React runtime object, a server connection):

```ts
import { Effect, Exit, Scope } from "effect"

const scope = yield* Scope.make()
const handle = yield* startResource.pipe(Scope.provide(scope))
// later
yield* Scope.close(scope, Exit.void)
```

`Scope.makeUnsafe("sequential")` + `Scope.provide(scope)` is how
`lib/effect-lifecycle.ts` builds a runtime whose `stop()` is synchronous.

## acquireRelease

```ts
const connection = yield* Effect.acquireRelease(
  openConnection,
  (conn) => closeConnection(conn).pipe(Effect.orDie)
)
```

Inside `Layer.effect` the release runs when the layer is torn down. Use
`Effect.ensuring` for cleanup that does not produce a resource and
`Effect.onInterrupt` for interrupt-only cleanup.

## Keyed fibers with FiberMap

`FiberMap` holds one fiber per key; setting a key interrupts its predecessor.
This is the primitive behind reconnect timers, heartbeats, and per-session
senders:

```ts
import { Effect, FiberMap } from "effect"

const program = Effect.gen(function*() {
  const fibers = yield* FiberMap.make<string>()   // requires Scope
  yield* FiberMap.run(fibers, "heartbeat", heartbeatLoop)
  yield* FiberMap.run(fibers, "heartbeat", heartbeatLoop)  // replaces the first
  yield* FiberMap.remove(fibers, "heartbeat")               // interrupts
  yield* FiberMap.clear(fibers)
})
```

`FiberMap.makeRuntime<R, K>()` returns an imperative `run(key, effect)`
function for host code that cannot `yield*`.

## Concurrency limits

`Effect.withConcurrency` is gone. Pass `{ concurrency }` to the combinator, or
use a `Semaphore` for a limit shared across call sites:

```ts
import { Effect, Semaphore } from "effect"

const results = yield* Effect.forEach(ranges, loadRange, { concurrency: 6 })

const permits = Semaphore.makeUnsafe(6)
const limited = loadRange(range).pipe(permits.withPermits(1))
```

## Cancellation at the edge

- `Effect.tryPromise((signal) => fetch(url, { signal }))`: interruption aborts
  the request.
- `Effect.callback((resume) => { ...; return Effect.sync(cleanup) })`: the
  returned finalizer runs on interruption.
- `Effect.timeout("15 seconds")` fails with `TimeoutError`;
  `Effect.timeoutOption` yields `None` instead.
- `Effect.race(a, b)` interrupts the loser.

## Child processes

`ChildProcess.make(command, args, options)` describes a process;
`ChildProcessSpawner` runs it. `NodeServices.layer` (`@effect/platform-node`)
or `BunServices.layer` (`@effect/platform-bun`) provides the spawner.

```ts
import { Console, Context, Effect, Layer, Schema, Stream, String } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { BunServices } from "@effect/platform-bun"

class DevToolsError extends Schema.TaggedError<DevToolsError>()("DevToolsError", { cause: Schema.Defect() }) {}

class DevTools extends Context.Service<DevTools, {
  readonly nodeVersion: Effect.Effect<string, DevToolsError>
  readonly runLintFix: Effect.Effect<void, DevToolsError>
}>()("app/DevTools") {
  static readonly layer = Layer.effect(
    DevTools,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      // Collect all output as a string.
      const nodeVersion = spawner.string(ChildProcess.make("node", ["--version"])).pipe(
        Effect.map(String.trim),
        Effect.mapError((cause) => new DevToolsError({ cause }))
      )

      // Pipelines: `git log ... | head -n 5`
      const recent = spawner.lines(
        ChildProcess.make("git", ["log", "--pretty=format:%s", "-n", "20"]).pipe(
          ChildProcess.pipeTo(ChildProcess.make("head", ["-n", "5"]))
        )
      )

      // Stream output while running; `spawn` adds a Scope.
      const runLintFix = Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          ChildProcess.make("pnpm", ["lint-fix"], { env: { FORCE_COLOR: "1" }, extendEnv: true })
        )
        yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Console.log(`[lint-fix] ${line}`))
        )
        const exitCode = yield* handle.exitCode
        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new DevToolsError({ cause: new Error(`exit ${exitCode}`) })
        }
      }).pipe(
        Effect.mapError((cause) => cause instanceof DevToolsError ? cause : new DevToolsError({ cause })),
        Effect.scoped
      )

      return DevTools.of({ nodeVersion, runLintFix })
    })
  ).pipe(Layer.provide(BunServices.layer))
}
```

`spawner.string`, `spawner.lines`, and `spawner.spawn` cover the common cases;
the handle exposes `stdout`, `stderr`, `all`, `exitCode`, and `kill`.

## Killable background process

Keep the process in a scope you control and fork only the collection work:

```ts
import { Effect, Exit, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const startBackground = Effect.fn("startBackground")(function*(command: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Scope.make()
  const handle = yield* spawner.spawn(ChildProcess.make("bash", ["-c", command])).pipe(Scope.provide(scope))

  yield* handle.all.pipe(
    Stream.decodeText(),
    Stream.runForEach(storeOutputLine),
    Effect.ignore,
    Effect.forkIn(scope)
  )

  return { handle, stop: Scope.close(scope, Exit.void) }
})
```

Anti-pattern: `Effect.forkDetach(Effect.scoped(spawn...))` traps the handle
inside the detached fiber's scope where nothing outside can reach or stop it.
