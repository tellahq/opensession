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
  readonly pollLive: (signal: AbortSignal) => Promise<void>;
  readonly pollArchived: (signal: AbortSignal) => Promise<void>;
}

export interface SessionListRuntime {
  readonly configure: (options: SessionListRuntimeOptions) => void;
  readonly start: () => () => void;
  readonly refresh: () => void;
  readonly refreshArchived: () => void;
  readonly invalidate: (options?: { refreshArchived?: boolean }) => void;
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
      Effect.tryPromise(options.pollLive).pipe(
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
  const runArchived = (force = false) => {
    const active = lifecycle;
    if (
      !active ||
      !visible() ||
      (!force && (!options.loadArchived || options.loading))
    )
      return;
    const current = lifecycleId;
    active.run(
      "archived-request",
      Effect.tryPromise(options.pollArchived).pipe(
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
  const refresh = () => {
    lifecycle?.cancel("live-fallback");
    lifecycle?.cancel("archived-fallback");
    runLive();
    runArchived();
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
        if (pollChanged) lifecycle.cancel("live-request");
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
    refresh,
    refreshArchived() {
      lifecycle?.cancel("archived-fallback");
      runArchived(true);
    },
    invalidate(invalidationOptions = {}) {
      lifecycle?.sleep("invalidation-debounce", 250, () => {
        refresh();
        if (invalidationOptions.refreshArchived && !options.loadArchived)
          runArchived(true);
      });
    },
  };
}
