import { afterEach, expect, test } from "bun:test";
import { fetchHealthStatus } from "./health";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("shares only concurrent health probes", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as unknown as typeof fetch;

  const first = fetchHealthStatus();
  const second = fetchHealthStatus();
  expect(calls).toBe(1);
  finish(Response.json({ bootId: "one" }));
  expect(await first).toEqual({ bootId: "one" });
  expect(await second).toEqual({ bootId: "one" });

  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(Response.json({ bootId: "two" }));
  }) as unknown as typeof fetch;
  expect(await fetchHealthStatus()).toEqual({ bootId: "two" });
  expect(calls).toBe(2);
});
