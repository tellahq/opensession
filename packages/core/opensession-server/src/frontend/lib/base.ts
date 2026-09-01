/**
 * App base path. The app serves at the bare domain root — historical
 * prefixed page URLs (/opensession and the pre-rename /backstage) 301 there
 * in the server's fetch preamble — so every URL the client builds is
 * root-relative. Kept as a constant (not inlined away) so URL-building code
 * stays uniform (`${BASE_PATH}/api`) and a prefixed deployment would be a
 * one-line change.
 */
export const BASE_PATH = "";

/** Strip a historical prefix off a pathname → the app-internal route
 *  ("/" rooted). Old deep links may still arrive prefixed (e.g. a stored
 *  post-login redirect target) before the server 301 normalizes them. */
export function stripBasePath(pathname: string): string {
  for (const prefix of ["/opensession", "/backstage"]) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }
  return pathname;
}
