import { z } from "zod";
import type { RouteContext } from "./context";
import { readRequestTextWithinLimit } from "../shared/bounded-body";
import {
  macKeychainOutcomeSchema,
  macKeychainRequests,
} from "../mac-keychain-requests";

const completion = z
  .object({
    claim: z.string().uuid(),
    outcome: macKeychainOutcomeSchema,
  })
  .strict();

export async function handleMacKeychainRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (!ctx.path.startsWith("/api/mac-keychain/")) return undefined;
  const reply = (data: object, status = 200) =>
    Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  const identity = ctx.authUser;
  if (
    !identity?.login ||
    ("automation" in identity && identity.automation === true)
  ) {
    return reply(
      { error: "Sign in as a teammate to review macOS Keychain requests" },
      401,
    );
  }
  // No claimed identity fallback, including instances with web sign-in disabled.
  // A name picker or an agent's machine browser cannot approve local access.
  if (ctx.path === "/api/mac-keychain/pending" && ctx.req.method === "GET") {
    return reply({
      request: macKeychainRequests.pending(
        ctx.url.searchParams.get("sessionId") || "",
        identity.login,
      ),
    });
  }
  if (
    ctx.req.method === "POST" &&
    ((ctx.req.headers.get("origin") &&
      ctx.req.headers.get("origin") !== ctx.url.origin) ||
      ctx.req.headers.get("sec-fetch-site") === "cross-site")
  ) {
    return reply({ error: "Cross-origin approval is not allowed" }, 403);
  }
  const match = ctx.path.match(
    /^\/api\/mac-keychain\/([a-f0-9-]{36})\/(claim|complete)$/,
  );
  if (!match || ctx.req.method !== "POST")
    return reply({ error: "Not found" }, 404);
  if (match[2] === "claim") {
    const claim = macKeychainRequests.claim(match[1]!, identity.login);
    return claim ? reply(claim) : reply({ error: "Request unavailable" }, 409);
  }
  // The fixed schema deliberately rejects text, headers, bodies, stderr, etc.
  const input = await readRequestTextWithinLimit(ctx.req, 1024)
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const body = completion.safeParse(input);
  if (!body.success) return reply({ error: "Invalid result" }, 400);
  const ok = macKeychainRequests.finish(
    match[1]!,
    identity.login,
    body.data.claim,
    body.data.outcome,
  );
  return reply({ ok }, ok ? 200 : 409);
}
