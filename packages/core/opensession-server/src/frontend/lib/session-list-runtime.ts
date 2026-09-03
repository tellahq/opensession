import * as Effect from "effect/Effect";
import type { BrowserSignalStreams } from "./effect-browser-events";
import { browserSignalStreams } from "./effect-browser-events";
import * as EffectLifecycle from "./effect-lifecycle";
import { ARCHIVED_POLL_MS } from "./session-list-state";

type SessionListFiber =
  | "live-request"
  | "live-fallback"
  | "archived-request"
  | "archived-fallback"
  | "invalidation-debounce"
  | "visibility";

export interface SessionListRuntimeOptions {
  readonly pollInterval: number;
  readonly loadArchived: boolean;
  readonly loading: boolean;
  readonly pollLive: () => Promise<void>;
  readonly pollArchived: () => Promise<void>;
}

export interface SessionListRuntime {
  readonly configure: (options: SessionListRuntimeOptions) => void;
  readonly start: () => () => void;
  readonly refresh: () => void;
  readonly invalidate: (action: () => void) => void;
}

const NO_OPTIONS: SessionListRuntimeOptions = {
  pollInterval: 60_000,
  loadArchived: false,
  loading: true,
  pollLive: async () => {},
  pollArchived: async () => {},
};

/** Effect owns request, fallback, visibility, and debounce fiber lifetimes. */
export function makeSessionListRuntime({
  streams = browserSignalStreams,
  isVisible = () => document.visibilityState !== "hidden",
  makeLifecycle = () => EffectLifecycle.makeEffectLifecycle<SessionListFiber>(),
}: {
  streams?: BrowserSignalStreams;
  isVisible?: () => boolean;
  makeLifecycle?: () => EffectLifecycle.EffectLifecycle<SessionListFiber>;
} = {}): SessionListRuntime {
  let options = NO_OPTIONS;
  let lifecycle: EffectLifecycle.EffectLifecycle<SessionListFiber> | null =
    null;
  let lifecycleId = 0;

  const visible = isVisible;
  const runLive = () => {
    const active = lifecycle;
    if (!active || !visible()) return;
    const current = lifecycleId;
    active.run(
      "live-request",
      Effect.tryPromise(() => options.pollLive()).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(
          Effect.sync(() => {
            if (current !== lifecycleId || !visible()) return;
            lifecycle?.sleep("live-fallback", options.pollInterval, runLive);
          }),
        ),
      ),
    );
  };
  const runArchived = () => {
    const active = lifecycle;
    if (!active || !visible() || !options.loadArchived || options.loading)
      return;
    const current = lifecycleId;
    active.run(
      "archived-request",
      Effect.tryPromise(() => options.pollArchived()).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(
          Effect.sync(() => {
            if (
              current !== lifecycleId ||
              !visible() ||
              !options.loadArchived ||
              options.loading
            )
              return;
            lifecycle?.sleep(
              "archived-fallback",
              ARCHIVED_POLL_MS,
              runArchived,
            );
          }),
        ),
      ),
    );
  };

  return {
    configure(next) {
      const shouldLoadArchived =
        next.loadArchived &&
        !next.loading &&
        (!options.loadArchived || options.loading);
      const shouldStopArchived =
        (!next.loadArchived || next.loading) &&
        options.loadArchived &&
        !options.loading;
      const pollChanged = next.pollLive !== options.pollLive;
      const intervalChanged = next.pollInterval !== options.pollInterval;
      options = next;
      if ((pollChanged || intervalChanged) && lifecycle) {
        lifecycle.cancel("live-fallback");
        runLive();
      }
      if (shouldStopArchived) {
        lifecycle?.cancel("archived-request");
        lifecycle?.cancel("archived-fallback");
      } else if (shouldLoadArchived) {
        lifecycle?.cancel("archived-fallback");
        runArchived();
      }
    },
    start() {
      if (lifecycle) return () => {};
      const current = ++lifecycleId;
      const active = makeLifecycle();
      lifecycle = active;
      active.stream("visibility", streams.visibility(), () => {
        if (current !== lifecycleId) return;
        active.cancel("live-fallback");
        active.cancel("archived-fallback");
        if (!visible()) return;
        runLive();
        runArchived();
      });
      runLive();
      runArchived();
      return () => {
        if (current !== lifecycleId) return;
        lifecycleId++;
        lifecycle = null;
        active.stop();
      };
    },
    refresh() {
      lifecycle?.cancel("live-fallback");
      lifecycle?.cancel("archived-fallback");
      runLive();
      runArchived();
    },
    invalidate(action) {
      lifecycle?.sleep("invalidation-debounce", 250, action);
    },
  };
}
