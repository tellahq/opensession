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

function installFetch(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
}

describe("request", () => {
  test("shares concurrent GETs and releases them after they settle", async () => {
    const first = deferredResponse();
    let calls = 0;
    installFetch(() => {
      calls++;
      return first.promise;
    });

    const one = request<{ value: number }>("/same");
    const two = request<{ value: number }>("/same");
    expect(calls).toBe(1);

    first.resolve(Response.json({ value: 1 }));
    expect(await one).toEqual({ value: 1 });
    expect(await two).toEqual({ value: 1 });

    installFetch(() => {
      calls++;
      return Promise.resolve(Response.json({ value: 2 }));
    });
    expect(await request<{ value: number }>("/same")).toEqual({ value: 2 });
    expect(calls).toBe(2);
  });

  test("keeps abortable GETs and writes independent", async () => {
    let calls = 0;
    installFetch(() => {
      calls++;
      return Promise.resolve(Response.json({ ok: true }));
    });

    await Promise.all([
      request("/abortable", { signal: new AbortController().signal }),
      request("/abortable", { signal: new AbortController().signal }),
      request("/write", { method: "PUT", body: { value: 1 } }),
      request("/write", { method: "PUT", body: { value: 1 } }),
    ]);
    expect(calls).toBe(4);
  });

  test("preserves API error messages and status codes", async () => {
    installFetch(() =>
      Promise.resolve(
        Response.json(
          {
            error: "Request rejected",
          },
          { status: 409 },
        ),
      ),
    );

    try {
      await request("/rejected");
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw error;
      expect(error.message).toBe("Request rejected");
      expect(error.status).toBe(409);
    }
  });
});
