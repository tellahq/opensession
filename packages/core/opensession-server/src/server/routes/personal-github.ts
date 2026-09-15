import { personalAdmission, personalPrincipal } from "../personal-access";
import { webAuthRequired } from "../web-auth";
import type { RouteContext } from "./context";

/** Reserve the personal API separately from administrator-owned instance App
 * setup. No manifest conversion, GitHub request, credential write, or repository
 * import may happen through this namespace until admission is implemented. */
export async function handlePersonalGithubRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (
    path !== "/api/personal/github" &&
    !path.startsWith("/api/personal/github/") &&
    path !== "/api/personal/repos" &&
    !path.startsWith("/api/personal/repos/")
  ) {
    return undefined;
  }
  const headers = {
    "Cache-Control": "no-store",
    Vary: "Cookie, Authorization",
  };
  if (!webAuthRequired() || !personalPrincipal(ctx.authUser)) {
    return Response.json(
      {
        code: "verified_signin_required",
        error:
          "Sign in again with GitHub to establish a verified account identity.",
      },
      { status: 401, headers },
    );
  }
  const admission = personalAdmission();
  if (path === "/api/personal/github/status" && req.method === "GET") {
    return Response.json(admission, { headers });
  }
  // Reads of exact ids disclose neither existence nor ownership. This also
  // denies stale callback URLs without exchanging their code or storing keys.
  if (req.method === "GET" || req.method === "HEAD") {
    return Response.json({ error: "Not found" }, { status: 404, headers });
  }
  return Response.json(admission, { status: 503, headers });
}
