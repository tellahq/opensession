import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "bun:test";
import type { StreamEvent } from "./agent-runner";
import { tagHostedEvent } from "./host-event-publication";
import { consumeOpeningRunEvents } from "./opening-run-events";

test("opening events retain physical A/B source across awaits and terminal settlement before retirement", async () => {
  const source = new AsyncLocalStorage<string>();
  const alive = new Set(["A", "B"]);
  const tagged = (host: string, event: StreamEvent) =>
    tagHostedEvent(event, {
      personal: true,
      alive: () => alive.has(host),
      run: (work) => source.run(host, work),
    });
  const queuedA = tagged("A", { type: "text_chunk", text: "stale" });
  const seen: string[] = [];
  let terminalSettled = false;
  async function* events(): AsyncGenerator<StreamEvent> {
    yield tagged("A", { type: "text_chunk", text: "A" });
    alive.delete("A");
    yield queuedA;
    yield { ...tagged("B", { type: "text_chunk", text: "B" }) };
    yield tagged("B", { type: "done" });
    expect(terminalSettled).toBe(true);
    alive.delete("B");
  }
  await source.run("admission", () =>
    consumeOpeningRunEvents(events(), true, async (event) => {
      await Promise.resolve();
      seen.push(`${source.getStore()}:${event.type}`);
      if (event.type === "done") {
        expect(alive.has("B")).toBe(true);
        expect(source.getStore()).toBe("B");
        terminalSettled = true;
      }
    }),
  );
  expect(seen).toEqual(["A:text_chunk", "B:text_chunk", "B:done"]);
});

for (const shared of [false, true]) {
  test(`private opening denies ${shared ? "shared" : "missing"} event authority`, async () => {
    let consumed = false;
    async function* events(): AsyncGenerator<StreamEvent> {
      const event: StreamEvent = { type: "done" };
      yield shared
        ? tagHostedEvent(event, {
            personal: false,
            alive: () => true,
            run: (work) => work(),
          })
        : event;
    }
    await expect(
      consumeOpeningRunEvents(events(), true, async () => {
        consumed = true;
      }),
    ).rejects.toThrow();
    expect(consumed).toBe(false);
  });
}

test("shared opening still consumes untagged events", async () => {
  let consumed = false;
  async function* events(): AsyncGenerator<StreamEvent> {
    yield { type: "done" };
  }
  await consumeOpeningRunEvents(events(), false, async () => {
    consumed = true;
  });
  expect(consumed).toBe(true);
});

for (const mode of [
  "empty",
  "throw",
  "consumer-failure",
  "terminal",
] as const) {
  test(`opaque opening lifetime is finalized after ${mode}, independently of last event`, async () => {
    const { attachHostedRunLifetime, finalizeHostedRun } =
      await import("./host-run-lifetime");
    const order: string[] = [];
    async function* source(): AsyncGenerator<StreamEvent> {
      if (mode === "empty") return;
      if (mode === "throw") throw new Error("host failed before first event");
      yield tagHostedEvent(
        { type: "done" },
        { personal: true, alive: () => true, run: (work) => work() },
      );
    }
    const stream = attachHostedRunLifetime(source(), {
      async finalize() {
        order.push("finalized");
      },
    });
    try {
      await consumeOpeningRunEvents(stream, true, async () => {
        order.push("terminal-writes");
        if (mode === "consumer-failure") throw new Error("write failed");
      });
    } catch {
      order.push("failure-handling");
    } finally {
      await finalizeHostedRun(stream);
    }
    expect(order.at(-1)).toBe("finalized");
    expect(order.filter((value) => value === "finalized")).toHaveLength(1);
    if (mode === "terminal")
      expect(order).toEqual(["terminal-writes", "finalized"]);
  });
}
