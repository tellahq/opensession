/**
 * Return to a Portal after sign-in.
 *
 * A browser that opens a Portal URL without a web session is redirected by
 * the server to the app with `?return=<portal url>` (src/server/
 * portal-sign-in.ts). Once UserGate sees a signed-in status it sends the
 * browser back there. Only an http(s) URL on this app's host but a different
 * origin qualifies: the session cookie is host-scoped, so a Portal port on
 * the same host is exactly what the sign-in unlocked, and a same-origin
 * target could only send the app back to itself.
 */

/** The `return` target in `search`, when it is a Portal on `location`'s host. */
export function portalReturnUrl(
  search: string,
  location: { hostname: string; origin: string },
): string | null {
  const raw = new URLSearchParams(search).get("return");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== location.hostname.toLowerCase())
    return null;
  if (url.origin === location.origin) return null;
  return url.href;
}

// The route store rewrites the landing URL during boot, so keep the query
// this page loaded with rather than reading it when sign-in completes.
const landingSearch = typeof location === "undefined" ? "" : location.search;
let returned = false;

/**
 * Leave for the Portal that sent the browser here, once. Returns true when
 * a navigation was started, so the caller can skip further work.
 */
export function returnToPortalAfterSignIn(): boolean {
  if (returned || typeof location === "undefined") return false;
  const target = portalReturnUrl(landingSearch, location);
  if (!target) return false;
  returned = true;
  location.replace(target);
  return true;
}
