import { chmodSync } from "node:fs";

export interface RecordedRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  authorization: string | null;
}

type Handler = (request: RecordedRequest) => unknown | Response;

/** A loopback App Store Connect stand-in. Routes are `METHOD /path` keys;
 *  unmatched GETs return an empty list, other unmatched calls fail loudly. */
export function fakeAsc(routes: Record<string, Handler> = {}) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const recorded: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        search: url.searchParams,
        body: text ? JSON.parse(text) : undefined,
        authorization: req.headers.get("authorization"),
      };
      requests.push(recorded);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) {
        if (req.method === "GET") return Response.json({ data: [] });
        return Response.json(
          {
            errors: [
              { code: "NOT_FOUND", detail: `${req.method} ${url.pathname}` },
            ],
          },
          { status: 404 },
        );
      }
      const result = handler(recorded);
      if (result instanceof Response) return result;
      return result === undefined
        ? new Response(null, { status: 204 })
        : Response.json(result);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    writes: () => requests.filter((request) => request.method !== "GET"),
    stop: () => server.stop(true),
  };
}

/** A throwaway P-256 key in the PEM form App Store Connect issues. */
export async function writeTestKey(path: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).toString("base64");
  await Bun.write(
    path,
    `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`,
  );
  chmodSync(path, 0o600);
  return pair.publicKey;
}

export const app = (id = "app-1", bundleId = "com.example.App") => ({
  data: [{ type: "apps", id, attributes: { bundleId, name: "App" } }],
});
