import { expect, test } from "bun:test";
import { recordSessionPerf, sessionPerfSnapshot } from "./session-performance";

test("keeps an independent bounded history for each metric", () => {
  for (let index = 0; index < 250; index++)
    recordSessionPerf("busy_metric", index);
  for (let index = 0; index < 25; index++)
    recordSessionPerf("rare_metric", index);

  const snapshot = sessionPerfSnapshot();
  expect(snapshot.metrics.busy_metric?.count).toBe(200);
  expect(snapshot.metrics.busy_metric?.max).toBe(249);
  expect(snapshot.metrics.rare_metric?.count).toBe(25);
  expect(snapshot.metrics.rare_metric?.max).toBe(24);
  expect(snapshot.recent).toHaveLength(100);
});
