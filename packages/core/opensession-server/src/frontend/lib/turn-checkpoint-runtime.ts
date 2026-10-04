import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { request } from "./api/request";
import * as EffectLifecycle from "./effect-lifecycle";

export const TurnCheckpointPreview = Schema.Struct({
  patch: Schema.String,
  restorePatch: Schema.String,
  files: Schema.Array(Schema.String),
  currentTree: Schema.String,
  canRestore: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  canUndo: Schema.Boolean,
  interrupted: Schema.Boolean,
});
export type TurnCheckpointPreview = typeof TurnCheckpointPreview.Type;
export class TurnCheckpointError extends Schema.TaggedError<TurnCheckpointError>()(
  "TurnCheckpointError",
  { message: Schema.String },
) {}
const Completed = Schema.Struct({ ok: Schema.Boolean });
export interface TurnCheckpointState {
  loading: boolean;
  busy: boolean;
  error: string | null;
  preview: TurnCheckpointPreview | null;
  undo: boolean;
}
interface TurnCheckpointMutation {
  action: "revert" | "undo" | "discard";
  expectedTree?: string;
}
export function makeTurnCheckpointRuntime({
  changed,
  completed,
  send = request,
}: {
  changed: (state: TurnCheckpointState) => void;
  completed: () => void;
  send?: (
    path: string,
    options: {
      method: "GET" | "POST";
      body?: TurnCheckpointMutation;
      signal: AbortSignal;
      label: string;
    },
  ) => Promise<Schema.Json>;
}) {
  const lifecycle = EffectLifecycle.makeEffectLifecycle<
    "preview" | "mutation"
  >();
  let state: TurnCheckpointState = {
    loading: false,
    busy: false,
    error: null,
    preview: null,
    undo: false,
  };
  const update = (patch: Partial<TurnCheckpointState>) => {
    state = { ...state, ...patch };
    changed(state);
  };
  const read = Effect.fn("TurnCheckpointRuntime.request")(function* (
    path: string,
    body?: TurnCheckpointMutation,
  ) {
    return yield* Effect.tryPromise({
      try: (signal) =>
        send(path, {
          method: body === undefined ? "GET" : "POST",
          body,
          signal,
          label: "Workspace checkpoint unavailable",
        }),
      catch: (error) =>
        new TurnCheckpointError({
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  });
  const endpoint = (sessionId: string, turnId: string) =>
    `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/checkpoint`;
  return {
    load(sessionId: string, turnId: string, undo = false) {
      update({ loading: true, preview: null, error: null, undo });
      lifecycle.run(
        "preview",
        read(endpoint(sessionId, turnId) + (undo ? "?undo=true" : "")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TurnCheckpointPreview)),
          Effect.timeout(30_000),
          Effect.mapError((error) =>
            error instanceof TurnCheckpointError
              ? error
              : new TurnCheckpointError({
                  message: "Could not read the workspace checkpoint",
                }),
          ),
          Effect.flatMap((preview) =>
            Effect.sync(() => update({ preview, loading: false })),
          ),
          Effect.catch((error) =>
            Effect.sync(() => update({ error: error.message, loading: false })),
          ),
        ),
      );
    },
    act(
      sessionId: string,
      turnId: string,
      action: "revert" | "undo" | "discard",
      expectedTree?: string,
    ) {
      if (state.busy) return;
      update({ busy: true, error: null });
      // Never automatically retry a destructive request after an ambiguous
      // transport failure. Reopening the preview recovers the durable intent.
      lifecycle.run(
        "mutation",
        read(endpoint(sessionId, turnId), { action, expectedTree }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Completed)),
          Effect.flatMap((result) =>
            result.ok
              ? Effect.sync(() => {
                  update({ busy: false });
                  completed();
                })
              : Effect.fail(
                  new TurnCheckpointError({
                    message: "Workspace revert did not complete",
                  }),
                ),
          ),
          Effect.mapError((error) =>
            error instanceof TurnCheckpointError
              ? error
              : new TurnCheckpointError({
                  message:
                    "Workspace revert failed. Reopen the preview to check recovery.",
                }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => update({ error: error.message, busy: false })),
          ),
        ),
      );
    },
    stop: lifecycle.stop,
  };
}
