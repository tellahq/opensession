import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { API_BASE } from "./api/request";
import { browserSignalStreams } from "./effect-browser-events";
import * as EffectLifecycle from "./effect-lifecycle";

const Run = Schema.Struct({
  pid: Schema.Number,
  sessionId: Schema.String,
  runId: Schema.String,
  kind: Schema.Literals(["agent", "script", "portal", "shell"]),
  start: Schema.optional(Schema.String),
  cpu: Schema.Number,
  rss: Schema.Number,
  processes: Schema.Number,
});
export const ResourceEvent = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    sample: Schema.Struct({
      at: Schema.Number,
      host: Schema.Struct({
        cpu: Schema.NullOr(Schema.Number),
        usedMemory: Schema.Number,
        totalMemory: Schema.Number,
      }),
      runs: Schema.Array(Run),
    }),
  }),
]);
export type ResourceState =
  | typeof ResourceEvent.Type
  | { readonly status: "loading" };
class ResourceError extends Schema.TaggedError<ResourceError>()(
  "ResourceError",
  { message: Schema.String },
) {}

/** A scoped SSE connection, bounded before decoding; Effect owns close and retry. */
function resourceEvents() {
  return Stream.callback<string, ResourceError>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const source = new EventSource(`${API_BASE}/agent-resources/events`);
          source.onmessage = (event) => {
            if (event.data.length > 1_048_576) {
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(new ResourceError({ message: "Sample too large" })),
              );
            } else Queue.offerUnsafe(queue, event.data);
          };
          source.onerror = () =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new ResourceError({ message: "Metrics unavailable" })),
            );
          return source;
        }),
        (source) => Effect.sync(() => source.close()),
      ),
    { bufferSize: 1, strategy: "sliding" },
  ).pipe(
    Stream.mapEffect((text) =>
      Effect.try({
        try: () => JSON.parse(text),
        catch: () => new ResourceError({ message: "Invalid metrics" }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResourceEvent)),
        Effect.flatMap((event) =>
          event.status === "unavailable"
            ? Effect.fail(new ResourceError({ message: "Sampler unavailable" }))
            : Effect.succeed(event),
        ),
      ),
    ),
  );
}

export function makeAgentResourceRuntime(
  onState: (state: ResourceState) => void,
  onStop: (error: string | null) => void,
) {
  const lifecycle = EffectLifecycle.makeEffectLifecycle<
    "events" | "visibility" | "stop"
  >();
  const refresh = () => {
    lifecycle.cancel("events");
    if (document.visibilityState === "hidden") return;
    onState({ status: "loading" });
    lifecycle.run(
      "events",
      resourceEvents().pipe(
        Stream.tapError(() =>
          Effect.sync(() => onState({ status: "unavailable" })),
        ),
        Stream.retry(Schedule.spaced(5000)),
        Stream.runForEach((event) => Effect.sync(() => onState(event))),
        Effect.catch(() => Effect.void),
      ),
    );
  };
  refresh();
  lifecycle.stream("visibility", browserSignalStreams.visibility(), refresh);
  return {
    stopSession(sessionId: string, user: string) {
      lifecycle.run(
        "stop",
        Effect.tryPromise({
          try: (signal) =>
            fetch(`${API_BASE}/agent-resources/stop`, {
              method: "POST",
              signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, user }),
            }).then(async (response) => {
              if (!response.ok) throw new Error("Could not stop the session");
              const body: unknown = await response.json();
              return body;
            }),
          catch: () =>
            new ResourceError({ message: "Could not stop the session" }),
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Struct({ ok: Schema.Boolean })),
          ),
          Effect.andThen((result) =>
            Effect.sync(() =>
              onStop(result.ok ? null : "No active agent run to stop"),
            ),
          ),
          Effect.catch(() =>
            Effect.sync(() => onStop("Could not stop the session")),
          ),
        ),
      );
    },
    dispose: () => lifecycle.stop(),
  };
}

export function resourceSessions(state: ResourceState) {
  if (state.status !== "ready") return [];
  const sessions = new Map<
    string,
    {
      sessionId: string;
      cpu: number;
      rss: number;
      runs: number;
      agent: boolean;
    }
  >();
  for (const run of state.sample.runs) {
    const row = sessions.get(run.sessionId) ?? {
      sessionId: run.sessionId,
      cpu: 0,
      rss: 0,
      runs: 0,
      agent: false,
    };
    row.cpu += run.cpu;
    row.rss += run.rss;
    row.runs++;
    row.agent ||= run.kind === "agent";
    sessions.set(run.sessionId, row);
  }
  return [...sessions.values()].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
}
