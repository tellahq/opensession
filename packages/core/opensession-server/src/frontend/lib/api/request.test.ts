import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, request } from "./request";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("request", () => {
  test("shares concurrent GETs and releases them after they settle", async () => {
    const first = deferredResponse();
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return first.promise;
    }) as unknown as typeof fetch;

    const one = request<{ value: number }>("/same");
    const two = request<{ value: number }>("/same");
    expect(calls).toBe(1);

    first.resolve(Response.json({ value: 1 }));
    expect(await one).toEqual({ value: 1 });
    expect(await two).toEqual({ value: 1 });

    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(Response.json({ value: 2 }));
    }) as unknown as typeof fetch;
    expect(await request<{ value: number }>("/same")).toEqual({ value: 2 });
    expect(calls).toBe(2);
  });

  test("keeps abortable GETs and writes independent", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(Response.json({ ok: true }));
    }) as unknown as typeof fetch;

    await Promise.all([
      request("/abortable", { signal: new AbortController().signal }),
      request("/abortable", { signal: new AbortController().signal }),
      request("/write", { method: "PUT", body: { value: 1 } }),
      request("/write", { method: "PUT", body: { value: 1 } }),
    ]);
    expect(calls).toBe(4);
  });

  test("preserves API error messages and status codes", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json(
          {
            error: "Request rejected",
          },
          { status: 409 },
        ),
      )) as unknown as typeof fetch;

    try {
      await request("/rejected");
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toBe("Request rejected");
      expect((error as ApiError).status).toBe(409);
    }
  });
});
