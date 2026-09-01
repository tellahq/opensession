import { describe, expect, it } from "bun:test";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
} from "./bounded-body";

function post(body: BodyInit | null, headers?: HeadersInit): Request {
  return new Request("http://localhost/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("readRequestTextWithinLimit", () => {
  it("preserves the exact UTF-8 text within the byte limit", async () => {
    const body = '{"message":"hello 👋"}';
    expect(
      await readRequestTextWithinLimit(
        post(body),
        new TextEncoder().encode(body).byteLength,
      ),
    ).toBe(body);
  });

  it("rejects an oversized declared Content-Length before reading the stream", async () => {
    let readerRequested = false;
    // A structural Request lets this assert the fast path directly. A real
    // ReadableStream may schedule its own pull before any consumer reads it.
    const body = {
      getReader() {
        readerRequested = true;
        throw new Error("the declared-size fast path must not read the stream");
      },
    } as unknown as ReadableStream<Uint8Array>;
    const request = {
      headers: new Headers({ "content-length": "1001" }),
      body,
    } as Request;

    await expect(
      readRequestTextWithinLimit(request, 1000),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(readerRequested).toBe(false);
  });

  it("rejects and cancels a streamed body once it crosses the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("567"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readRequestTextWithinLimit(post(stream), 5),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(cancelled).toBe(true);
  });
});
