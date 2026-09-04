# Error Handling

Verified against `effect@4.0.0-rc.112`. `Schema.TaggedErrorClass` became
`Schema.TaggedError` and `Schema.ErrorClass` became `Schema.Error` in
`4.0.0-beta.104`. `catchAll*` became `catch*` in v4.

## Table of Contents

- [Schema.TaggedError](#schemataggederror)
- [Yieldable errors](#yieldable-errors)
- [Recovering](#recovering)
- [Reasons](#reasons)
- [Expected errors vs defects](#expected-errors-vs-defects)
- [Schema.Defect for unknown causes](#schemadefect-for-unknown-causes)
- [Helpers](#helpers)

## Schema.TaggedError

```ts
import { Schema } from "effect"

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  field: Schema.String,
  message: Schema.String
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  resource: Schema.String,
  id: Schema.String
}) {}

const AppError = Schema.Union([ValidationError, NotFoundError])
type AppError = typeof AppError.Type
```

The `Self` type parameter is mandatory; omitting it is a compile-time
`MissingSelfGeneric` error. `Schema.Error<Self>("Name")({...})` is the
non-tagged variant when a `_tag` is not wanted.

Benefits: serializable, `_tag` for exhaustive matching, class methods, a
sensible default `message`, `instanceof` works.

One error type per distinct failure. `UserNotFoundError` and
`ChannelNotFoundError` with their own fields, not a generic `NotFoundError`.

## Yieldable errors

Errors are yieldable, so `Effect.fail` is rarely needed. Always `return yield*`
so TypeScript knows control does not continue:

```ts
import { Effect, Random, Schema } from "effect"

class BadLuck extends Schema.TaggedError<BadLuck>()("BadLuck", { roll: Schema.Number }) {}

const rollDie = Effect.gen(function*() {
  const roll = yield* Random.nextIntBetween(1, 6)
  if (roll === 1) return yield* new BadLuck({ roll })
  return { roll }
})
```

## Recovering

| Combinator | Removes from `E` | Use |
|---|---|---|
| `Effect.catch(handler)` | everything | final fallback |
| `Effect.catchTag("Tag" \| ["A", "B"], handler)` | those tags | one or a few tags |
| `Effect.catchTags({ A: h, B: h })` | listed tags | many tags |
| `Effect.catchFilter(Filter.fromPredicate(p), handler)` | matching values | predicate-based (replaces v3 `catchSome`) |
| `Effect.catchCause(handler)` | everything, sees the `Cause` | logging at a boundary |
| `Effect.catchDefect(handler)` | defects only | sandboxing plugins |

```ts
const recovered = program.pipe(
  Effect.catchTag("HttpError", (error) =>
    Effect.gen(function*() {
      yield* Effect.logWarning(`HTTP ${error.statusCode}: ${error.message}`)
      return "fallback"
    }))
)

const recoveredMany = program.pipe(
  Effect.catchTags({
    HttpError: () => Effect.succeed("network fallback"),
    ValidationError: () => Effect.succeed("validation fallback")
  })
)
```

`Effect.mapError` translates one typed error into another at a service
boundary (`Effect.mapError((cause) => new MailerError({ reason: cause }))`).

## Reasons

A tagged error can carry a tagged `reason` union. Handle one reason without
removing the parent error, or unwrap all reasons into the error channel:

```ts
import { Effect, Schema } from "effect"

class RateLimitError extends Schema.TaggedError<RateLimitError>()("RateLimitError", { retryAfter: Schema.Finite }) {}
class QuotaExceededError extends Schema.TaggedError<QuotaExceededError>()("QuotaExceededError", { limit: Schema.Int }) {}
class AiError extends Schema.TaggedError<AiError>()("AiError", {
  reason: Schema.Union([RateLimitError, QuotaExceededError])
}) {}

declare const callModel: Effect.Effect<string, AiError>

const one = callModel.pipe(
  Effect.catchReason("AiError", "RateLimitError", (r) => Effect.succeed(`retry after ${r.retryAfter}`))
)

const many = callModel.pipe(
  Effect.catchReasons("AiError", {
    RateLimitError: (r) => Effect.succeed(`retry after ${r.retryAfter}`),
    QuotaExceededError: (r) => Effect.succeed(`quota ${r.limit}`)
  })
)

const unwrapped = callModel.pipe(
  Effect.unwrapReason("AiError"),
  Effect.catchTags({
    RateLimitError: (r) => Effect.succeed(`back off ${r.retryAfter}`),
    QuotaExceededError: (r) => Effect.succeed(`raise quota ${r.limit}`)
  })
)
```

## Expected errors vs defects

Typed errors are for failures the caller can handle: validation, not found,
permission denied, rate limits. Defects are bugs and invariant violations;
they end the fiber and are handled once at the boundary.

```ts
const main = Effect.gen(function*() {
  // If config cannot load nothing can proceed: promote to a defect.
  const config = yield* loadConfig.pipe(Effect.orDie)
  yield* Effect.log(`Starting on port ${config.port}`)
})
```

Inspect outcomes without catching: `Effect.exit` (full `Exit`),
`Effect.result` (`Result<A, E>`), `Effect.option`. Retries and `Schedule.while`
never see defects or interrupts.

## Schema.Defect for unknown causes

Wrap foreign errors once at the boundary. `Schema.Defect()` is a function call:

```ts
import { Effect, Schema } from "effect"

class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  endpoint: Schema.String,
  cause: Schema.Defect()
}) {}

const fetchUser = Effect.fn("fetchUser")((id: string) =>
  Effect.tryPromise({
    try: (signal) => fetch(`/api/users/${id}`, { signal }).then((r) => r.json()),
    catch: (cause) => new ApiError({ endpoint: `/api/users/${id}`, cause })
  })
)
```

`Schema.Defect()` serializes `Error` instances as `{ name, message }` and any
other value as a string, so the error survives logging, storage, and RPC.

## Helpers

### Refail into a domain error

```ts
import { Cause, Effect, Schema } from "effect"

class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  cause: Schema.Defect()
}) {
  static refail<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersistenceError, R> {
    return Effect.catchCause(effect, (cause) =>
      Effect.fail(new PersistenceError({ cause: Cause.squash(cause) })))
  }
}

const safeQuery = PersistenceError.refail(rawDbCall)
```

### Runtime discrimination across packages

```ts
import { Schema } from "effect"
import { hasProperty, isTagged } from "effect/Predicate"

export const TypeId: unique symbol = Symbol.for("myapp/AppError")

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  resource: Schema.String,
  id: Schema.String
}) {
  readonly [TypeId] = TypeId
  static is(u: unknown): u is NotFoundError {
    return hasProperty(u, TypeId) && isTagged(u, "NotFoundError")
  }
}
```

### Asserting errors in tests

```ts
const error = yield* service.doThing(badInput).pipe(Effect.flip)
expect(error._tag).toBe("ValidationError")
```

See [testing.md](testing.md).
