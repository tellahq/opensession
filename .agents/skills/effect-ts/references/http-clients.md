# HTTP Clients

Verified against `effect@4.0.0-rc.112` (`effect/unstable/http`). Open Session's
frontend keeps its Promise-based `lib/api/request.ts`; this reference is for
new Effect-native services, not for wrapping that API.

## Table of Contents

- [Minimal Example](#minimal-example)
- [Building Requests](#building-requests)
- [Response Decoding](#response-decoding)
- [Client Middleware](#client-middleware)
- [Error Handling](#error-handling)
- [Retries](#retries)
- [Worked Example: Typed API Service](#worked-example-typed-api-service)
- [Quick Reference](#quick-reference)

## Minimal Example

```typescript
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Effect, Schema } from "effect"

const Repo = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  full_name: Schema.String,
  stargazers_count: Schema.Number,
})

const program = Effect.gen(function* () {
  const response = yield* HttpClient.get("https://api.github.com/repos/Effect-TS/effect")
  const repo = yield* HttpClientResponse.schemaBodyJson(Repo)(response)
  console.log(`${repo.full_name}: ${repo.stargazers_count} stars`)
})

program.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise)
```

- `HttpClient.get` returns an Effect requiring `HttpClient` in context
- `HttpClientResponse.schemaBodyJson` decodes and validates the JSON body
- `FetchHttpClient.layer` provides the implementation using `fetch`

## Building Requests

### Headers

```typescript
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const request = HttpClientRequest.get("https://api.github.com/repos/Effect-TS/effect").pipe(
  HttpClientRequest.setHeader("Accept", "application/vnd.github.v3+json"),
  HttpClientRequest.bearerToken("ghp_xxxx"),
)
const response = yield* HttpClient.execute(request)
```

Helpers: `setHeader`, `setHeaders`, `bearerToken`, `basicAuth`, `acceptJson`.

### Query Parameters

```typescript
const request = HttpClientRequest.get("https://api.github.com/search/repositories").pipe(
  HttpClientRequest.setUrlParam("q", "effect language:typescript"),
  HttpClientRequest.setUrlParam("sort", "stars"),
)
```

### Request Body

Use `HttpClientRequest.schemaBodyJson` (returns an Effect because encoding can fail):

```typescript
const CreateIssue = Schema.Struct({ title: Schema.String, body: Schema.String })

const request = yield* HttpClientRequest.post(`https://api.github.com/repos/${owner}/${repo}/issues`).pipe(
  HttpClientRequest.schemaBodyJson(CreateIssue)({ title: "Bug", body: "Description" })
)
const response = yield* HttpClient.execute(request)
```

## Response Decoding

### Schema-validated JSON body

```typescript
const response = yield* HttpClient.get("https://api.github.com/users/effect-ts")
const user = yield* HttpClientResponse.schemaBodyJson(User)(response)
```

### Status code matching

```typescript
const result = yield* HttpClientResponse.matchStatus(response, {
  "2xx": HttpClientResponse.schemaBodyJson(User),
  404: () => Effect.fail(new UserNotFound(username)),
  orElse: (r) => Effect.fail(new Error(`Unexpected: ${r.status}`)),
})
```

### Filter 2xx only

```typescript
yield* HttpClientResponse.filterStatusOk(response) // fails on non-2xx
const user = yield* HttpClientResponse.schemaBodyJson(User)(response)
```

## Client Middleware

Derive a configured client from `HttpClient.HttpClient` inside the layer that
needs it. `mapRequest` rewrites every request, `filterStatusOk` fails non-2xx,
`retryTransient` retries network errors and 5xx:

```typescript
import { flow, Schedule } from "effect"

const client = (yield* HttpClient.HttpClient).pipe(
  HttpClient.mapRequest(flow(
    HttpClientRequest.prependUrl("https://api.github.com"),
    HttpClientRequest.bearerToken("ghp_xxxx"),
    HttpClientRequest.acceptJson
  )),
  HttpClient.filterStatusOk,
  HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
)
```

## Error Handling

```typescript
const program = Effect.gen(function* () {
  const response = yield* HttpClient.get("https://api.example.com/data")
  return yield* HttpClientResponse.schemaBodyJson(Data)(response)
}).pipe(
  Effect.catchTag("RequestError", (e) =>
    Effect.fail(`Network error: ${e.reason}`)
  ),
  Effect.catchTag("ResponseError", (e) =>
    Effect.fail(`HTTP ${e.response.status}: ${e.reason}`)
  ),
)
```

- `RequestError`: network failures, DNS errors, timeouts
- `ResponseError`: non-2xx status (with `filterStatusOk`) or body parsing failures

## Retries

Retry a single call with a schedule (there is no `Schedule.compose`; use the
options form or `Schedule.max`):

```typescript
const withRetry = program.pipe(
  Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 3 })
)
```

Built-in transient retry on the client (network errors, 5xx):

```typescript
const resilient = (yield* HttpClient.HttpClient).pipe(
  HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
)
```

## Worked Example: Typed API Service

```typescript
import { Context, Effect, flow, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const UserId = Schema.Number.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

class User extends Schema.Class<User>("User")({
  id: UserId,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  public_repos: Schema.Number,
}) {}

class Repo extends Schema.Class<Repo>("Repo")({
  id: Schema.Number,
  name: Schema.String,
  full_name: Schema.String,
  stargazers_count: Schema.Number,
}) {}

class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  cause: Schema.Defect(),
}) {}

class GitHubApi extends Context.Service<GitHubApi, {
  getUser(username: string): Effect.Effect<User, GitHubError>
  getRepo(owner: string, repo: string): Effect.Effect<Repo, GitHubError>
  listRepos(username: string): Effect.Effect<ReadonlyArray<Repo>, GitHubError>
}>()("app/GitHubApi") {
  static readonly layerNoDeps = Layer.effect(
    GitHubApi,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(flow(
          HttpClientRequest.prependUrl("https://api.github.com"),
          HttpClientRequest.acceptJson
        )),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
      )

      const getUser = Effect.fn("GitHubApi.getUser")(function* (username: string) {
        yield* Effect.annotateCurrentSpan({ username })
        return yield* client.get(`/users/${username}`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(User)),
          Effect.mapError((cause) => new GitHubError({ cause }))
        )
      })

      const getRepo = Effect.fn("GitHubApi.getRepo")(function* (owner: string, repo: string) {
        return yield* client.get(`/repos/${owner}/${repo}`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Repo)),
          Effect.mapError((cause) => new GitHubError({ cause }))
        )
      })

      const listRepos = Effect.fn("GitHubApi.listRepos")(function* (username: string) {
        return yield* client.get(`/users/${username}/repos`, { urlParams: { per_page: "100" } }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(Repo))),
          Effect.mapError((cause) => new GitHubError({ cause }))
        )
      })

      return GitHubApi.of({ getUser, getRepo, listRepos })
    })
  )

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer))
}

// Usage
const program = Effect.gen(function* () {
  const github = yield* GitHubApi
  const user = yield* github.getUser("effect-ts")
  const repo = yield* github.getRepo("Effect-TS", "effect")
  yield* Effect.log(`${user.login}: ${user.public_repos} repos`)
  yield* Effect.log(`${repo.full_name}: ${repo.stargazers_count} stars`)
})

program.pipe(Effect.provide(GitHubApi.layer), Effect.runPromise)
```

Per-request options (`urlParams`, `headers`, `body`) are the second argument
to `client.get` / `client.post`; `HttpClientRequest.bodyJsonUnsafe(value)`
plus `client.execute` builds a JSON request when a schema is not needed.

## Quick Reference

| Concept | API |
|---------|-----|
| Simple GET | `HttpClient.get(url)` |
| Execute request | `HttpClient.execute(request)` |
| Build request | `HttpClientRequest.get`, `.post`, `.put`, `.patch`, `.del` |
| Set headers | `HttpClientRequest.setHeader`, `.bearerToken`, `.basicAuth` |
| Query params | `HttpClientRequest.setUrlParam`, `.setUrlParams` |
| JSON body | `HttpClientRequest.schemaBodyJson(Schema)(data)` |
| Decode response | `HttpClientResponse.schemaBodyJson(Schema)(response)` |
| Status matching | `HttpClientResponse.matchStatus(response, { ... })` |
| Filter 2xx | `HttpClientResponse.filterStatusOk(response)` |
| Base URL | `HttpClient.mapRequest(HttpClientRequest.prependUrl(url))` |
| Retry transient | `HttpClient.retryTransient({ schedule, times })` |
| Only 2xx | `HttpClient.filterStatusOk` (client) or `HttpClientResponse.filterStatusOk` (response) |
| Provide client | `Effect.provide(FetchHttpClient.layer)` |
