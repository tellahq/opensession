import { afterEach, describe, expect, test } from "bun:test";
import {
  startMcpOauthFlow,
  supportsManualToken,
  validateManualMcpToken,
} from "./mcp-oauth";

describe("MCP OAuth client registration", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("explains Figma's catalog restriction instead of reporting invalid JSON", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.figma.com/mcp",
          authorization_servers: ["https://api.figma.com"],
          scopes_supported: ["mcp:connect"],
        });
      }
      if (
        url === "https://api.figma.com/.well-known/oauth-authorization-server"
      ) {
        return Response.json({
          authorization_endpoint: "https://www.figma.com/oauth/mcp",
          token_endpoint: "https://api.figma.com/v1/oauth/token",
          registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
        });
      }
      if (url === "https://api.figma.com/v1/oauth/mcp/register") {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      startMcpOauthFlow("Figma test", "https://mcp.figma.com/mcp"),
    ).rejects.toThrow(
      "Its remote MCP server accepts only clients listed in the Figma MCP Catalog",
    );
  });
});

describe("manual MCP token providers", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("recognizes Vero as a token-connected provider", () => {
    expect(supportsManualToken("vero")).toBe(true);
  });

  test("validates a Vero key against the MCP initialize endpoint", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      request = new Request(input, init);
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    }) as typeof fetch;

    await validateManualMcpToken("vero", "test-vero-key");

    expect(request?.url).toBe("https://api.getvero.com/mcp");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer test-vero-key");
    expect(await request?.json()).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
  });

  test("explains when Vero rejects a key", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 401 })) as unknown as typeof fetch;

    await expect(validateManualMcpToken("vero", "bad-key")).rejects.toThrow(
      "Vero rejected that key",
    );
  });
});
