import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface EffectLifecycle<Key> {
  readonly run: (key: Key, effect: Effect.Effect<void>) => void;
  readonly sleep: (key: Key, milliseconds: number, action: () => void) => void;
  readonly cancel: (key: Key) => void;
  readonly repeat: (key: Key, milliseconds: number, action: () => void) => void;
  readonly stream: <A>(
    key: Key,
    source: Stream.Stream<A>,
    action: (value: A) => void,
  ) => void;
  readonly acquire: (key: Key, setup: () => () => void) => void;
  readonly stop: () => void;
}

function reportLifecycleCause(cause: Cause.Cause<unknown>) {
  if (Cause.hasInterruptsOnly(cause)) return;
  const error = Cause.squash(cause);
  if (globalThis.reportError) {
    globalThis.reportError(error);
    return;
  }
  setTimeout(() => {
    throw error;
  });
}

function observed(effect: Effect.Effect<void>): Effect.Effect<void> {
  return Effect.catchCause(effect, (cause) =>
    Effect.sync(() => reportLifecycleCause(cause)),
  );
}

function callbackEffect(action: () => void): Effect.Effect<void> {
  return observed(Effect.sync(action));
}

/**
 * A synchronously disposable bridge for React-owned lifecycles. Effect fibers
 * remain internal; callers expose ordinary callbacks and Promises.
 */
export function effectDelay(
  milliseconds: number,
  action: () => void,
): Effect.Effect<void> {
  return Effect.sleep(milliseconds).pipe(
    Effect.andThen(callbackEffect(action)),
  );
}

export function makeEffectLifecycle<Key>(): EffectLifecycle<Key> {
  const scope = Scope.makeUnsafe("sequential");
  const runFiber = Effect.runSync(
    Scope.provide(scope)(FiberMap.makeRuntime<never, Key>()),
  );
  let stopped = false;

  const run = (key: Key, effect: Effect.Effect<void>) => {
    if (stopped) return;
    runFiber(key, observed(effect));
  };
  return {
    run,
    sleep(key, milliseconds, action) {
      run(key, effectDelay(milliseconds, action));
    },
    cancel(key) {
      run(key, Effect.void);
    },
    repeat(key, milliseconds, action) {
      run(key, Effect.forever(effectDelay(milliseconds, action)));
    },
    stream(key, source, action) {
      run(
        key,
        Stream.runForEach(source, (value) =>
          callbackEffect(() => action(value)),
        ),
      );
    },
    acquire(key, setup) {
      run(
        key,
        Effect.scoped(
          Effect.acquireRelease(Effect.sync(setup), (cleanup) =>
            Effect.sync(cleanup),
          ).pipe(Effect.andThen(Effect.never)),
        ),
      );
    },
    stop() {
      if (stopped) return;
      stopped = true;
      Effect.runFork(Scope.close(scope, Exit.void));
    },
  };
}
