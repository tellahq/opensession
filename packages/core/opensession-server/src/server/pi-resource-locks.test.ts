import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  PiResourceLockManager,
  defaultToolResourceKeys,
  normalizeResourceKeys,
  piResourceLockTools,
} from "./pi-resource-locks";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("normalizeResourceKeys", () => {
  test("deduplicates keys, upgrades read+write to write, and sorts deterministically", () => {
    expect(
      normalizeResourceKeys([
        { key: "/b.ts", mode: "read" },
        { key: "/a.ts", mode: "read" },
        { key: "/b.ts", mode: "write" },
      ]),
    ).toEqual([
      { key: "/a.ts", mode: "read" },
      { key: "/b.ts", mode: "write" },
    ]);
  });
});

describe("PiResourceLockManager", () => {
  test("allows concurrent reads on the same key and serializes writes", async () => {
    const locks = new PiResourceLockManager();
    const events: string[] = [];
    const r1Gate = deferred();
    const r2Gate = deferred();
    const wGate = deferred();

    const r1 = locks.withLocks(
      [{ key: "/file.ts", mode: "read" }],
      async () => {
        events.push("r1:start");
        await r1Gate.promise;
        events.push("r1:end");
      },
    );
    const r2 = locks.withLocks(
      [{ key: "/file.ts", mode: "read" }],
      async () => {
        events.push("r2:start");
        await r2Gate.promise;
        events.push("r2:end");
      },
    );
    const w1 = locks.withLocks(
      [{ key: "/file.ts", mode: "write" }],
      async () => {
        events.push("w1:start");
        await wGate.promise;
        events.push("w1:end");
      },
    );
    const r3 = locks.withLocks(
      [{ key: "/file.ts", mode: "read" }],
      async () => {
        events.push("r3:start");
      },
    );

    await Bun.sleep(10);
    // Both initial readers entered concurrently; writer and trailing reader wait (FIFO fairness).
    expect(events).toEqual(["r1:start", "r2:start"]);

    r1Gate.resolve();
    r2Gate.resolve();
    await Bun.sleep(10);
    expect(events).toEqual([
      "r1:start",
      "r2:start",
      "r1:end",
      "r2:end",
      "w1:start",
    ]);

    wGate.resolve();
    await Promise.all([r1, r2, w1, r3]);
    expect(events).toEqual([
      "r1:start",
      "r2:start",
      "r1:end",
      "r2:end",
      "w1:start",
      "w1:end",
      "r3:start",
    ]);
  });

  test("runs writes to disjoint files in parallel and avoids deadlock on reversed multi-file locks", async () => {
    const locks = new PiResourceLockManager();
    let active = 0;
    let peak = 0;

    const work = async (key: string) =>
      locks.withLocks([{ key, mode: "write" }], async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(15);
        active--;
      });

    await Promise.all([work("/a.ts"), work("/b.ts")]);
    expect(peak).toBe(2);

    // Reversed multi-key order must complete without deadlocking.
    await Promise.all([
      locks.withLocks(
        [
          { key: "/x.ts", mode: "write" },
          { key: "/y.ts", mode: "write" },
        ],
        async () => {
          await Bun.sleep(5);
        },
      ),
      locks.withLocks(
        [
          { key: "/y.ts", mode: "write" },
          { key: "/x.ts", mode: "write" },
        ],
        async () => {
          await Bun.sleep(5);
        },
      ),
    ]);
  });

  test("aborts a queued waiter cleanly without stranding locks", async () => {
    const locks = new PiResourceLockManager();
    const hold = deferred();
    const ac = new AbortController();

    const first = locks.withLocks(
      [{ key: "/k", mode: "write" }],
      () => hold.promise,
    );
    await Bun.sleep(5);

    const aborted = locks.withLocks(
      [{ key: "/k", mode: "write" }],
      async () => "never",
      ac.signal,
    );
    ac.abort();
    await expect(aborted).rejects.toThrow("Aborted");

    hold.resolve();
    await first;

    // Subsequent acquisition succeeds cleanly.
    const next = await locks.withLocks(
      [{ key: "/k", mode: "write" }],
      async () => "ok",
    );
    expect(next).toBe("ok");
  });
});

describe("piResourceLockTools", () => {
  test("serializes concurrent edit calls on the same file via defaultToolResourceKeys", async () => {
    const locks = new PiResourceLockManager();
    let active = 0;
    let peak = 0;

    const fakeEdit: ToolDefinition<any, any, any> = {
      name: "edit",
      label: "edit",
      description: "edit",
      parameters: {} as any,
      async execute() {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(15);
        active--;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    };

    const [wrapped] = piResourceLockTools([fakeEdit], locks, "/repo");
    await Promise.all([
      wrapped!.execute(
        "1",
        { path: "src/a.ts" },
        undefined,
        undefined,
        {} as any,
      ),
      wrapped!.execute(
        "2",
        { path: "./src/a.ts" },
        undefined,
        undefined,
        {} as any,
      ),
    ]);
    expect(peak).toBe(1);

    expect(
      defaultToolResourceKeys(
        "apply_patch",
        {
          patch:
            "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** End Patch",
        },
        "/repo",
      ),
    ).toEqual([
      { key: "/repo/a.ts", mode: "write" },
      { key: "/repo/b.ts", mode: "write" },
    ]);
  });
});
