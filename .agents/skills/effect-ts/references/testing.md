# Testing

Verified against `effect@4.0.0-rc.112`. Open Session runs `bun:test`; the
Effect monorepo and vitest projects use `@effect/vitest`. Both are covered.

## Table of Contents

- [bun:test (this repository)](#buntest-this-repository)
- [TestClock](#testclock)
- [Providing layers](#providing-layers)
- [Asserting errors](#asserting-errors)
- [Overriding references](#overriding-references)
- [Worked example](#worked-example)
- [@effect/vitest (vitest projects)](#effectvitest-vitest-projects)

## bun:test (this repository)

Run the program with `Effect.runPromise` and provide test services explicitly.
`TestClock.layer()` gives deterministic time; without it the real clock runs.

```ts
import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"

test("adds", async () => {
  const program = Effect.gen(function*() {
    const result = yield* Effect.succeed(1 + 1)
    expect(result).toBe(2)
  })
  await Effect.runPromise(Effect.provide(program, TestClock.layer()))
})
```

Focused runs: `bun test packages/core/opensession-server/src/frontend/lib`.
The full gate is `bun run check`.

## TestClock

Fork the timed work, advance virtual time, then join:

```ts
import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"

test("retries three times with backoff", async () => {
  let attempts = 0
  const flaky = Effect.sync(() => { attempts += 1 }).pipe(
    Effect.andThen(Effect.fail("boom" as const))
  )
  const program = Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(
      flaky.pipe(Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }), Effect.exit)
    )
    yield* TestClock.adjust("1 second")   // 2nd attempt
    yield* TestClock.adjust("2 seconds")  // 3rd attempt
    yield* TestClock.adjust("4 seconds")  // 4th attempt
    yield* Fiber.join(fiber)
    expect(attempts).toBe(4)
  })
  await Effect.runPromise(Effect.provide(program, TestClock.layer()))
})
```

`TestClock.adjust` accepts `Duration.Input` (`"1 second"`, `1000`,
`Duration.seconds(1)`). `TestClock.setTime(ms)` jumps to an absolute time.
Code that reads `Date.now()` directly will not see virtual time; use
`Clock.currentTimeMillis` or `DateTime.now` in Effect code.

## Providing layers

Fresh layer per test, provided inline:

```ts
const layerTest = Layer.succeed(Database, Database.of({
  query: () => Effect.succeed(["mock", "data"])
}))

test("queries database", async () => {
  const program = Effect.gen(function*() {
    const db = yield* Database
    expect((yield* db.query("SELECT *")).length).toBe(2)
  })
  await Effect.runPromise(Effect.provide(program, layerTest))
})
```

For an expensive shared resource, build one `ManagedRuntime.make(layer)` at
module scope, call `runtime.runPromise(program)` in each test, and
`await runtime.dispose()` in `afterAll`.

## Asserting errors

```ts
const error = yield* service.process(badInput).pipe(Effect.flip)
expect(error._tag).toBe("ValidationError")

const exit = yield* service.process(badInput).pipe(Effect.exit)
expect(Exit.isFailure(exit)).toBe(true)
```

## Overriding references

`Context.Reference` replaces v3 `FiberRef`. Override per test with
`Effect.provideService`; nothing leaks between tests and nothing needs cleanup:

```ts
import * as Context from "effect/Context"

export const ConfigPath = Context.Reference<string>("app/ConfigPath", {
  defaultValue: () => "/default/path"
})

const getConfig = Effect.gen(function*() {
  return yield* ConfigPath
})

test("uses a custom path", async () => {
  const result = await Effect.runPromise(Effect.provideService(getConfig, ConfigPath, "/test/path"))
  expect(result).toBe("/test/path")
})
```

Never mutate `process.env` in tests.

## Worked example

Testing the `Events` service from [services-and-layers.md](services-and-layers.md#service-driven-development):

```ts
import { afterEach, describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type
const EventId = Schema.String.pipe(Schema.brand("EventId"))
type EventId = typeof EventId.Type
const TicketId = Schema.String.pipe(Schema.brand("TicketId"))
type TicketId = typeof TicketId.Type

class User extends Schema.Class<User>("User")({ id: UserId, name: Schema.String, email: Schema.String }) {}
class Ticket extends Schema.Class<Ticket>("Ticket")({ id: TicketId, eventId: EventId, code: Schema.String }) {}
class Email extends Schema.Class<Email>("Email")({ to: Schema.String, subject: Schema.String, body: Schema.String }) {}
class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", { id: UserId }) {}

class Users extends Context.Service<Users, {
  readonly create: (user: User) => Effect.Effect<void>
  readonly findById: (id: UserId) => Effect.Effect<User, UserNotFound>
}>()("app/Users") {
  static readonly layerTest = Layer.sync(Users, () => {
    const store = new Map<UserId, User>()
    return Users.of({
      create: (user) => Effect.sync(() => void store.set(user.id, user)),
      findById: (id) =>
        Effect.fromNullishOr(store.get(id)).pipe(Effect.mapError(() => new UserNotFound({ id })))
    })
  })
}

class Tickets extends Context.Service<Tickets, {
  readonly issue: (eventId: EventId, userId: UserId) => Effect.Effect<Ticket>
}>()("app/Tickets") {
  static readonly layerTest = Layer.sync(Tickets, () => {
    let counter = 0
    return Tickets.of({
      issue: (eventId) =>
        Effect.sync(() => new Ticket({ id: TicketId.make(`ticket-${++counter}`), eventId, code: `CODE-${counter}` }))
    })
  })
}

class Emails extends Context.Service<Emails, {
  readonly send: (email: Email) => Effect.Effect<void>
  readonly sent: Effect.Effect<ReadonlyArray<Email>>
}>()("app/Emails") {
  static readonly layerTest = Layer.sync(Emails, () => {
    const emails: Array<Email> = []
    return Emails.of({
      send: (email) => Effect.sync(() => void emails.push(email)),
      sent: Effect.sync(() => emails)
    })
  })
}

class Events extends Context.Service<Events, {
  readonly register: (eventId: EventId, userId: UserId) => Effect.Effect<Ticket, UserNotFound>
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
        yield* emails.send(new Email({ to: user.email, subject: "Registration confirmed", body: `Ticket: ${ticket.code}` }))
        return ticket
      })
      return Events.of({ register })
    })
  )
}

// provideMerge keeps the leaf services reachable for setup and assertions.
const layerTest = Events.layer.pipe(
  Layer.provideMerge(Users.layerTest),
  Layer.provideMerge(Tickets.layerTest),
  Layer.provideMerge(Emails.layerTest)
)

describe("Events.register", () => {
  test("sends a confirmation with the ticket code", async () => {
    const program = Effect.gen(function*() {
      const users = yield* Users
      const events = yield* Events
      const emails = yield* Emails
      const user = new User({ id: UserId.make("user-1"), name: "Bob", email: "bob@example.com" })
      yield* users.create(user)
      const ticket = yield* events.register(EventId.make("event-1"), user.id)
      const sent = yield* emails.sent
      expect(sent).toHaveLength(1)
      expect(sent[0]?.to).toBe("bob@example.com")
      expect(sent[0]?.body).toContain(ticket.code)
    })
    await Effect.runPromise(Effect.provide(program, layerTest))
  })

  test("fails for an unknown user", async () => {
    const program = Effect.gen(function*() {
      const events = yield* Events
      const error = yield* events.register(EventId.make("event-1"), UserId.make("nobody")).pipe(Effect.flip)
      expect(error._tag).toBe("UserNotFound")
    })
    await Effect.runPromise(Effect.provide(program, layerTest))
  })
})
```

Each test provides `layerTest` afresh, so the in-memory maps never leak.

## @effect/vitest (vitest projects)

Not installed here. In a vitest project:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

describe("basics", () => {
  it.effect("runs with TestClock provided", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.sleep(60_000).pipe(Effect.as("done")))
      yield* TestClock.adjust(60_000)
      assert.strictEqual(yield* Fiber.join(fiber), "done")
    }))

  it.live("uses the real clock", () => Effect.sleep(1))

  it.effect.each([{ input: " Ada ", expected: "ada" }])("normalizes %#", ({ input, expected }) =>
    Effect.gen(function*() {
      assert.strictEqual(input.trim().toLowerCase(), expected)
    }))
})
```

- `it.effect` provides `TestClock`; `it.live` uses real services.
- `it.layer(layer)("suite", (it) => ...)` shares one layer across a suite; use
  it only for expensive resources.
- `it.effect.prop` runs property tests from `Schema` arbitraries.
- `it.effect.skip` / `.only` / `.fails` work as in vitest.
- Prefer the `assert` helpers exported by `@effect/vitest`.
