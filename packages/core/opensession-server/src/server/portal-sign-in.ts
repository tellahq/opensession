/**
 * Sign-in hand-off for Portal ports.
 *
 * Caddy forward-authenticates every Portal request against
 * `/api/portal-auth/<port>` (src/server/preview.ts), and the global API gate
 * refuses that probe with a JSON 401 when the browser has no web session.
 * For a fetch that is the right answer. For a person tapping a Portal link
 * in a browser that never signed in (a phone's Safari opened from the native
 * app or the home-screen web app, which keep their own cookie jars) it is a
 * dead end: the Portal port serves nothing but the app it proxies, so there
 * is no sign-in screen to reach. Send that navigation to the app's own
 * origin, where UserGate signs the person in and returns them to the Portal
 * (src/frontend/lib/portal-return.ts). The session cookie is host-scoped,
 * so once it exists it covers every Portal port on the same host.
 *
 * Caddy copies a non-2xx forward-auth response back to the client, which is
 * what carries this redirect through.
 */

const PORTAL_AUTH_PATH = /^\/api\/portal-auth\/\d+$/;

/** True for the forward-auth probe Caddy sends for a Portal port. */
export function isPortalAuthPath(path: string): boolean {
  return PORTAL_AUTH_PATH.test(path);
}

/** A top-level browser navigation, as opposed to a fetch or an asset load. */
function browserNavigation(headers: Headers): boolean {
  const mode = headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  const dest = headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (headers.get("accept") || "").includes("text/html");
}

/**
 * The Portal URL the person was opening, or null when Caddy's forwarded
 * host is not the app's own host. Only same-host targets are handed back
 * after sign-in, so anything else keeps the plain 401.
 */
function portalTarget(headers: Headers, appHostname: string): string | null {
  const host = headers.get("x-forwarded-host") || headers.get("host");
  if (!host) return null;
  const uri = headers.get("x-forwarded-uri") || "/";
  let url: URL;
  try {
    url = new URL(uri.startsWith("/") ? uri : "/", `https://${host}`);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== appHostname.toLowerCase()) return null;
  return url.href;
}

/**
 * The redirect to the app's sign-in for an unauthenticated Portal
 * navigation, or null when this request should get the ordinary 401
 * (not a Portal probe, a non-GET, a fetch rather than a navigation, or a
 * host that is not this app's).
 */
export function portalSignInRedirect(
  req: Request,
  path: string,
  appBaseUrl: string,
): Response | null {
  if (!isPortalAuthPath(path)) return null;
  const method = (
    req.headers.get("x-forwarded-method") || req.method
  ).toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (!browserNavigation(req.headers)) return null;
  let signIn: URL;
  try {
    signIn = new URL(appBaseUrl);
  } catch {
    return null;
  }
  const target = portalTarget(req.headers, signIn.hostname);
  if (!target) return null;
  if (!signIn.pathname.endsWith("/")) signIn.pathname += "/";
  signIn.search = "";
  signIn.hash = "";
  signIn.searchParams.set("return", target);
  return new Response(null, {
    status: 302,
    headers: {
      Location: signIn.href,
      "Cache-Control": "no-store",
      Vary: "Cookie",
    },
  });
}
