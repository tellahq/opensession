import {
  EXPECTED_GITHUB_ACCOUNT_HEADER,
  PERSONAL_PRIVACY_HEADER,
} from "../../shared/access-scope";
import {
  PrivacyPrincipalChanged,
  validatePrivacyPrincipal,
} from "../application-access";
import type { RouteContext } from "./context";

/** Run before route effects, including shared mutations. An old tab must not
 * submit its captured person's work using another person's current cookie. */
export function privacyPrincipalAdmission(
  ctx: RouteContext,
): Response | undefined {
  // Authentication discovery must work even after the captured identity died.
  if (ctx.path === "/api/auth/status") return;
  const websocket = ctx.path === "/ws";
  const protocols = websocket ? ctx.url.searchParams.getAll("privacy") : [];
  const expectedIds = websocket
    ? ctx.url.searchParams.getAll("githubAccountId")
    : [];
  try {
    ctx.applicationAccess = validatePrivacyPrincipal(
      websocket
        ? protocols.length === 1
          ? protocols[0]
          : undefined
        : ctx.req.headers.get(PERSONAL_PRIVACY_HEADER),
      websocket
        ? expectedIds.length === 1
          ? expectedIds[0]
          : undefined
        : ctx.req.headers.get(EXPECTED_GITHUB_ACCOUNT_HEADER),
      ctx.authUser,
    );
  } catch (error) {
    if (!(error instanceof PrivacyPrincipalChanged)) throw error;
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
