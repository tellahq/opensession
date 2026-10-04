import { describe, expect, test } from "bun:test";
import { DrainableWork } from "./drainable-work";

describe("drainable work", () => {
  test("an idle drain resolves and synchronous return/throw behavior is retained", async () => {
    const work = new DrainableWork();
    await work.drain();
    expect(work.run(() => 42)).toBe(42);
    expect(() =>
      work.run(() => {
        throw new Error("failed");
      }),
    ).toThrow("failed");
    await work.drain();
  });

  test("tracks queued callbacks before the first microtask and preserves their order", async () => {
    const work = new DrainableWork();
    const seen: number[] = [];
    work.schedule(() => {
      seen.push(1);
    });
    queueMicrotask(() => {
      seen.push(2);
    });
    work.schedule(() => {
      seen.push(3);
    });
    expect(seen).toEqual([]);
    await work.drain();
    expect(seen).toEqual([1, 2, 3]);
  });

  test("an empty queue does not release concurrent drainers while work is in flight", async () => {
    const work = new DrainableWork();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    work.schedule(async () => {
      entered.resolve();
      await held.promise;
    });
    let completed = 0;
    const drains = [work.drain(), work.drain()].map((p) =>
      p.then(() => completed++),
    );
    await entered.promise;
    expect(completed).toBe(0);
    held.resolve();
    await Promise.all(drains);
    expect(completed).toBe(2);
  });

  test("includes reentrant work and work enqueued while draining", async () => {
    const work = new DrainableWork();
    const held = Promise.withResolvers<void>();
    const first = work.run(() => held.promise);
    const seen: number[] = [];
    const drain = work.drain();
    work.schedule(() => {
      seen.push(1);
      work.schedule(() => {
        seen.push(2);
      });
    });
    held.resolve();
    await drain;
    await first;
    expect(seen).toEqual([1, 2]);
  });

  test("failed processing releases drainers and remains observable by the caller", async () => {
    const work = new DrainableWork();
    const held = Promise.withResolvers<void>();
    const task = work.run(() => held.promise);
    const rejection = task.catch((error: Error) => error.message);
    const drain = work.drain();
    held.reject(new Error("failed"));
    expect(await rejection).toBe("failed");
    await drain;
    expect(work.run(() => "later")).toBe("later");
    await work.drain();
  });
});
