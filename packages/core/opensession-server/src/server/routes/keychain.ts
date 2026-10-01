/**
 * Keychain routes: credential registration, the owner's answers to asks, and
 * inspection for humans (Settings → Account). All of them sit behind the
 * web sign-in gate, except the retired broker URL's explanation. There is no
 * HTTP broker: agents call a borrowed credential through the call_credential
 * tool (keychain-broker.ts), which binds the call to the calling run's
 * session, or through a scripted run's own proxy (keychain-runs.ts).
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  addCredentialAsync,
  answerKeychainAsk,
  deleteCredential,
  ensureKeychainLoaded,
  keychainViewFor,
  revokeGrant,
} from "../keychain";
import { readRequestTextWithinLimit } from "../shared/bounded-body";
import {
  CredentialRegistrationError,
  declineCredentialRegistration,
  pendingCredentialRegistration,
  submitCredentialRegistration,
} from "../credential-registrations";

/** The signed-in person making this request, or "" when the identity is only
 *  claimed (no web auth) or belongs to an automation. */
export function verifiedPerson(ctx: RouteContext): string {
  const identity = ctx.authUser as
    | { login?: string; automation?: boolean }
    | null
    | undefined;
  if (!identity?.login || identity.automation === true) return "";
  return requestUser(ctx);
}

/** The loopback broker URL grants used to be served at:
 *  /api/keychain/broker/<grant>/<path>. */
export function isRetiredKeychainBrokerPath(path: string): boolean {
  return (
    path === "/api/keychain/broker" || path.startsWith("/api/keychain/broker/")
  );
}

/** What a caller of the retired broker URL is told. Open to every caller, so
 *  a script that still uses one learns why instead of seeing a sign-in
 *  error. It never touches a grant. */
export function retiredKeychainBrokerResponse(): Response {
  return Response.json(
    {
      error:
        "The keychain broker URL was retired: a grant is no longer usable over HTTP. " +
        "For a single API call, use the call_credential tool. For bulk work by a script, " +
        "ask the owner for a scripted run (request_credential with `run`: the command and " +
        "its call cap), then start it with run_with_credential; the script gets " +
        "KEYCHAIN_PROXY_URL, which works only while it runs.",
      retired: true,
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleKeychainRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (isRetiredKeychainBrokerPath(path)) return retiredKeychainBrokerResponse();

  if (
    path === "/api/keychain/registrations" ||
    path.startsWith("/api/keychain/registrations/")
  ) {
    return handleRegistrationRoutes(ctx);
  }

  // ── Management ────────────────────────────────────────────────────────────
  if (path === "/api/keychain" && req.method === "GET") {
    await ensureKeychainLoaded();
    return Response.json(keychainViewFor(verifiedPerson(ctx)), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // The owner answers a teammate's request from Settings. A verified sign-in
  // is required: a claimed name (the no-auth picker) or an automation token
  // must never approve access to someone's credential.
  const askMatch = path.match(/^\/api\/keychain\/asks\/([^/]+)\/answer$/);
  if (askMatch && req.method === "POST") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to answer a keychain request" },
        { status: 401 },
      );
    const body = await req.json().catch(() => null);
    const decision = body?.decision;
    if (
      decision !== "once" &&
      decision !== "standing" &&
      decision !== "run" &&
      decision !== "decline"
    )
      return Response.json(
        {
          error:
            'expected { decision: "once" | "standing" | "run" | "decline" }',
        },
        { status: 400 },
      );
    await ensureKeychainLoaded();
    const result = answerKeychainAsk(
      decodeURIComponent(askMatch[1]!),
      decision,
      by,
    );
    return "error" in result
      ? Response.json(result, { status: 403 })
      : Response.json(result);
  }

  if (path === "/api/keychain/credentials" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.service !== "string" ||
      typeof body.secret !== "string"
    ) {
      return Response.json(
        { error: "expected { service, host, secret, ... }" },
        { status: 400 },
      );
    }
    const owner = requestUser(ctx, body.owner);
    if (!owner) {
      return Response.json(
        {
          error:
            "no signed-in identity — a credential must have an owner who can approve asks",
        },
        { status: 400 },
      );
    }
    try {
      return Response.json({
        credential: await addCredentialAsync({
          owner,
          service: body.service,
          host: String(body.host || ""),
          secret: body.secret,
          description:
            typeof body.description === "string" ? body.description : undefined,
          injection: body.injection,
          allowedMethods: Array.isArray(body.allowedMethods)
            ? body.allowedMethods
            : undefined,
          allowedPathPrefixes: Array.isArray(body.allowedPathPrefixes)
            ? body.allowedPathPrefixes
            : undefined,
          statusOnly: body.statusOnly === true,
        }),
      });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  }

  const credMatch = path.match(/^\/api\/keychain\/credentials\/([^/]+)$/);
  if (credMatch && req.method === "DELETE") {
    try {
      const ok = deleteCredential(
        decodeURIComponent(credMatch[1]!),
        requestUser(ctx),
      );
      return ok
        ? Response.json({ ok: true })
        : Response.json({ error: "no such credential" }, { status: 404 });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 403 });
    }
  }

  const grantMatch = path.match(/^\/api\/keychain\/grants\/([^/]+)$/);
  if (grantMatch && req.method === "DELETE") {
    const result = revokeGrant(
      decodeURIComponent(grantMatch[1]!),
      requestUser(ctx),
    );
    return "error" in result
      ? Response.json(result, { status: 403 })
      : Response.json({ ok: true });
  }

  return undefined;
}

/**
 * The driver's side of a register_credential request
 * (credential-registrations.ts):
 *
 *   GET  /api/keychain/registrations?sessionId=     -> { request | null, canAnswer }
 *   POST /api/keychain/registrations/:id            { sessionId, secret }
 *   POST /api/keychain/registrations/:id/decline    { sessionId }
 *
 * Answering needs a verified GitHub sign-in that matches the person who drove
 * the session when the agent asked; machine auth and the name picker cannot.
 * The request body carries the secret, so nothing here logs or echoes it.
 */
async function handleRegistrationRoutes(ctx: RouteContext): Promise<Response> {
  const { req, path } = ctx;
  const reply = (data: object, status = 200) =>
    Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  const identity = ctx.authUser as
    | { login?: string; automation?: boolean }
    | null
    | undefined;
  const login =
    identity?.login && identity.automation !== true ? identity.login : "";

  if (path === "/api/keychain/registrations" && req.method === "GET") {
    const open = pendingCredentialRegistration(
      ctx.url.searchParams.get("sessionId") || "",
    );
    return reply({
      request: open?.request ?? null,
      canAnswer: !!open && !!login && login.toLowerCase() === open.login,
    });
  }

  const match = path.match(
    /^\/api\/keychain\/registrations\/([a-f0-9-]{36})(\/decline)?$/,
  );
  if (!match || req.method !== "POST")
    return reply({ error: "Not found" }, 404);
  if (!login)
    return reply(
      { error: "Sign in with GitHub to add a credential to the keychain" },
      401,
    );
  // Cross-site POSTs are refused before routing (opensession.ts,
  // web-auth.ts crossSiteViolation), against the public Host header. Do not
  // compare Origin with ctx.url here: behind the proxy that is the internal
  // backend address, so every real same-site answer would be refused.
  let body: { sessionId?: unknown; secret?: unknown };
  try {
    body = JSON.parse(await readRequestTextWithinLimit(req, 16 * 1024));
  } catch {
    return reply({ error: "Invalid request" }, 400);
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  try {
    if (match[2]) {
      declineCredentialRegistration(sessionId, match[1]!, login);
      return reply({ ok: true });
    }
    const credential = await submitCredentialRegistration(
      sessionId,
      match[1]!,
      login,
      body.secret,
    );
    return reply({ ok: true, credential });
  } catch (error) {
    if (error instanceof CredentialRegistrationError)
      return reply({ error: error.message }, error.status);
    // Never log the error object: the request that raised it carried a secret.
    return reply({ error: "Couldn't save the credential" }, 500);
  }
}
