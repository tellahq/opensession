/**
 * Deploy routes: the public-ish surface for agent-published apps
 * (src/server/deploys.ts) and the management API behind Settings → Deploys.
 *
 *   /d/<name>/<path>   →  reverse proxy to 127.0.0.1:<the deploy's port>
 *   /api/deploys       →  list / stop / relaunch / rollback / delete
 *
 * The proxy sits INSIDE the sign-in gate on purpose: a published app is
 * whatever an agent wrote, so it gets exactly the audience Open Session itself
 * has (tailnet + team), never a wider one. `/d/` is a page-ish path rather than
 * `/api/`, so the gate's own carve-out for page loads does not apply to it —
 * see the explicit check in opensession.ts.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  deleteDeploy,
  deployLogs,
  getDeploy,
  launchDeploy,
  listDeploys,
  rollbackDeploy,
  stopDeploy,
} from "../deploys";

const PROXY_TIMEOUT_MS = 30_000;

/** Hop-by-hop headers a proxy must not forward verbatim. */
const STRIPPED = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
]);

export async function handleDeployRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  // ── /d/<name>/… reverse proxy ────────────────────────────────────────────
  const proxied = path.match(/^\/(?:opensession\/)?d\/([a-z0-9-]+)(\/.*)?$/);
  if (proxied) {
    const name = proxied[1]!;
    const rest = proxied[2] ?? "";
    const deploy = getDeploy(name);
    if (!deploy)
      return new Response(`No deploy named "${name}"`, { status: 404 });
    if (deploy.state !== "running") {
      return new Response(
        `"${name}" is ${deploy.state}${deploy.lastError ? `: ${deploy.lastError}` : ""}`,
        { status: 503 },
      );
    }
    // A bare /d/<name> must become /d/<name>/ before the app sees it, or its
    // relative asset links resolve one level too high.
    if (!rest) {
      return Response.redirect(`${url.origin}${path}/${url.search}`, 308);
    }

    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!STRIPPED.has(key.toLowerCase())) headers.set(key, value);
    });
    // Apps that build absolute links need to know where they really live.
    headers.set("X-Forwarded-Prefix", `/d/${name}`);
    headers.set("X-Forwarded-Host", url.host);
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));

    try {
      const upstream = await fetch(
        `http://127.0.0.1:${deploy.port}${rest}${url.search}`,
        {
          method: req.method,
          headers,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : await req.arrayBuffer(),
          redirect: "manual",
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        },
      );
      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(upstream.body, {
        status: upstream.status,
        headers: out,
      });
    } catch (e: any) {
      return new Response(
        `"${name}" did not respond (${e?.message || String(e)}). It may still be starting.`,
        { status: 502 },
      );
    }
  }

  // ── Management ───────────────────────────────────────────────────────────
  if (path === "/api/deploys" && req.method === "GET") {
    return Response.json({ deploys: listDeploys() });
  }

  const m = path.match(
    /^\/api\/deploys\/([^/]+)(?:\/(logs|stop|start|rollback))?$/,
  );
  if (!m) return undefined;
  const ref = decodeURIComponent(m[1]!);
  const action = m[2];
  const deploy = getDeploy(ref);
  if (!deploy)
    return Response.json({ error: "no such deploy" }, { status: 404 });

  if (action === "logs" && req.method === "GET") {
    return Response.json({ logs: await deployLogs(deploy.id) });
  }
  if (action === "stop" && req.method === "POST") {
    return Response.json({ deploy: await stopDeploy(deploy.id) });
  }
  if (action === "start" && req.method === "POST") {
    return Response.json({
      deploy: await launchDeploy(deploy.id, { force: true }),
    });
  }
  if (action === "rollback" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const version = Number(body?.version);
    if (!Number.isInteger(version)) {
      return Response.json(
        { error: "expected { version: number }" },
        { status: 400 },
      );
    }
    try {
      return Response.json({ deploy: rollbackDeploy(deploy.id, version) });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  }
  if (!action && req.method === "DELETE") {
    const by = requestUser(ctx);
    await deleteDeploy(deploy.id);
    return Response.json({ ok: true, by });
  }

  return undefined;
}
