import { afterEach, expect, test } from "bun:test";
import { uploadFile } from "./images";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CHUNK = 4 * 1024 * 1024;
type Reply = {
  ok?: boolean;
  id?: string;
  chunkSize?: number;
  chunks?: number;
  name?: string;
  path?: string;
  error?: string;
  missing?: number[];
};
const json = (body: Reply, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A stand-in for routes/uploads.ts that records what arrives and can be
 *  told to fail a chunk once or to forget one before completion. */
function chunkServer(options: { failOnce?: number; forget?: number } = {}) {
  const received = new Map<number, number>();
  const calls: string[] = [];
  let failed = false;
  let forgot = false;
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/uploads" && method === "POST") {
      const { size } = JSON.parse(String(init?.body));
      return json({
        id: "u1",
        chunkSize: CHUNK,
        chunks: Math.ceil(size / CHUNK),
      });
    }
    const chunk = url.match(/\/chunks\/(\d+)$/);
    if (chunk) {
      const index = Number(chunk[1]);
      if (index === options.failOnce && !failed) {
        failed = true;
        return json({ error: "busy" }, 503);
      }
      const body = init?.body;
      received.set(index, body instanceof ArrayBuffer ? body.byteLength : -1);
      return json({ ok: true });
    }
    if (url.endsWith("/complete")) {
      if (options.forget !== undefined && !forgot) {
        forgot = true;
        received.delete(options.forget);
        return json({ error: "missing", missing: [options.forget] }, 409);
      }
      return json({ ok: true, name: "clip.mov", path: "/staged/clip.mov" });
    }
    return json({ ok: true });
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  return { received, calls };
}

const bigFile = () =>
  new File([new Uint8Array(CHUNK * 2 + 100)], "clip.mov", {
    type: "video/quicktime",
  });

test("sends a large file in chunks, retrying a failed one on its own", async () => {
  const server = chunkServer({ failOnce: 1 });
  const progress: number[] = [];
  const result = await uploadFile(bigFile(), undefined, (fraction) =>
    progress.push(fraction),
  );
  expect(result).toEqual({ name: "clip.mov", path: "/staged/clip.mov" });
  expect([...server.received.entries()].sort()).toEqual([
    [0, CHUNK],
    [1, CHUNK],
    [2, 100],
  ]);
  expect(server.calls.filter((c) => c.includes("/chunks/1"))).toHaveLength(2);
  expect(progress.at(-1)).toBe(1);
});

test("resends only the chunks the server reports missing", async () => {
  const server = chunkServer({ forget: 0 });
  await uploadFile(bigFile());
  expect(server.calls.filter((c) => c.includes("/chunks/0"))).toHaveLength(2);
  expect(server.calls.filter((c) => c.includes("/chunks/2"))).toHaveLength(1);
});

test("a small file still goes up in one request", async () => {
  const server = chunkServer();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      server.calls.push(String(input));
      return json({ ok: true, name: "a.txt", path: "/staged/a.txt" });
    },
    { preconnect: realFetch.preconnect },
  );
  await uploadFile(new File(["hi"], "a.txt"));
  expect(server.calls).toEqual(["/api/upload"]);
});
