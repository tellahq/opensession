import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ResourceEvent, resourceSessions } from "./agent-resource-runtime";

test("resource payloads decode before entering UI state", async () => {
  const event = await Effect.runPromise(
    Schema.decodeUnknownEffect(ResourceEvent)({
      status: "ready",
      sample: {
        at: 10,
        host: { cpu: null, usedMemory: 1, totalMemory: 2 },
        runs: [
          {
            pid: 1,
            sessionId: "example",
            runId: "run-1",
            kind: "agent",
            cpu: 25,
            rss: 1024,
            processes: 2,
          },
          {
            pid: 2,
            sessionId: "example",
            runId: "run-2",
            kind: "portal",
            cpu: 50,
            rss: 2048,
            processes: 1,
          },
        ],
      },
    }),
  );
  expect(resourceSessions(event)).toEqual([
    { sessionId: "example", cpu: 75, rss: 3072, runs: 2, agent: true },
  ]);
  await expect(
    Effect.runPromise(
      Schema.decodeUnknownEffect(ResourceEvent)({
        status: "ready",
        sample: {},
      }),
    ),
  ).rejects.toThrow();
});
