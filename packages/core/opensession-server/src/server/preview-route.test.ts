import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * How a host Portal gets its Caddy listener. Every PUT or DELETE on the admin
 * API is a Caddy config reload that waits for the previous servers to drain,
 * so a route Caddy already holds (it outlived a gateway handoff, or the PUT
 * that created it was still queued when its response timed out) must be
 * adopted, not rewritten. A route pointing at another upstream is replaced.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "PREVIEW_HOST"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

interface FakeCaddy {
  servers: Map<string, unknown>;
  requests: string[];
  url: string;
  stop(): void;
}

function fakeCaddy(): FakeCaddy {
  const servers = new Map<string, unknown>();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const key = new URL(req.url).pathname.split("/").pop() ?? "";
      requests.push(`${req.method} ${key}`);
      if (req.method === "GET") {
        return servers.has(key)
          ? Response.json(servers.get(key))
          : new Response("unknown", { status: 404 });
      }
      if (req.method === "PUT") {
        if (servers.has(key))
          return new Response("key already exists", { status: 409 });
        servers.set(key, await req.json());
        return new Response("", { status: 200 });
      }
      if (req.method === "DELETE") {
        servers.delete(key);
        return new Response("", { status: 200 });
      }
      return new Response("nope", { status: 405 });
    },
  });
  return {
    servers,
    requests,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

let root: string;
let caddy: FakeCaddy;
let app: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;

/** A host service on a port whose HTTPS translation stays inside the Portal
 *  namespace (`hostServiceHttpsPort`); an ephemeral port would land above it. */
function listenLow(body: string): ReturnType<typeof Bun.serve> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 3000 + Math.floor(Math.random() * 10_000);
    try {
      return Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response(body),
      });
    } catch {
      // port taken; try another
    }
  }
  throw new Error("no free low port");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bks-preview-route-"));
  caddy = fakeCaddy();
  // The "service" a .ports.conf entry points at; it only has to listen.
  // Both services listen before the first status call: the listener snapshot
  // behind port detection is cached briefly between calls.
  app = listenLow("app");
  other = listenLow("other");
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {},
      server: { caddyAdmin: caddy.url, previewHost: "portals.test" },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.PREVIEW_HOST = "portals.test";
});

afterAll(() => {
  caddy.stop();
  app.stop(true);
  other.stop(true);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function worktreeWith(port: number): string {
  const dir = mkdtempSync(join(root, "wt-"));
  writeFileSync(join(dir, ".ports.conf"), `WEBAPP_PORT=${port}\n`);
  return dir;
}

// Host listener discovery uses Linux's ss command, not available on macOS.
describe.skipIf(process.platform !== "linux")("host Portal Caddy route", () => {
  test("a route Caddy already holds for this upstream is adopted without a write", async () => {
    const { getPreviewStatus, previewServerConfig, httpsPortFor } =
      await import("./preview");
    const port = app.port!;
    const httpsPort = httpsPortFor(port);
    caddy.servers.set(
      `preview_${httpsPort}`,
      // Caddy hands back what it stored, key order not guaranteed.
      JSON.parse(
        JSON.stringify(
          previewServerConfig(httpsPort, `127.0.0.1:${port}`, "portals.test"),
        ),
      ),
    );
    caddy.requests.length = 0;

    const status = await getPreviewStatus(worktreeWith(port));

    expect(status.services[0]?.previewUrl).toBe(
      `https://portals.test:${httpsPort}`,
    );
    expect(caddy.requests).toEqual([`GET preview_${httpsPort}`]);
  });

  test("a route for another upstream is replaced", async () => {
    const { getPreviewStatus, previewServerConfig, httpsPortFor } =
      await import("./preview");
    // A listening service whose route Caddy still has under a stale upstream
    // (the host port was reused by a different process).
    {
      const port = other.port!;
      const httpsPort = httpsPortFor(port);
      caddy.servers.set(
        `preview_${httpsPort}`,
        previewServerConfig(httpsPort, "127.0.0.1:1", "portals.test"),
      );
      caddy.requests.length = 0;

      const status = await getPreviewStatus(worktreeWith(port));

      expect(status.services[0]?.previewUrl).toBe(
        `https://portals.test:${httpsPort}`,
      );
      expect(caddy.requests).toEqual([
        `GET preview_${httpsPort}`,
        `PUT preview_${httpsPort}`,
        `DELETE preview_${httpsPort}`,
        `PUT preview_${httpsPort}`,
      ]);
      expect(caddy.servers.get(`preview_${httpsPort}`)).toEqual(
        previewServerConfig(httpsPort, `127.0.0.1:${port}`, "portals.test"),
      );
    }
  });
});
