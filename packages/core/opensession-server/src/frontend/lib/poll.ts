import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { BrowserSignalStreams } from "./effect-browser-events";
import { browserSignalStreams } from "./effect-browser-events";
import * as EffectLifecycle from "./effect-lifecycle";

type PollFiber = "request" | "schedule";
type PollTask = (signal: AbortSignal) => void | Promise<void>;

export function makePollWhileVisible({
  streams = browserSignalStreams,
  isVisible = () => !document.hidden,
  makeLifecycle = () => EffectLifecycle.makeEffectLifecycle<PollFiber>(),
}: {
  streams?: Pick<BrowserSignalStreams, "visibility">;
  isVisible?: () => boolean;
  makeLifecycle?: () => EffectLifecycle.EffectLifecycle<PollFiber>;
} = {}) {
  /**
   * Polls after a delay while visible and refreshes immediately on
   * foregrounding. Replacing or stopping a request aborts its signal.
   */
  return (task: PollTask, milliseconds: number): (() => void) => {
    const lifecycle = makeLifecycle();
    const run = () => {
      if (!isVisible()) return;
      lifecycle.run(
        "request",
        Effect.tryPromise((signal) => Promise.resolve(task(signal))),
      );
    };
    lifecycle.stream(
      "schedule",
      Stream.merge(Stream.tick(milliseconds), streams.visibility()),
      run,
    );
    return lifecycle.stop;
  };
}

export const pollWhileVisible = makePollWhileVisible();

/** GitHub webhooks are the primary PR refresh path; this only recovers missed events. */
export const PR_WEBHOOK_FALLBACK_POLL_MS = 5 * 60_000;
