/**
 * Whether a request using the historical /opensession or /backstage prefix
 * should move to the canonical root URL.
 *
 * A service worker update fetch rejects redirects. Legacy iPhone installs
 * still request <prefix>/sw.js, so that one asset must be served in place long
 * enough for the current worker to activate and migrate its cached shell.
 */
export function shouldRedirectLegacyPublicPath(
  method: string,
  upgrade: string | null,
  normalizedPath: string,
): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    !upgrade &&
    !normalizedPath.startsWith("/api/") &&
    normalizedPath !== "/sw.js"
  );
}
