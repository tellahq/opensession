/** Authorization for workspace-owned settings.
 *
 * Historically an Open Session instance had one role: every authenticated
 * teammate could change instance settings. Keep that as the compatibility
 * default. Once any identity.team entry explicitly carries `admin`, the
 * roster becomes role-aware and only `admin: true` members may mutate shared
 * configuration. In sign-in mode authority always comes from the verified
 * GitHub identity on RouteContext, never a request body or query parameter.
 */

import { configuredIdentity } from "./config";
import type { RouteContext } from "./routes/context";
import { webAuthRequired } from "./web-auth";

export function identityIsWorkspaceAdmin(
  identity: { login: string } | null | undefined,
  team: ReturnType<typeof configuredIdentity>["team"],
): boolean {
  if (!identity) return false;
  const explicitRoles = team.some((member) => member.admin !== undefined);
  if (!explicitRoles) return true;
  const login = identity.login.trim().toLowerCase();
  return team.some(
    (member) =>
      member.admin === true && member.github?.trim().toLowerCase() === login,
  );
}

export function workspaceAdminAuthorized(
  ctx: Pick<RouteContext, "authUser">,
): boolean {
  if (!webAuthRequired()) return true;
  return identityIsWorkspaceAdmin(ctx.authUser, configuredIdentity().team);
}

export function requireWorkspaceAdmin(
  ctx: Pick<RouteContext, "authUser">,
): Response | undefined {
  if (workspaceAdminAuthorized(ctx)) return undefined;
  return Response.json(
    { error: "Workspace administrator access is required" },
    { status: 403 },
  );
}
