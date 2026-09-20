import { expect, test } from "bun:test";
import { handleMacKeychainRoutes } from "./mac-keychain";
import { macKeychainRequests } from "../mac-keychain-requests";
import type { RouteContext } from "./context";

function context(
  path: string,
  authUser: RouteContext["authUser"],
  body?: unknown,
): RouteContext {
  const url = new URL(path, "https://os.example.com");
  return {
    path: url.pathname,
    url,
    publicPrefix: "",
    authUser,
    req: new Request(
      url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  };
}
const alice = { login: "alice", name: "Alice" };

test("Mac approval requires a real verified identity, never machine auth or a name picker", async () => {
  for (const auth of [null, undefined, { ...alice, automation: true }]) {
    const result = await handleMacKeychainRoutes(
      context("/api/mac-keychain/pending?sessionId=x", auth),
    );
    expect(result!.status).toBe(401);
    expect(result!.headers.get("cache-control")).toBe("no-store");
  }
});

test("routes scope intent, claim once, and reject secret-bearing results", async () => {
  const session = crypto.randomUUID();
  const r = macKeychainRequests.request(session, "alice", {
    account: "demo@example.test",
    service: "Example API",
    purpose: "Test",
    url: "https://api.example.com/me",
    method: "GET",
    injection: "bearer",
  });
  const pending = `/api/mac-keychain/pending?sessionId=${session}`;
  expect(
    await (await handleMacKeychainRoutes(
      context(pending, { login: "bob", name: "Bob" }),
    ))!.json(),
  ).toEqual({ request: null });
  const own = await (await handleMacKeychainRoutes(
    context(pending, alice),
  ))!.json();
  expect(own.request.id).toBe(r.id);
  const claimRoute = `/api/mac-keychain/${r.id}/claim`;
  const crossSite = context(claimRoute, alice, {});
  crossSite.req.headers.set("origin", "https://evil.example.com");
  expect((await handleMacKeychainRoutes(crossSite))!.status).toBe(403);
  const claim = await (await handleMacKeychainRoutes(
    context(claimRoute, alice, {}),
  ))!.json();
  expect(
    (await handleMacKeychainRoutes(context(claimRoute, alice, {})))!.status,
  ).toBe(409);
  const complete = `/api/mac-keychain/${r.id}/complete`;
  expect(
    (await handleMacKeychainRoutes(
      context(complete, alice, {
        claim: claim.claim,
        outcome: { status: "failed", error: "SECRET" },
      }),
    ))!.status,
  ).toBe(400);
  expect(
    (await handleMacKeychainRoutes(
      context(complete, alice, {
        claim: claim.claim,
        outcome: { status: "completed", httpStatus: 204 },
      }),
    ))!.status,
  ).toBe(200);
  expect(macKeychainRequests.status(r.id, session, "alice")!.httpStatus).toBe(
    204,
  );
});
