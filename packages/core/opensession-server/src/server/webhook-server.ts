/**
 * Public webhook route registry.
 *
 * Webhooks no longer bind their own socket. The isolated public-ingress
 * listener owns the only internet-facing local endpoint and dispatches exact
 * registered methods and paths here after handling its sandbox/OIDC routes.
 * Keeping registration separate from Bun.serve makes the application route
 * table the fail-closed allowlist for Caddy and Cloudflare Tunnel.
 */
import type { AgentModule } from "../agents/types";

export type PublicWebhookHandler = (
  req: Request,
  url: URL,
) => Promise<Response>;

/** Combined route table: "POST /slack/events" → handler. */
let routeTable = new Map<string, PublicWebhookHandler>();

/**
 * Register a route after boot for an integration configured live from the UI.
 * Existing keys win because boot-time registration is authoritative.
 */
export function addWebhookRoute(
  key: string,
  handler: PublicWebhookHandler,
): void {
  if (!routeTable.has(key)) routeTable.set(key, handler);
}

/** Build the complete public webhook allowlist before ingress starts. */
export function configureWebhookRoutes(
  agents: AgentModule[],
  extraRoutes?: Map<string, PublicWebhookHandler>,
): void {
  routeTable = new Map();
  for (const agent of agents) {
    for (const [key, handler] of agent.getRoutes()) {
      if (routeTable.has(key)) {
        console.warn(
          `[webhook] Route collision: ${key} (agent: ${agent.name})`,
        );
      }
      routeTable.set(key, handler);
    }
  }
  for (const [key, handler] of extraRoutes || []) {
    if (routeTable.has(key))
      console.warn(`[webhook] Route collision: ${key} (extra)`);
    routeTable.set(key, handler);
  }
  console.log(
    `[public-ingress] registered ${routeTable.size} webhook routes ` +
      `(agents: ${agents.map((agent) => agent.name).join(", ") || "none"})`,
  );
}

/**
 * Dispatch one request through the exact public webhook registry. Undefined
 * means the ingress listener must answer with its bodyless 404.
 */
export async function handleWebhookRequest(
  req: Request,
): Promise<Response | undefined> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return undefined;
  }
  const routeKey = `${req.method} ${url.pathname}`;
  const exact = routeTable.get(routeKey);
  if (exact) return invoke(exact, req, url, routeKey);

  for (const [key, handler] of routeTable) {
    if (!key.endsWith("/*")) continue;
    const space = key.indexOf(" ");
    const method = key.slice(0, space);
    const prefix = key.slice(space + 1, -1);
    if (req.method === method && url.pathname.startsWith(prefix)) {
      return invoke(handler, req, url, key);
    }
  }
  return undefined;
}

async function invoke(
  handler: PublicWebhookHandler,
  req: Request,
  url: URL,
  key: string,
): Promise<Response> {
  try {
    return await handler(req, url);
  } catch (error) {
    console.error(`[webhook] Error handling ${key}:`, error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Test/status surface. It intentionally returns keys only inside the process. */
export function registeredWebhookRouteCount(): number {
  return routeTable.size;
}
