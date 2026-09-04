---
name: effect-ts
description: "Write idiomatic Effect v4 TypeScript verified against the pinned effect@4.0.0-rc.112 source. Use when writing, reviewing, or refactoring Effect code: services (Context.Service), layers, error handling (Schema.TaggedError, Effect.catch/catchTag), data modeling (Schema.Class, brands, TaggedClass unions), retries and polling (Schedule, Effect.retry/repeat), resources and fibers (Scope, FiberMap, forkScoped), testing (bun:test + TestClock, or @effect/vitest), HTTP clients, CLI, config, and the Open Session frontend lifecycle runtimes. Triggers on: 'Effect', 'effect-ts', '@effect/', 'Schema', 'Context.Service', 'Layer', 'Effect.gen', 'Effect.fn', 'TaggedError', 'Schedule', 'FiberMap', 'TestClock', 'atom-react', or any Effect-TS code."
---

# Effect-TS (v4, pinned to `4.0.0-rc.112`)

Every API name in this skill was checked against `node_modules/effect/dist/*.d.ts`
at `4.0.0-rc.112` and the Effect repository at tag `effect@4.0.0-rc.112`
(`LLMS.md`, `ai-docs/src`, `migration/`). Patterns come from the official
`ai-docs` and the Effect team's `LLMS.md`, not from third-party summaries.

Originally derived from `joelhooks/effectts-skills` (MIT), which targeted an
early v4 beta and still uses `ServiceMap.Service`, `Schema.TaggedErrorClass`,
`Schedule.compose`, and `@effect/vitest`-only testing. Those names do not exist
in rc.112. This copy was rewritten on 2026-09-03; the rename map below records
what changed.

## Source-first rule

Never guess an Effect v4 API. v4 renamed modules between betas and the RC line
still moves. Before writing or reviewing Effect code:

1. Confirm the pin: `grep '"effect"' packages/core/opensession-server/package.json`.
2. Use the repo-local mirror at `.agent-sources/effect/`, checked out at the
   matching tag (`git -C .agent-sources/effect describe --tags` must print
   `effect@4.0.0-rc.112`). If it is missing or on `main`:
   ```bash
   mkdir -p .agent-sources
   git clone --depth 1 --branch effect@4.0.0-rc.112 https://github.com/Effect-TS/effect.git .agent-sources/effect
   ```
   The mirror is excluded through `.git/info/exclude`; never commit it.
   `main` is ahead of the pin (it already has `Config.String` where rc.112
   has `Config.string`), so a tag checkout is required, not optional.
3. Read the official guidance in this order: `LLMS.md` (curated patterns),
   `ai-docs/src/**` (runnable examples), `migration/*.md` (v3 to v4 rename
   tables), then `packages/effect/src/<Module>.ts` for signatures and JSDoc.
4. When a snippet here and the source disagree, the source wins. Fix the
   snippet.

Quick checks:

```bash
grep -n "^export declare const retry:" node_modules/effect/dist/Effect.d.ts
grep -rn "Schedule.while" .agent-sources/effect/ai-docs/src
```

## Rename map (what older docs and skills get wrong)

| Older name (v3 or early v4 beta) | rc.112 |
|---|---|
| `ServiceMap.Service` (beta < 44) | `Context.Service` |
| `Context.Tag`, `Effect.Tag`, `Effect.Service` (v3) | `Context.Service<Self, Shape>()(id)` |
| `Schema.TaggedErrorClass`, `Schema.ErrorClass` (beta < 104) | `Schema.TaggedError`, `Schema.Error` |
| `Effect.catchAll` / `catchAllCause` / `catchAllDefect` | `Effect.catch` / `catchCause` / `catchDefect` |
| `Effect.catchSome` | `Effect.catchFilter` |
| `Effect.fork` / `Effect.forkDaemon` | `Effect.forkChild` / `Effect.forkDetach` |
| `FiberRef`, `Effect.locally` | `Context.Reference`, `Effect.provideService` |
| `Schedule.compose(...)` | never existed in v4; use `Effect.retry(eff, { schedule, times, while })`, `Schedule.max([...])`, `Schedule.while` |
| `Effect.withConcurrency(n)` | `{ concurrency: n }` option on `Effect.all` / `Effect.forEach` |
| `Schema.minLength` / `maxLength` / `pattern` / `UUID` | `Schema.check(Schema.isMinLength(n))`, `isMaxLength`, `isPattern`, `isUUID` |
| `Schema.Defect` (value) | `Schema.Defect()` (call) |
| `Hash.cached` | removed; use `Hash.string`, `Hash.combine` |
| `Scope.extend(scope)` | `Scope.provide(scope)` |
| `ConfigProvider.fromJson` | `ConfigProvider.fromUnknown` |
| `Config.String` / `Config.Redacted` (post-rc.112 `main`) | `Config.string` / `Config.redacted` |

## Effect.gen and Effect.fn

Prefer `Effect.gen` for inline code and `Effect.fn("name")` for reusable
functions (it names the span and improves stack traces). Use
`Effect.fnUntraced` for hot paths and library internals. Do not write a
function whose only job is to return an `Effect.gen`.

```ts
import { Effect, Schema } from "effect"

export class SomeError extends Schema.TaggedError<SomeError>()("SomeError", {
  message: Schema.String
}) {}

export const effectFunction = Effect.fn("effectFunction")(
  function*(n: number): Effect.fn.Return<string, SomeError> {
    yield* Effect.logInfo("Received number:", n)
    // Always `return yield*` when raising so TypeScript knows the function stops.
    return yield* new SomeError({ message: "Failed" })
  },
  // Extra arguments add combinators. Do not `.pipe` the result of Effect.fn.
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.annotateLogs({ method: "effectFunction" })
)
```

## Context.Service

```ts
import { Context, Effect, Layer, Schema } from "effect"

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect()
}) {}

export class Database extends Context.Service<Database, {
  query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>
}>()("myapp/db/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function*() {
      const query = Effect.fn("Database.query")(function*(sql: string) {
        yield* Effect.log("Executing SQL query:", sql)
        return [{ id: 1, name: "Alice" }]
      })
      return Database.of({ query })
    })
  )
}

export type DatabaseService = Database["Service"]
```

Rules: type parameters first, identifier string second (`<Self, Shape>()(id)`);
identifiers are `package/path/Name`; methods have `R = never`; name the primary
layer `layer` and variants `layerTest`, `layerSqlite`; prefer `yield* Service`
over `Service.use(...)` so dependencies stay visible. `Context.Reference<T>(id,
{ defaultValue })` defines a service with a default (flags, config, log level).

See [references/services-and-layers.md](references/services-and-layers.md).

## Schema: Class, brands, and variants

```ts
import { Match, Schema } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

export class User extends Schema.Class<User>("app/User")({
  id: UserId,
  name: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"])
}) {
  get label() { return `${this.name} (${this.role})` }
}

class Success extends Schema.TaggedClass<Success>()("Success", { value: Schema.Number }) {}
class Failure extends Schema.TaggedClass<Failure>()("Failure", { error: Schema.String }) {}
const Result = Schema.Union([Success, Failure])
type Result = typeof Result.Type

const render = (r: Result) => Match.valueTags(r, {
  Success: ({ value }) => `Got: ${value}`,
  Failure: ({ error }) => `Error: ${error}`
})

export const decodeUser = Schema.decodeUnknownEffect(User)
```

`Schema.Class<Self>(identifier)(fields)` and `Schema.TaggedClass<Self>()(tag,
fields)` require the `Self` type parameter; omitting it is a compile error.
Default to `Schema.Struct` for plain DTOs. See
[references/data-modeling.md](references/data-modeling.md) and
[references/schema-decisions.md](references/schema-decisions.md).

## Errors: Schema.TaggedError and catch*

```ts
import { Effect, Schema } from "effect"

export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  input: Schema.String
}) {}
export class ReservedPortError extends Schema.TaggedError<ReservedPortError>()("ReservedPortError", {
  port: Schema.Int
}) {}

declare const loadPort: (input: string) => Effect.Effect<number, ParseError | ReservedPortError>

export const recovered = loadPort("80").pipe(
  Effect.catchTag(["ParseError", "ReservedPortError"], () => Effect.succeed(3000))
)

export const fallback = loadPort("x").pipe(
  Effect.catchTag("ReservedPortError", () => Effect.succeed(3000)),
  Effect.catch(() => Effect.succeed(3000))
)
```

Errors are yieldable (`return yield* new ParseError({...})`). Use typed errors
for failures a caller can handle, defects (`Effect.orDie`, `Effect.die`) for
bugs, and `Schema.Defect()` to carry an unknown `cause`. See
[references/error-handling.md](references/error-handling.md).

## Layers

```ts
const appLayer = UserService.layer.pipe(
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(Logger.layer)
)
Effect.runPromise(program.pipe(Effect.provide(appLayer)))
```

`Layer.provide` satisfies and hides; `Layer.provideMerge` satisfies and
exposes; `Layer.mergeAll` combines siblings. Layers memoize by reference, so
store parameterized layers in constants. Provide once at the entry point.

## Retry, repeat, and timeout with Schedule

```ts
import { Effect, Schedule } from "effect"

// Capped exponential backoff with jitter, only while the error is retryable.
export const productionRetry = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("10 seconds")
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<HttpError>(),
  Schedule.while(({ input }) => input.retryable)
)

export const loadUser = fetchUserProfile("u1").pipe(
  Effect.retry(productionRetry),
  Effect.timeout("30 seconds")
)

// Or the options form: schedule + attempt cap + predicate in one place.
export const loadUser2 = fetchUserProfile("u1").pipe(
  Effect.retry({ schedule: Schedule.exponential("1 second"), times: 5, while: (e) => e.retryable })
)

// Attempt cap: Schedule.max continues only while all inputs continue.
export const sixAttempts = Schedule.max([Schedule.exponential("250 millis"), Schedule.recurs(6)])

// Polling: repeat a successful effect on a cadence.
export const poll = healthCheck.pipe(Effect.repeat(Schedule.spaced("1 second")))
```

`Effect.retry` always runs the effect once before consulting the policy;
defects and interrupts are never retried.

## Resources, scopes, and fibers

- `Effect.acquireRelease(acquire, release)` inside a `Layer.effect` ties a
  resource to the layer's scope.
- `Effect.forkScoped` for background work that must die with the scope;
  `Effect.forkChild` for work that dies with the parent fiber;
  `Effect.forkDetach` only when you own the cleanup.
- `Effect.scoped` closes an inline scope; `Scope.make()` + `Scope.provide(scope)`
  + `Scope.close(scope, Exit.void)` when a host controls the lifetime.
- `FiberMap` keeps keyed fibers where setting a key interrupts the previous one.
- Wrap callback APIs with `Effect.callback` and return a finalizer so
  interruption cancels the source; `Effect.tryPromise((signal) => ...)` hands
  you an `AbortSignal` that fires on interruption.

See [references/processes.md](references/processes.md).

## Running at the boundary

Effect code composes; hosts run it. `Effect.runPromise` / `runFork` /
`runSync` at the edge, `ManagedRuntime.make(layer)` when a framework needs a
long-lived runtime, `Layer.launch` for a process entry point. Never run an
Effect inside a React render.

## Testing quick start

This repository uses `bun:test`, not `@effect/vitest`:

```ts
import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"

test("delays are deterministic under TestClock", async () => {
  const program = Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.sleep("20 seconds").pipe(Effect.as("done")))
    yield* TestClock.adjust("19 seconds")
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(fiber)).toBe("done")
  })
  await Effect.runPromise(Effect.provide(program, TestClock.layer()))
})
```

Provide fresh layers per test with `Effect.provide`; assert errors with
`Effect.flip` or `Effect.exit`. `@effect/vitest` (`it.effect`, `it.live`,
`it.layer`) applies only to vitest projects. See
[references/testing.md](references/testing.md).

## Anti-patterns

| Do not | Do instead |
|---|---|
| `console.log` inside Effect code | `Effect.log` / `logInfo` with structured data |
| `process.env.KEY` | `Config.string("KEY")`, `Config.redacted("KEY")` |
| `throw` inside `Effect.gen` | `return yield* new TaggedError({...})` |
| `Effect.runSync` / `runPromise` inside services | keep everything effectful; run at the edge |
| `Effect.catch` when only one tag matters | `Effect.catchTag` / `catchTags` |
| `try/catch` around `yield*` | `Effect.try`, `Effect.tryPromise`, `catch*` |
| hand-rolled `isString`/`isRecord` | `Predicate.isString`, `Predicate.isObject` |
| `null`/`undefined` in domain types | `Option`, `Effect.fromNullishOr` |
| `Date.now()` in Effect code | `Clock.currentTimeMillis` / `DateTime.now` (testable) |
| `Schedule.compose`, `ServiceMap`, `TaggedErrorClass`, `catchAll`, `forkDaemon` | see the rename map |
| inline parameterized layer constructors | store the layer in a constant (memoization) |
| `import { Effect } from "effect"` in the browser bundle | `import * as Effect from "effect/Effect"` (enforced by `effect-imports.test.ts`) |

## Open Session specifics

Effect is adopted in the web frontend only, behind plain runtime objects with
`configure/start/stop`; the server, SessionKernel, and native clients have no
Effect. Read [references/open-session-frontend.md](references/open-session-frontend.md)
before touching `lib/effect-lifecycle.ts`, `lib/session-socket-runtime.ts`,
`lib/session-list-runtime.ts`, `hooks/useWebSocket.ts`, or `hooks/useSessions.ts`.

## Reference files

- **[Open Session frontend](references/open-session-frontend.md)**: where Effect lives, the React boundary, tests, bundle budget, what stays native, ranked next steps
- **[Services & Layers](references/services-and-layers.md)**: Context.Service, Reference, `use`/`make`, layer composition, memoization, test layers
- **[Data Modeling](references/data-modeling.md)**: Schema.Class, brands, TaggedClass unions, JSON, checks
- **[Schema Decisions](references/schema-decisions.md)**: Struct vs Class vs TaggedClass
- **[Error Handling](references/error-handling.md)**: TaggedError, catch/catchTag/catchTags/catchFilter/catchReason, defects, Schema.Defect
- **[Testing](references/testing.md)**: bun:test + TestClock, layers in tests, Effect.flip, Reference overrides, @effect/vitest for vitest projects
- **[HTTP Clients](references/http-clients.md)**: HttpClient, request building, schemaBodyJson, retryTransient
- **[CLI](references/cli.md)**: Command, Argument, Flag, subcommands
- **[Config](references/config.md)**: Config, ConfigProvider, Redacted, config services
- **[Processes & Scopes](references/processes.md)**: fork variants, Scope, acquireRelease, ChildProcess
- **[Setup](references/setup.md)**: tsconfig, language service, source mirror
