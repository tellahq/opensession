import { describe, expect, test } from "bun:test";
import { gunzipSync } from "zlib";
import { conditionalJsonResponse } from "./http-json";

describe("conditionalJsonResponse", () => {
  test("compresses JSON and revalidates each representation", async () => {
    const value = {
      rows: Array.from({ length: 100 }, (_, id) => ({ id, name: `row-${id}` })),
    };
    const first = await conditionalJsonResponse(
      new Request("http://test/api/rows", {
        headers: { "Accept-Encoding": "gzip" },
      }),
      value,
    );
    expect(first.headers.get("Content-Encoding")).toBe("gzip");
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(
      JSON.parse(gunzipSync(Buffer.from(await first.arrayBuffer())).toString()),
    ).toEqual(value);

    const etag = first.headers.get("ETag")!;
    const unchanged = await conditionalJsonResponse(
      new Request("http://test/api/rows", {
        headers: { "Accept-Encoding": "gzip", "If-None-Match": etag },
      }),
      value,
    );
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  test("reuses a named snapshot only for the same version", async () => {
    const request = new Request("http://test/api/rows");
    const first = await conditionalJsonResponse(
      request,
      { value: 1 },
      {
        cache: { key: "test-versioned-snapshot", version: 1 },
      },
    );
    const cached = await conditionalJsonResponse(
      request,
      { value: 2 },
      {
        cache: { key: "test-versioned-snapshot", version: 1 },
      },
    );
    const changed = await conditionalJsonResponse(
      request,
      { value: 2 },
      {
        cache: { key: "test-versioned-snapshot", version: 2 },
      },
    );
    expect(await first.json()).toEqual({ value: 1 });
    expect(await cached.json()).toEqual({ value: 1 });
    expect(await changed.json()).toEqual({ value: 2 });
  });
});
