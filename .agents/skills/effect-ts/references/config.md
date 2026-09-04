# Config

Verified against `effect@4.0.0-rc.112`, where constructors are lowercase
(`Config.string`, `Config.redacted`). Effect `main` after rc.112 capitalizes
them (`Config.String`); do not copy that into this codebase.

## Table of Contents

- [How Config Works](#how-config-works)
- [Basic Usage](#basic-usage)
- [Config Service Pattern](#config-service-pattern)
- [Config Primitives](#config-primitives)
- [Defaults and Fallbacks](#defaults-and-fallbacks)
- [Validation with Schema](#validation-with-schema)
- [Config Providers](#config-providers)
- [Redacted Secrets](#redacted-secrets)

## How Config Works

By default, `Config` reads from environment variables. Override with `ConfigProvider`:
- **Production**: environment variables (default)
- **Tests**: in-memory maps or `Layer.succeed` with test values
- **Development**: JSON files or hardcoded values

## Basic Usage

```typescript
import { Config, Effect } from "effect"

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("API_KEY")
  const port = yield* Config.int("PORT")
  console.log(`Starting on port ${port}`)
})
```

Override the provider:

```typescript
import { ConfigProvider, Layer } from "effect"

const testConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ API_KEY: "test-key", PORT: "3000" })
)

Effect.runPromise(program.pipe(Effect.provide(testConfigLayer)))
```

## Config Service Pattern

**Best practice:** Create a config service with `layer` and `testLayer`:

```typescript
import { Config, Context, Effect, Layer, Redacted } from "effect"

class ApiConfig extends Context.Service<
  ApiConfig,
  {
    readonly apiKey: Redacted.Redacted
    readonly baseUrl: string
    readonly timeout: number
  }
>()("app/ApiConfig") {
  static readonly layer = Layer.effect(
    ApiConfig,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("API_KEY")
      const baseUrl = yield* Config.string("API_BASE_URL").pipe(
        Config.withDefault("https://api.example.com")
      )
      const timeout = yield* Config.int("API_TIMEOUT").pipe(
        Config.withDefault(30000)
      )
      return ApiConfig.of({ apiKey, baseUrl, timeout })
    })
  )

  // Tests: inline values, no ConfigProvider needed
  static readonly layerTest = Layer.succeed(ApiConfig, ApiConfig.of({
    apiKey: Redacted.make("test-key"),
    baseUrl: "https://test.example.com",
    timeout: 5000,
  }))
}
```

**Why this pattern:**
- Separates config loading from business logic
- Easy to swap implementations (`layer` vs `layerTest`)
- Config errors caught early at layer composition
- Type-safe throughout your app

For tests, just `Layer.succeed` with hardcoded values. No need for `ConfigProvider.fromMap`.

## Config Primitives

```typescript
Config.string("MY_VAR")           // string
Config.nonEmptyString("NAME")     // non-empty string
Config.number("RATIO")            // number
Config.int("MAX_RETRIES")         // integer
Config.finite("WEIGHT")           // finite number
Config.boolean("DEBUG")           // boolean
Config.port("PORT")               // 1..65535
Config.redacted("API_KEY")        // hidden in logs
Config.url("API_URL")             // URL
Config.duration("TIMEOUT")        // Duration
Config.date("STARTS_AT")          // Date
Config.literals(["dev", "prod"], "ENV") // enum
Config.logLevel("LOG_LEVEL")      // LogLevel
Config.schema(S, "KEY")           // any Schema
```

Combine several with `Config.all({ a: Config.string("A"), b: Config.int("B") })`.

## Defaults and Fallbacks

```typescript
// Default value
const port = yield* Config.int("PORT").pipe(Config.withDefault(3000))

// Fallback config
const url = yield* Config.string("API_URL").pipe(
  Config.orElse(() => Config.string("LEGACY_API_URL"))
)

// Optional values (returns Option<string>)
const optionalKey = yield* Config.option(Config.string("OPTIONAL_KEY"))
```

## Validation with Schema

Use `Config.schema` for type-safe validation:

```typescript
import { Config, Schema } from "effect"

const Port = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  Schema.brand("Port")
)
type Port = typeof Port.Type

const Environment = Schema.Literals(["development", "staging", "production"])

const program = Effect.gen(function* () {
  const port = yield* Config.schema(Port, "PORT")     // branded Port
  const env = yield* Config.schema(Environment, "ENV") // validated enum
})
```

## Config Providers

```typescript
import { ConfigProvider, Layer } from "effect"

// From an object (JSON-like values are fine)
ConfigProvider.layer(ConfigProvider.fromUnknown({ API_KEY: "key", PORT: 8080 }))

// From a .env file or its contents
ConfigProvider.layer(ConfigProvider.fromDotEnvContents("API_KEY=key\nPORT=8080"))

// Prefixed env vars (reads APP_API_KEY, APP_PORT, etc.)
ConfigProvider.layer(ConfigProvider.fromEnv().pipe(ConfigProvider.nested("APP")))

// Layer an override on top of the default provider
ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ PORT: 8080 }))
```

There is no `ConfigProvider.fromJson`; `fromUnknown` handles objects.

## Redacted Secrets

Always use `Config.redacted()` for sensitive values:

```typescript
import { Config, Redacted } from "effect"

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("API_KEY")

  // Extract value when needed
  const headers = { Authorization: `Bearer ${Redacted.value(apiKey)}` }

  // Hidden in logs
  console.log(apiKey) // Output: <redacted>
})
```

Use `Schema.Redacted(Schema.String)` in config schemas:

```typescript
class DatabaseConfig extends Context.Service<
  DatabaseConfig,
  { readonly host: string; readonly port: number; readonly password: Redacted.Redacted }
>()("app/DatabaseConfig") {
  static readonly layer = Layer.effect(DatabaseConfig, Effect.gen(function* () {
    const host = yield* Config.string("DB_HOST")
    const port = yield* Config.schema(Port, "DB_PORT")
    const password = yield* Config.schema(Schema.Redacted(Schema.String), "DB_PASSWORD")
    return DatabaseConfig.of({ host, port, password })
  }))
}
```
