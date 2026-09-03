# Schema Decision Matrix

Adapted from [artimath/effect-skills](https://github.com/artimath/effect-skills) (MIT), verified against `effect@4.0.0-rc.112`.

## Decision Tree

```
Is the type used as a key in HashMap/HashSet?
  YES -> Schema.Class (implement Equal/Hash)
  NO  |
      v
Does it need computed properties or methods?
  YES -> Schema.Class
  NO  |
      v
Is it part of a discriminated union (OR type)?
  YES -> Schema.TaggedClass + Schema.Union
  NO  |
      v
Use Schema.Struct
```

## Quick Reference

| Use Schema.Class when... | Use Schema.Struct when... | Use Schema.TaggedClass when... |
|--------------------------|---------------------------|-------------------------------|
| Needs Equal/Hash symbols | Plain DTO, no behavior | Part of a discriminated union |
| Used as HashMap/HashSet key | No identity semantics | Needs automatic `_tag` field |
| Has computed properties/methods | Decoded and passed around | Pattern matched with Match.valueTags |
| Needs PrimaryKey symbol | Simple config or state | One variant of several options |

**Default to Schema.Struct.** Most types are DTOs without behavior.

## Schema.Struct (Most Common)

For DTOs, config objects, state containers:

```typescript
import { Schema } from "effect"

const Limits = Schema.Struct({
  steps: Schema.Number,
  rows: Schema.Number,
  bytes: Schema.Number,
})
type Limits = typeof Limits.Type

// Nested
const Capability = Schema.Struct({
  issuer: PrincipalId,
  holder: PrincipalId,
  limits: Limits,
})
type Capability = typeof Capability.Type

// With optional + default
const Config = Schema.Struct({
  timeout: Schema.optional(Schema.Number, { default: () => 5000 }),
  retries: Schema.optional(Schema.Number, { default: () => 3 }),
})
```

## Schema.Class (When Behavior Needed)

Use when the type needs custom equality, hashing, methods, or PrimaryKey:

```typescript
import { Equal, Hash, Schema } from "effect"

class RunnerAddress extends Schema.Class<RunnerAddress>("RunnerAddress")({
  host: Schema.NonEmptyString,
  port: Schema.Int,
}) {
  [Equal.symbol](that: RunnerAddress): boolean {
    return this.host === that.host && this.port === that.port
  }

  [Hash.symbol]() {
    return Hash.string(`${this.host}:${this.port}`)
  }

  get endpoint(): string {
    return `${this.host}:${this.port}`
  }
}
```

## Schema.TaggedClass (Discriminated Unions)

For union variants with automatic `_tag` discrimination:

```typescript
import { Match, Schema } from "effect"

class Appended extends Schema.TaggedClass<Appended>()("Appended", {
  recordId: RecordId,
}) {}

class AlreadyExists extends Schema.TaggedClass<AlreadyExists>()("AlreadyExists", {
  recordId: RecordId,
}) {}

class Quarantined extends Schema.TaggedClass<Quarantined>()("Quarantined", {
  reason: Schema.String,
}) {}

const AppendResult = Schema.Union([Appended, AlreadyExists, Quarantined])
type AppendResult = typeof AppendResult.Type

// Exhaustive match
const handle = (result: AppendResult) =>
  Match.valueTags(result, {
    Appended: ({ recordId }) => `appended ${recordId}`,
    AlreadyExists: ({ recordId }) => `exists ${recordId}`,
    Quarantined: ({ reason }) => `quarantined: ${reason}`,
  })
```

## Branded Types (Always Add Real Constraints)

Don't brand bare `Schema.String`. Add actual validation:

```typescript
import { Schema } from "effect"

// BAD: brand without constraints
const UserId = Schema.String.pipe(Schema.brand("UserId"))

// GOOD: brand with real constraints
const UserId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^usr_[a-z0-9]+$/)),
  Schema.brand("UserId")
)
type UserId = typeof UserId.Type

// GOOD: numeric brand with range
const Port = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  Schema.brand("Port")
)
type Port = typeof Port.Type
```

## Migration Patterns

### Interface + Schema to single Schema

```typescript
// BEFORE (duplicated)
interface VaultEntry { readonly casId: CasId; readonly mediaType: string }
const VaultEntrySchema = Schema.Struct({ casId: CasId, mediaType: Schema.String })

// AFTER (single source of truth)
const VaultEntry = Schema.Struct({ casId: CasId, mediaType: Schema.String })
type VaultEntry = typeof VaultEntry.Type
```

### Phantom type to Schema.brand

```typescript
// BEFORE (compile-time only, no runtime validation)
type WorkflowId = string & { readonly _tag: "WorkflowId" }

// AFTER (runtime validation)
const WorkflowId = Schema.NonEmptyString.pipe(Schema.brand("WorkflowId"))
type WorkflowId = typeof WorkflowId.Type
```

### String literal union to TaggedClass

```typescript
// BEFORE (no narrowing, no per-variant data)
interface Result { status: "success" | "failure"; data?: unknown; error?: string }

// AFTER (proper discrimination)
class Success extends Schema.TaggedClass<Success>()("Success", {
  data: Schema.Unknown,
}) {}
class Failure extends Schema.TaggedClass<Failure>()("Failure", {
  error: Schema.String,
}) {}
const Result = Schema.Union([Success, Failure])
type Result = typeof Result.Type
```

## Anti-Patterns

| Anti-Pattern | Fix |
|--------------|-----|
| Schema.Class for simple DTOs | Use Schema.Struct unless needs behavior |
| String literal union in Struct | Use TaggedClass for variants |
| Separate interface + schema | Single schema as source of truth |
| Schema.Class without Equal/Hash | Use Struct instead (no benefit) |
| Phantom `& { _tag }` | Use Schema.brand with real constraints |
| `as Type` casts | Use Schema.decodeUnknown |
| Bare `Schema.String.pipe(Schema.brand(...))` | Add real constraints: NonEmptyString, `Schema.check(Schema.isPattern(...))` |
| `Schema.Class("Name")` without `<Self>` | `Schema.Class<Self>("Name")`; omitting `Self` is a compile error |
