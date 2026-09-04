import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { waitForSetupHealthEffect } from "./setup-restart";

test("setup health retries on a fixed cadence until the server is ready", async () => {
  let attempts = 0;
  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      waitForSetupHealthEffect(async () => ({ ok: ++attempts === 3 }), {
        initialDelay: 1_000,
        retryInterval: 1_000,
        timeout: 30_000,
      }),
    );

    yield* TestClock.adjust(1_000);
    expect(attempts).toBe(1);
    yield* TestClock.adjust(1_000);
    expect(attempts).toBe(2);
    yield* TestClock.adjust(1_000);
    yield* Fiber.join(fiber);
    expect(attempts).toBe(3);
  });

  await Effect.runPromise(Effect.provide(program, TestClock.layer()));
});

test("setup health timeout interrupts a hanging request", async () => {
  let requestSignal: AbortSignal | undefined;
  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      Effect.exit(
        waitForSetupHealthEffect(
          (signal) => {
            requestSignal = signal;
            return new Promise(() => {});
          },
          { initialDelay: 1_000, retryInterval: 1_000, timeout: 2_000 },
        ),
      ),
    );

    yield* TestClock.adjust(2_000);
    yield* Fiber.join(fiber);
    expect(requestSignal?.aborted).toBe(true);
  });

  await Effect.runPromise(Effect.provide(program, TestClock.layer()));
});
