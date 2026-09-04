import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";

export interface SetupHealthResponse {
  readonly ok: boolean;
}

export interface SetupHealthWaitOptions {
  readonly initialDelay?: number;
  readonly retryInterval?: number;
  readonly timeout?: number;
}

export function waitForSetupHealthEffect(
  check: (signal: AbortSignal) => Promise<SetupHealthResponse>,
  {
    initialDelay = 1_000,
    retryInterval = 1_000,
    timeout = 30_000,
  }: SetupHealthWaitOptions = {},
) {
  const checkHealth = Effect.tryPromise(check).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      () => new Error("Server is not ready"),
    ),
  );
  return Effect.sleep(initialDelay).pipe(
    Effect.andThen(Effect.retry(checkHealth, Schedule.spaced(retryInterval))),
    Effect.timeout(timeout),
    Effect.asVoid,
  );
}

export async function waitForSetupHealth(
  check: (signal: AbortSignal) => Promise<SetupHealthResponse>,
  options: SetupHealthWaitOptions & { readonly signal?: AbortSignal } = {},
): Promise<boolean> {
  const exit = await Effect.runPromiseExit(
    waitForSetupHealthEffect(check, options),
    { signal: options.signal },
  );
  return Exit.isSuccess(exit);
}
