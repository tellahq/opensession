/**
 * Shared request context for the HTTP route handlers under src/server/routes/.
 * Built once per request in opensession.ts's fetch and passed down the
 * ordered handler chain.
 */

export interface RouteContext {
  req: Request;
  url: URL;
  /** Pathname normalized onto the historical /backstage prefix (the
   *  /opensession alias is folded in before dispatch — rename-compat). */
  path: string;
  /** The prefix THIS request used ("/opensession" | "/backstage") —
   *  responses that embed it (manifest, sw.js scope, redirects) answer in
   *  kind so each install/bookmark stays self-consistent. */
  publicPrefix: string;
  /** Verified sign-in identity (web-auth.ts) when GitHub web sign-in is
   *  active; null when signed out or when the feature is off. When set,
   *  handlers should prefer it over any client-supplied `user` field. */
  authUser?: { login: string; name: string } | null;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response | undefined>;

/**
 * The request's attributed user: the verified sign-in identity when GitHub
 * web sign-in is active (first name — matching the historical picker values
 * routes have always stored), otherwise the client-claimed value. Routes must
 * use this instead of reading `body.user` directly, so a signed-in teammate
 * can't act under another name over HTTP either (the WS layer already
 * enforces this at the socket).
 */
export function requestUser(ctx: RouteContext, claimed?: unknown): string {
  if (ctx.authUser?.name) return ctx.authUser.name.split(" ")[0];
  return typeof claimed === "string" ? claimed.trim() : "";
}
