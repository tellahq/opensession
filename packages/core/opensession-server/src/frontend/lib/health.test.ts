import { afterEach, expect, test } from "bun:test";
import { fetchHealthStatus } from "./health";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("shares only concurrent health probes", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  const firstFetch = () => {
    calls++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  };
  globalThis.fetch = Object.assign(firstFetch, {
    preconnect: originalFetch.preconnect,
  });

  const first = fetchHealthStatus();
  const second = fetchHealthStatus();
  expect(calls).toBe(1);
  finish(Response.json({ bootId: "one" }));
  expect(await first).toEqual({ bootId: "one" });
  expect(await second).toEqual({ bootId: "one" });

  const secondFetch = () => {
    calls++;
    return Promise.resolve(Response.json({ bootId: "two" }));
  };
  globalThis.fetch = Object.assign(secondFetch, {
    preconnect: originalFetch.preconnect,
  });
  expect(await fetchHealthStatus()).toEqual({ bootId: "two" });
  expect(calls).toBe(2);
});
