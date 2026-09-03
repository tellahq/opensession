# Services & Layers

Verified against `effect@4.0.0-rc.112`. `ServiceMap` was renamed to `Context`
in `4.0.0-beta.44`; `Context.Tag`, `Effect.Tag`, and `Effect.Service` are v3.

## Table of Contents

- [Context.Service](#contextservice)
- [Layer implementations](#layer-implementations)
- [Context.Reference](#contextreference)
- [`use` and `make`](#use-and-make)
- [Service-driven development](#service-driven-development)
- [Test implementations](#test-implementations)
- [Providing layers](#providing-layers)
- [Layer memoization](#layer-memoization)
- [Layers that only run side effects](#layers-that-only-run-side-effects)

## Context.Service

Type parameters first, identifier second:

```ts
import { Context, Effect } from "effect"

export class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<Array<unknown>>
  readonly execute: (sql: string) => Effect.Effect<void>
}>()("myapp/db/Database") {}

export class Logger extends Context.Service<Logger, {
  readonly log: (message: string) => Effect.Effect<void>
}>()("myapp/Logger") {}
```

Rules:

- Identifiers are unique strings. The official convention is
  `package/path/Name`; `@app/Name` also works.
- Methods have `R = never`. Dependencies arrive through the layer, not the
  method signature.
- Use `readonly` properties or method syntax; both are fine.
- `Database["Service"]` is the shape type when you need it.
- Function syntax exists for interface-only services:
  `const Database = Context.Service<Database>("Database")`.

## Layer implementations

`Layer.effect` for effectful construction, `Layer.sync` for synchronous,
`Layer.succeed` for a ready value. Build methods with `Effect.fn`, return
`Service.of({...})`:

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String
}) {}

class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()("UserNotFoundError", {
  id: UserId
}) {}

class Analytics extends Context.Service<Analytics, {
  readonly track: (event: string, data: Record<string, unknown>) => Effect.Effect<void>
}>()("myapp/Analytics") {}

class Users extends Context.Service<Users, {
  readonly findById: (id: UserId) => Effect.Effect<User, UserNotFoundError>
  readonly all: Effect.Effect<ReadonlyArray<User>>
}>()("myapp/Users") {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const analytics = yield* Analytics

      const findById = Effect.fn("Users.findById")(
        function*(id: UserId) {
          yield* analytics.track("user.find", { id })
          const response = yield* http.get(`https://api.example.com/users/${id}`)
          return yield* HttpClientResponse.schemaBodyJson(User)(response)
        },
        (effect, id) =>
          effect.pipe(
            Effect.catchTag("ResponseError", (error) =>
              error.response.status === 404
                ? new UserNotFoundError({ id })
                : Effect.die(error)),
            Effect.orDie
          )
      )

      const all = http.get("https://api.example.com/users").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(User))),
        Effect.orDie,
        Effect.withSpan("Users.all")
      )

      return Users.of({ findById, all })
    })
  )
}
```

Naming: `layer` for the primary implementation, then `layerTest`,
`layerSqlite`, `layerNoDeps`. A `layerNoDeps` + `layer = layerNoDeps.pipe(Layer.provide(dep))`
pair is the official way to publish both a dependency-free and a fully wired layer.

## Context.Reference

A service with a default value. Use it for flags, config knobs, and anything
that replaced a v3 `FiberRef`:

```ts
import { Context, Effect } from "effect"

export const FeatureFlag = Context.Reference<boolean>("myapp/FeatureFlag", {
  defaultValue: () => false
})

const program = Effect.gen(function*() {
  const enabled = yield* FeatureFlag
  return enabled ? "on" : "off"
})

// Override for a subtree (replaces v3 Effect.locally)
const forced = Effect.provideService(program, FeatureFlag, true)
```

Built-in references live in `References` (`References.CurrentLogLevel`,
`References.MinimumLogLevel`, ...).

## `use` and `make`

`Service.use((svc) => effect)` accesses a service and calls it in one step.
Prefer `yield* Service` in generators; `use` hides the dependency at the call
site and is mostly for host bridges (`runtime.runPromise(Repo.use((r) => r.getAll))`).

`Context.Service<Self>()(id, { make })` stores a constructor effect on the
class without generating a layer. Build the layer explicitly:

```ts
class Logger extends Context.Service<Logger>()("myapp/Logger", {
  make: Effect.gen(function*() {
    const config = yield* Config
    return { log: (msg: string) => Effect.log(`[${config.prefix}] ${msg}`) }
  })
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Config.layer))
}
```

There is no `dependencies` option in v4; wire dependencies with `Layer.provide`.

## Service-driven development

Declare leaf service contracts first, with no implementations. Higher-level
services compile and type-check against them before anything is runnable:

```ts
import { Clock, Context, Effect, Layer, Schema } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type
const EventId = Schema.String.pipe(Schema.brand("EventId"))
type EventId = typeof EventId.Type
const TicketId = Schema.String.pipe(Schema.brand("TicketId"))
type TicketId = typeof TicketId.Type

class User extends Schema.Class<User>("User")({ id: UserId, name: Schema.String, email: Schema.String }) {}
class Ticket extends Schema.Class<Ticket>("Ticket")({ id: TicketId, eventId: EventId, code: Schema.String }) {}
class Registration extends Schema.Class<Registration>("Registration")({
  eventId: EventId,
  userId: UserId,
  ticketId: TicketId,
  registeredAt: Schema.Date
}) {}

class Users extends Context.Service<Users, {
  readonly findById: (id: UserId) => Effect.Effect<User>
}>()("app/Users") {}

class Tickets extends Context.Service<Tickets, {
  readonly issue: (eventId: EventId, userId: UserId) => Effect.Effect<Ticket>
}>()("app/Tickets") {}

class Emails extends Context.Service<Emails, {
  readonly send: (to: string, subject: string, body: string) => Effect.Effect<void>
}>()("app/Emails") {}

class Events extends Context.Service<Events, {
  readonly register: (eventId: EventId, userId: UserId) => Effect.Effect<Registration>
}>()("app/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function*() {
      const users = yield* Users
      const tickets = yield* Tickets
      const emails = yield* Emails

      const register = Effect.fn("Events.register")(function*(eventId: EventId, userId: UserId) {
        const user = yield* users.findById(userId)
        const ticket = yield* tickets.issue(eventId, userId)
        const now = yield* Clock.currentTimeMillis
        yield* emails.send(user.email, "Registration confirmed", `Ticket: ${ticket.code}`)
        return new Registration({ eventId, userId, ticketId: ticket.id, registeredAt: new Date(now) })
      })

      return Events.of({ register })
    })
  )
}
```

## Test implementations

`Layer.sync` with in-memory state. Mutable locals are fine in tests:

```ts
class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<Array<unknown>>
  readonly execute: (sql: string) => Effect.Effect<void>
}>()("app/Database") {
  static readonly layerTest = Layer.sync(Database, () => {
    const records = new Map<string, unknown>([["user-1", { id: "user-1", name: "Alice" }]])
    return Database.of({
      query: () => Effect.succeed([...records.values()]),
      execute: (sql) => Effect.log(`test execute: ${sql}`)
    })
  })
}
```

## Providing layers

Provide once at the entry point:

```ts
const appLayer = UserService.layer.pipe(
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(Logger.layer),
  Layer.provideMerge(AppConfig.layer)
)

Effect.runPromise(program.pipe(Effect.provide(appLayer)))
```

| Method | Deps satisfied | Available to program | Use when |
|---|---|---|---|
| `Layer.provide` | yes | no | hide an implementation detail |
| `Layer.provideMerge` | yes | yes | tests that need the leaf too; incremental composition |
| `Layer.mergeAll` | no | yes | siblings at the same level |

`Effect<A, E, SomeService> is not assignable to Effect<A, E, never>` means the
service is still required: provide it, or switch `provide` to `provideMerge`.

## Layer memoization

Layers memoize by reference identity within one `Effect.provide` (and across
`ManagedRuntime`s sharing a `Layer.makeMemoMapUnsafe()`):

```ts
// BAD: two Postgres pools
const bad = Layer.merge(
  UserRepo.layer.pipe(Layer.provide(Postgres.layer({ poolSize: 10 }))),
  OrderRepo.layer.pipe(Layer.provide(Postgres.layer({ poolSize: 10 })))
)

// GOOD: one constant, one pool
const postgres = Postgres.layer({ poolSize: 10 })
const good = Layer.merge(
  UserRepo.layer.pipe(Layer.provide(postgres)),
  OrderRepo.layer.pipe(Layer.provide(postgres))
)
```

## Layers that only run side effects

`Layer.effectDiscard` runs background work for the lifetime of the layer
without exposing a service. Fork inside it with `Effect.forkScoped` so the
work stops when the layer is torn down:

```ts
const metricsFlusher = Layer.effectDiscard(
  Effect.gen(function*() {
    const metrics = yield* Metrics
    yield* metrics.flush.pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkScoped)
  })
)
```

`LayerMap.Service` builds layers keyed by an identifier (per tenant, per
connection) with reference counting; see `ai-docs/src/01_effect/05_resources/30_layer-map.ts`.
