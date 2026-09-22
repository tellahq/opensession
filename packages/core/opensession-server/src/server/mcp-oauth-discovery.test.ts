import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { statePath } from "./paths";
import * as dns from "node:dns/promises";
import { discoverMcpOauth } from "./mcp-oauth-discovery";
import {
  cachedOauthCapable,
  isOauthCapable,
  startMcpOauthFlow,
} from "./mcp-oauth";
import { addMcpServerEntry, getConnections } from "./connections";

const resource = "https://mcp.example.test/mcp";
const issuer = "https://auth.example.test/auth/v1";
const inserted =
  "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
const root = "https://mcp.example.test/.well-known/oauth-protected-resource";
const asInserted =
  "https://auth.example.test/.well-known/oauth-authorization-server/auth/v1";
const pr = {
  resource,
  authorization_servers: [issuer],
  scopes_supported: ["openid"],
};
const as = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
};
const realFetch = globalThis.fetch;
let requests: Request[];
let options: RequestInit[];
let responses: Map<string, () => Response>;
let lookup: ReturnType<typeof spyOn<typeof dns, "lookup">>;

beforeEach(async () => {
  await mkdir(dirname(statePath(".opensession-mcp-oauth.json")), {
    recursive: true,
  });
  requests = [];
  options = [];
  responses = new Map([
    [resource, () => new Response(null, { status: 401 })],
    [inserted, () => Response.json(pr)],
    [asInserted, () => Response.json(as)],
  ]);
  lookup = spyOn(dns, "lookup").mockImplementation((async () => [
    { address: "203.0.113.1", family: 4 },
  ]) as unknown as typeof dns.lookup);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    options.push(init ?? {});
    return (
      responses.get(request.url)?.() ??
      new Response("not found", { status: 404 })
    );
  }) as typeof fetch;
});

afterEach(async () => {
  await rm(statePath(".opensession-mcp-oauth.json"), { force: true });
  globalThis.fetch = realFetch;
  lookup.mockRestore();
});

const urls = () => requests.map((r) => r.url);

describe("MCP OAuth resource discovery", () => {
  test("prefers a Bearer challenge over the inserted and root paths", async () => {
    const advertised = "https://mcp.example.test/oauth/resource";
    responses.set(
      resource,
      () =>
        new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Basic realm="acme, tools", Bearer realm="mcp", resource_metadata="${advertised}"`,
          },
        }),
    );
    responses.set(advertised, () => Response.json(pr));
    expect(await discoverMcpOauth(resource)).toEqual({
      resource,
      scopes: ["openid"],
      endpoints: {
        authorize: as.authorization_endpoint,
        token: as.token_endpoint,
        register: as.registration_endpoint,
      },
    });
    expect(urls()).toEqual([resource, advertised, asInserted]);
    for (const request of requests) {
      expect(request.redirect).toBe("error");
      expect(options[requests.indexOf(request)]?.credentials).toBe("omit");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.signal).toBeDefined();
    }
  });

  test("falls back to path insertion and then origin-root resource metadata", async () => {
    await discoverMcpOauth(resource);
    expect(urls()).toEqual([resource, inserted, asInserted]);
    requests = [];
    responses.delete(inserted);
    responses.set(root, () => Response.json(pr));
    await discoverMcpOauth(resource);
    expect(urls()).toEqual([resource, inserted, root, asInserted]);
  });

  test.each([
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
    "https://auth.example.test/.well-known/openid-configuration/auth/v1",
  ])("supports issuer metadata at %s", async (url) => {
    responses.delete(asInserted);
    responses.set(url, () => Response.json(as));
    expect((await discoverMcpOauth(resource)).endpoints.token).toBe(
      as.token_endpoint,
    );
    expect(urls().at(-1)).toBe(url);
    expect(new Set(urls()).size).toBe(requests.length);
    expect(requests.length).toBeLessThanOrEqual(7);
  });

  test.each(["/mcp/tools", "/mcp/", "/mcp?tenant=acme"])(
    "preserves the exact resource identity for %s",
    async (path) => {
      const url = `https://mcp.example.test${path}`;
      responses.set(
        `https://mcp.example.test/.well-known/oauth-protected-resource${new URL(url).pathname}`,
        () => Response.json({ ...pr, resource: url }),
      );
      expect((await discoverMcpOauth(url)).resource).toBe(url);
    },
  );

  test("keeps explicitly configured local HTTP origins usable without trusting other origins", async () => {
    const url = "http://localhost:8080/mcp";
    responses.set(
      "http://localhost:8080/.well-known/oauth-protected-resource/mcp",
      () =>
        Response.json({
          resource: url,
          authorization_servers: ["http://localhost:8080"],
        }),
    );
    responses.set(
      "http://localhost:8080/.well-known/oauth-authorization-server",
      () =>
        Response.json({
          issuer: "http://localhost:8080",
          authorization_endpoint: "http://localhost:8080/authorize",
          token_endpoint: "http://localhost:8080/token",
        }),
    );
    expect((await discoverMcpOauth(url)).endpoints.token).toBe(
      "http://localhost:8080/token",
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  test("retains legacy origin AS discovery without a resource document", async () => {
    responses.delete(inserted);
    responses.set(
      "https://mcp.example.test/.well-known/oauth-authorization-server",
      () =>
        Response.json({
          ...as,
          issuer: "https://mcp.example.test",
        }),
    );
    expect((await discoverMcpOauth(resource)).resource).toBeUndefined();
  });

  test("keeps PKCE, advertised scopes and DCR when connecting a path resource", async () => {
    responses.set(`${issuer}/register`, () =>
      Response.json({ client_id: "acme-public-client" }),
    );
    const { url } = await startMcpOauthFlow("path-resource", resource);
    const params = new URL(url).searchParams;
    expect(params.get("resource")).toBe(resource);
    expect(params.get("scope")).toBe("openid");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("state")).toBeTruthy();
    expect(params.get("client_id")).toBe("acme-public-client");
    expect(await requests.at(-1)!.json()).toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  });

  test("capability badges and status use the full resource, not its origin", async () => {
    const protectedUrl = "https://mcp.example.test/protected";
    const publicUrl = "https://mcp.example.test/public";
    responses.set(protectedUrl, () => new Response(null, { status: 401 }));
    responses.set(publicUrl, () => Response.json({}));
    responses.set(
      "https://mcp.example.test/.well-known/oauth-protected-resource/protected",
      () => Response.json({ ...pr, resource: protectedUrl }),
    );
    expect(
      await Promise.all([
        isOauthCapable(protectedUrl),
        isOauthCapable(protectedUrl),
      ]),
    ).toEqual([true, true]);
    expect(urls().filter((url) => url === protectedUrl)).toHaveLength(1);
    expect(await isOauthCapable(publicUrl)).toBe(false);
    expect(cachedOauthCapable(protectedUrl)).toBe(true);
    expect(cachedOauthCapable(publicUrl)).toBe(false);
    addMcpServerEntry("acme-protected", { type: "http", url: protectedUrl });
    addMcpServerEntry("acme-public", { type: "http", url: publicUrl });
    const connections = await getConnections(true);
    expect(connections.find((c) => c.name === "acme-protected")?.status).toBe(
      "needs-auth",
    );
    expect(connections.find((c) => c.name === "acme-public")?.status).toBe(
      "connected",
    );
  });

  test.each([
    "http://auth.example.test/metadata",
    "https://user:secret@auth.example.test/metadata",
    "https://auth.example.test/metadata#fragment",
    "file:///metadata",
    "https://127.0.0.1/metadata",
    "https://169.254.169.254/metadata",
    "https://service.internal/metadata",
    "/relative-metadata",
  ])("never fetches an unsafe advertised URL: %s", async (advertised) => {
    responses.set(
      resource,
      () =>
        new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${advertised}"`,
          },
        }),
    );
    await discoverMcpOauth(resource);
    expect(urls()).toEqual([resource, inserted, asInserted]);
  });

  test("ignores resource_metadata outside a Bearer challenge", async () => {
    responses.set(
      resource,
      () =>
        new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Basic resource_metadata="https://mcp.example.test/wrong"',
          },
        }),
    );
    await discoverMcpOauth(resource);
    expect(urls()).not.toContain("https://mcp.example.test/wrong");
  });

  test.each([
    { ...pr, resource: "https://mcp.example.test/other" },
    { ...pr, authorization_servers: "https://auth.example.test" },
    { ...pr, authorization_servers: ["https://127.0.0.1"] },
    { ...pr, scopes_supported: [42] },
    null,
    [],
  ])("rejects invalid or mismatched resource metadata %#", async (value) => {
    responses.set(inserted, () => Response.json(value));
    await expect(discoverMcpOauth(resource)).rejects.toThrow("No valid OAuth");
    expect(urls()).not.toContain(asInserted);
  });

  test.each([
    { ...as, issuer: "https://auth.example.test/wrong" },
    { ...as, issuer: undefined },
    { ...as, authorization_endpoint: "javascript:alert(1)" },
    { ...as, token_endpoint: "https://127.0.0.1/token" },
    { ...as, registration_endpoint: 42 },
  ])("rejects invalid issuer metadata and endpoints %#", async (value) => {
    responses.set(asInserted, () => Response.json(value));
    await expect(discoverMcpOauth(resource)).rejects.toThrow("No valid OAuth");
  });

  test("blocks cross-origin discovery when DNS resolves to private addresses", async () => {
    lookup.mockImplementation((async () => [
      { address: "10.0.0.1", family: 4 },
    ]) as unknown as typeof dns.lookup);
    await expect(discoverMcpOauth(resource)).rejects.toThrow("No valid OAuth");
    expect(
      urls().every((url) => url.startsWith("https://mcp.example.test/")),
    ).toBe(true);
  });

  test.each(["fetch", "DNS", "body"])(
    "one deadline bounds a stalled %s and stops further requests",
    async (stage) => {
      const controller = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
        controller.signal,
      );
      try {
        if (stage === "DNS") {
          lookup.mockImplementation((() => {
            queueMicrotask(() => controller.abort());
            return new Promise(() => {});
          }) as unknown as typeof dns.lookup);
        } else if (stage === "body") {
          responses.set(
            inserted,
            () =>
              new Response(
                new ReadableStream({
                  pull() {
                    queueMicrotask(() => controller.abort());
                  },
                }),
              ),
          );
        } else {
          globalThis.fetch = (() => {
            queueMicrotask(() => controller.abort());
            return new Promise(() => {});
          }) as unknown as typeof fetch;
        }
        await expect(discoverMcpOauth(resource)).rejects.toThrow();
        expect(timeout).toHaveBeenCalledTimes(1);
        expect(timeout).toHaveBeenCalledWith(10_000);
        expect(requests.length).toBeLessThanOrEqual(2);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  test.each([
    () => new Response("<html>not metadata</html>"),
    () => new Response("x".repeat(65 * 1024)),
    () => Response.json(pr, { status: 500 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://127.0.0.1/" },
      }),
  ])("bounds and rejects invalid HTTP metadata %#", async (response) => {
    responses.set(inserted, response);
    responses.set(root, () => Response.json(pr));
    await discoverMcpOauth(resource);
    expect(urls()).toEqual([resource, inserted, root, asInserted]);
  });
});
