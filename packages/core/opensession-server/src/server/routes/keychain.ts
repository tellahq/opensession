/**
 * Keychain routes: credential registration/inspection for humans (Settings →
 * Keychain), and the credential broker the agent calls with a grant token.
 *
 * The management endpoints are ordinary API routes behind the web-auth gate.
 * The broker is the interesting one:
 *
 *   ANY /api/keychain/broker/:grantId/*  →  https://<credential host>/*
 *
 * It validates the grant (active, not expired, method+path within the
 * credential's limits), consumes it if it is a once grant, injects the
 * credential's header server-side and proxies. The agent supplies only the
 * grant id, so the secret never enters a model's context, a transcript, or a
 * sandbox env.
 *
 * The broker is exempt from the sign-in gate: its caller is an agent
 * subprocess on loopback with no browser session, and the grant id IS the
 * credential — unguessable, single-session-scoped, expiring and revocable.
 * That is the same reasoning the node register/heartbeat routes use.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  addCredential,
  brokerHeaders,
  consumeGrantForBroker,
  deleteCredential,
  listCredentials,
  listGrants,
  listKeychainAsks,
  revokeGrant,
  scrubSecret,
} from "../keychain";
import { audit } from "../audit";

/** Hop-by-hop and identity headers we never forward upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "authorization",
  "cookie",
  "content-length",
  "accept-encoding",
]);

const BROKER_TIMEOUT_MS = 30_000;
/** Bound what we buffer to scrub. Larger bodies stream through unscrubbed —
 *  a credential echoed past 2MB of JSON is not a realistic shape. */
const MAX_SCRUB_BYTES = 2 * 1024 * 1024;

export async function handleKeychainRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  // ── Broker ────────────────────────────────────────────────────────────────
  if (path.startsWith("/api/keychain/broker/")) {
    const rest = path.slice("/api/keychain/broker/".length);
    const slash = rest.indexOf("/");
    const grantId = slash === -1 ? rest : rest.slice(0, slash);
    const upstreamPath = slash === -1 ? "/" : rest.slice(slash);
    if (!grantId)
      return Response.json({ error: "missing grant id" }, { status: 400 });

    const use = consumeGrantForBroker(grantId, req.method, upstreamPath);
    if ("error" in use) {
      audit({
        kind: "keychain_broker_denied",
        grant_id: grantId,
        method: req.method,
        path: upstreamPath,
        reason: use.error,
      });
      return Response.json({ error: use.error }, { status: use.status });
    }

    const target = new URL(
      `https://${use.credential.host}${upstreamPath}${url.search}`,
    );
    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase()))
        headers.set(key, value);
    });
    for (const [k, v] of Object.entries(brokerHeaders(use.credential)))
      headers.set(k, v);

    audit({
      kind: "keychain_broker_call",
      grant_id: use.grant.id,
      credential_id: use.credential.id,
      session_id: use.grant.sessionId,
      owner: use.grant.owner,
      service: use.credential.service,
      method: req.method,
      host: use.credential.host,
      path: upstreamPath,
      mode: use.grant.mode,
    });

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : await req.arrayBuffer(),
        signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
        // A redirect's Location can point at any host; following it would send
        // the credential somewhere the owner never approved. Surface the 3xx
        // to the caller instead.
        redirect: "manual",
      });
    } catch (e: any) {
      return Response.json(
        {
          error: `broker request to ${use.credential.host} failed: ${e?.message || String(e)}`,
        },
        { status: 502 },
      );
    }

    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    const contentType = upstream.headers.get("content-type") || "";
    const scrubbable =
      /text\/|json|xml|x-www-form-urlencoded/i.test(contentType) &&
      Number(upstream.headers.get("content-length") || 0) <= MAX_SCRUB_BYTES;
    if (!scrubbable) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: outHeaders,
      });
    }
    const body = await upstream.text();
    return new Response(scrubSecret(body, use.credential.secret), {
      status: upstream.status,
      headers: outHeaders,
    });
  }

  // ── Management ────────────────────────────────────────────────────────────
  if (path === "/api/keychain" && req.method === "GET") {
    return Response.json({
      credentials: listCredentials(),
      grants: listGrants(),
      asks: listKeychainAsks(),
    });
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
        credential: addCredential({
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
