import { afterEach, describe, expect, test } from "bun:test";
import { handleAuthorize, handleCallback } from "./oauth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stateFromAuthorize(response: Response): string {
  const location = response.headers.get("Location");
  expect(location).not.toBeNull();
  return new URL(location!).searchParams.get("state")!;
}

describe("Linear OAuth state binding", () => {
  test("sets a secure, short-lived state cookie and forwards that state to Linear", () => {
    const response = handleAuthorize();
    const state = stateFromAuthorize(response);

    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(response.headers.get("Set-Cookie")).toBe(
      `__Host-linear-oauth-state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
  });

  test("rejects callbacks without the browser-bound state before exchanging a code", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return Response.json({});
    }) as unknown as typeof fetch;

    const response = await handleCallback(
      new Request("https://example.test/oauth/callback"),
      new URL(
        "https://example.test/oauth/callback?code=attacker-code&state=wrong",
      ),
      {},
    );

    expect(response.status).toBe(400);
    expect(fetches).toBe(0);
    expect(response.headers.get("Set-Cookie")).toBe(
      "__Host-linear-oauth-state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
  });

  test("consumes a matching state before reporting an OAuth exchange failure", async () => {
    const authorize = handleAuthorize();
    const state = stateFromAuthorize(authorize);
    const cookie = authorize.headers.get("Set-Cookie")!.split(";", 1)[0];
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as unknown as typeof fetch;

    const response = await handleCallback(
      new Request("https://example.test/oauth/callback", {
        headers: { Cookie: cookie },
      }),
      new URL(
        `https://example.test/oauth/callback?code=expired-code&state=${state}`,
      ),
      {},
    );

    expect(response.status).toBe(400);
    expect(fetches).toBe(1);
    expect(response.headers.get("Set-Cookie")).toBe(
      "__Host-linear-oauth-state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
  });
});
