import { describe, expect, test } from "bun:test";
import { ResourceAttribution, ResourceHistory } from "./resource-attribution";
import type {
  AgentResourceSample,
  ResourceProcess,
  ResourceRoot,
} from "../shared/agent-resources";
import { AgentResources } from "./agent-resources";
import { parseProcessTime } from "./resource-sampler";

const host = { cpu: null, usedMemory: 10, totalMemory: 100 };
const root: ResourceRoot = {
  pid: 10,
  sessionId: "example-session",
  runId: "run-1",
  kind: "agent",
};
const process = (
  pid: number,
  ppid: number,
  start = "100",
  cpuMs = 100,
  rss = 1024,
): ResourceProcess => ({ pid, ppid, start, cpuMs, rss });
const empty = (at: number): AgentResourceSample => ({ at, host, runs: [] });

describe("resource attribution", () => {
  test("nearest root attributes each descendant once and CPU uses deltas", () => {
    const attribution = new ResourceAttribution();
    const roots = [
      root,
      { ...root, pid: 12, runId: "script-1", kind: "script" as const },
    ];
    attribution.sample(
      1000,
      host,
      [process(10, 1), process(11, 10), process(12, 10), process(13, 12)],
      roots,
    );
    const sample = attribution.sample(
      2000,
      host,
      [
        process(10, 1, "100", 600),
        process(11, 10, "100", 350),
        process(12, 10),
        process(13, 12),
      ],
      roots,
    );
    const agent = sample.runs.find((r) => r.kind === "agent")!;
    expect(agent.cpu).toBe(75);
    expect(agent.rss).toBe(2048);
    expect(agent.processes).toBe(2);
    expect(sample.runs.find((r) => r.kind === "script")?.processes).toBe(2);
  });
  test("PID reuse never adopts a replacement root, even after a missing sample", () => {
    const attribution = new ResourceAttribution();
    attribution.sample(1000, host, [process(10, 1)], [root]);
    attribution.sample(2000, host, [], [root]);
    expect(
      attribution.sample(
        3000,
        host,
        [process(10, 1, "200"), process(11, 10)],
        [root],
      ).runs,
    ).toEqual([]);
    expect(
      attribution.sample(
        4000,
        host,
        [process(10, 1, "200")],
        [{ ...root, runId: "run-2" }],
      ).runs,
    ).toHaveLength(1);
  });
  test("expected identity rejects a stale root on the first sample", () => {
    expect(
      new ResourceAttribution().sample(
        1000,
        host,
        [process(10, 1, "200")],
        [{ ...root, start: "100" }],
      ).runs,
    ).toEqual([]);
  });
  test("recycled child does not inherit old CPU counters; cycles terminate", () => {
    const attribution = new ResourceAttribution();
    attribution.sample(1000, host, [process(10, 1), process(11, 10)], [root]);
    const sample = attribution.sample(
      2000,
      host,
      [
        process(10, 1),
        process(11, 10, "200", 10000),
        process(99, 98),
        process(98, 99),
      ],
      [root],
    );
    expect(sample.runs[0].cpu).toBe(0);
  });
});

test("history bounds age, count and encoded bytes independently", () => {
  const count = new ResourceHistory(10000, 2, 10000);
  for (let i = 1; i <= 3; i++) count.add(empty(i));
  expect(count.values(3).map((s) => s.at)).toEqual([2, 3]);
  expect(count.values(20000)).toEqual([]);
  const bytes = new TextEncoder().encode(JSON.stringify(empty(1))).byteLength;
  const memory = new ResourceHistory(10000, 100, bytes + 1);
  memory.add(empty(1));
  memory.add(empty(2));
  expect(memory.values(2).map((s) => s.at)).toEqual([2]);
  const oversized = new ResourceHistory(10000, 100, 1);
  oversized.add(empty(1));
  expect(oversized.values(1)).toEqual([]);
});

test("no subscribers means no sampler; shared subscribers stop only on last close", () => {
  let launched = 0;
  let stopped = 0;
  const service = new AgentResources(
    async () => [],
    () => {
      launched++;
      return {
        stop() {
          stopped++;
        },
      };
    },
  );
  expect(launched).toBe(0);
  const first = service.subscribe(() => {});
  const second = service.subscribe(() => {});
  expect(launched).toBe(1);
  first();
  first();
  expect(stopped).toBe(0);
  second();
  expect(stopped).toBe(1);
  service.subscribe(() => {})();
  expect(launched).toBe(2);
  expect(stopped).toBe(2);
});

test("late samples from a stopped generation cannot enter history", async () => {
  let deliver:
    | ((value: {
        at: number;
        host: typeof host;
        processes: ResourceProcess[];
      }) => Promise<void>)
    | undefined;
  const service = new AgentResources(
    async () => [root],
    (callback) => {
      deliver = callback;
      return { stop() {} };
    },
  );
  const close = service.subscribe(() => {});
  close();
  await deliver!({ at: Date.now(), host, processes: [process(10, 1)] });
  expect(service.history.values()).toEqual([]);
});

test("a missing sampler degrades to unavailable without throwing", () => {
  const service = new AgentResources(
    async () => [],
    () => {
      throw new Error("missing");
    },
  );
  const events: unknown[] = [];
  service.subscribe((event) => events.push(event))();
  expect(events).toEqual([{ status: "unavailable" }]);
});

test("process time supports Linux and macOS formats", () => {
  expect(parseProcessTime("01:02.50")).toBe(62500);
  expect(parseProcessTime("1-02:03:04")).toBe(93784000);
});

test("persisted launch times reject a recycled root before its first observed sample", () => {
  const sample = new ResourceAttribution().sample(
    10000,
    host,
    [{ ...process(10, 1), bornAt: 9000 }],
    [{ ...root, startedAt: 1000 }],
  );
  expect(sample.runs).toEqual([]);
});

test("dedicated sampler returns local process-tree and host counters", async () => {
  const ready = Promise.withResolvers<AgentResourceSample>();
  const service = new AgentResources(async () => [
    { ...root, pid: globalThis.process.pid },
  ]);
  const timeout = setTimeout(
    () => ready.reject(new Error("sampler timeout")),
    10000,
  );
  const close = service.subscribe((event) => {
    if (event.status === "ready") ready.resolve(event.sample);
    else ready.reject(new Error("sampler unavailable"));
  });
  try {
    const sample = await ready.promise;
    expect(sample.host.totalMemory).toBeGreaterThan(0);
    expect(sample.runs[0].rss).toBeGreaterThan(0);
    expect(sample.runs[0].processes).toBeGreaterThanOrEqual(1);
  } finally {
    clearTimeout(timeout);
    close();
  }
});
