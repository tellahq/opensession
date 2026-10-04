import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeServerDescriptor,
  type ServerDescriptor,
} from "@tellahq/opensession-protocol/capabilities";
import { API_BASE } from "./api/request";
import * as EffectLifecycle from "./effect-lifecycle";
import { browserSignalStreams } from "./effect-browser-events";

const DescriptorWire = Schema.Struct({
  serverVersion: Schema.String,
  protocolVersion: Schema.Int,
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
});
export class CapabilityFetchError extends Schema.TaggedError<CapabilityFetchError>()(
  "CapabilityFetchError",
  { cause: Schema.Defect() },
) {}

export const fetchServerDescriptor = Effect.fn("capabilities.fetch")(
  function* (fetcher: (url: string, init: RequestInit) => Promise<Response>) {
    const value = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetcher(`${API_BASE}/capabilities`, {
          cache: "no-store",
          signal,
        });
        if (!response.ok)
          throw new Error(`Capabilities unavailable (${response.status})`);
        const value: unknown = await response.json();
        return value;
      },
      catch: (cause) => new CapabilityFetchError({ cause }),
    });
    const wire = yield* Schema.decodeUnknownEffect(DescriptorWire)(value);
    return decodeServerDescriptor(wire);
  },
  Effect.catch(() => Effect.succeed(null)),
);

let descriptor: ServerDescriptor | null = null;
let revision = 0;
const listeners = new Set<() => void>();
let runtime: EffectLifecycle.EffectLifecycle<string> | null = null;
let owners = 0;

export function serverDescriptorSnapshot(): ServerDescriptor | null {
  return descriptor;
}
export function subscribeServerDescriptor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hello replaces, never merges, the previous server's capabilities. */
export function publishServerDescriptor(
  value: ServerDescriptor | null | undefined,
): void {
  revision++;
  descriptor = Effect.runSync(
    Schema.decodeUnknownEffect(DescriptorWire)(value).pipe(
      Effect.map(decodeServerDescriptor),
      Effect.catch(() => Effect.succeed(null)),
    ),
  );
  for (const listener of listeners) listener();
}

export const refreshServerDescriptorEffect = Effect.fn("capabilities.refresh")(
  function* (fetcher: (url: string, init: RequestInit) => Promise<Response>) {
    const startedAt = revision;
    const value = yield* fetchServerDescriptor(fetcher);
    // An in-flight HTTP response must not overwrite a newer WS hello.
    if (revision === startedAt)
      yield* Effect.sync(() => publishServerDescriptor(value));
  },
);

/** One scoped fetch and focus subscription for all mounted consumers. */
export function acquireServerCapabilities(): () => void {
  owners++;
  if (!runtime) {
    const lifecycle = EffectLifecycle.makeEffectLifecycle<string>();
    runtime = lifecycle;
    lifecycle.run("refresh", refreshServerDescriptorEffect(fetch));
    lifecycle.stream("focus", browserSignalStreams.focus(), () =>
      lifecycle.run("refresh", refreshServerDescriptorEffect(fetch)),
    );
  }
  return () => {
    if (--owners !== 0) return;
    runtime?.stop();
    runtime = null;
    publishServerDescriptor(null);
  };
}
