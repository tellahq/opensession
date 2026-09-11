import type { RouteContext } from "./context";
import { findSessionAsync } from "../session-cache";
import { deskTextNavigation } from "../desk-text-navigation";
import {
  deskNavigationBindSchema,
  deskNavigationConnectSchema,
  deskNavigationConnectionSchema,
  deskNavigationRequestSchema,
} from "../../shared/desk-navigation";

export async function handleDeskNavigationRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (
    !ctx.path.startsWith("/api/desk/navigation/") ||
    ctx.req.method !== "POST"
  )
    return undefined;
  const reply = (body: object, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const identity = ctx.authUser;
  if (
    !identity?.login ||
    ("automation" in identity && identity.automation === true)
  )
    return reply({ error: "Sign in to navigate from Desk." }, 401);
  const body = await ctx.req.json().catch(() => null);
  const login = identity.login;
  switch (ctx.path) {
    case "/api/desk/navigation/connect": {
      const parsed = deskNavigationConnectSchema.safeParse(body);
      if (!parsed.success) return reply({ error: "Invalid Desk session" }, 400);
      const session = await findSessionAsync(parsed.data.sessionId);
      // A Desk is a shared team-readable session, but only this verified sender's
      // browser receives the capability. No capability for ordinary/automated work.
      if (
        !session?.desk ||
        session.automation ||
        session.automationDescendantPolicy
      )
        return reply({ error: "Not an interactive Desk session" }, 403);
      const connection = deskTextNavigation.connect(session.id, login);
      return connection
        ? reply(connection, 201)
        : reply({ error: "Too many navigation connections" }, 429);
    }
    case "/api/desk/navigation/bind": {
      const parsed = deskNavigationBindSchema.safeParse(body);
      if (!parsed.success)
        return reply({ error: "Invalid navigation binding" }, 400);
      const { connectionId, token, requestId } = parsed.data;
      const ok = deskTextNavigation.bind(login, connectionId, token, requestId);
      return reply({ ok }, ok ? 200 : 404);
    }
    case "/api/desk/navigation/poll": {
      const parsed = deskNavigationRequestSchema.safeParse(body);
      if (!parsed.success)
        return reply({ error: "Invalid navigation request" }, 400);
      const result = deskTextNavigation.handle(login, parsed.data);
      return result
        ? reply(result)
        : reply({ error: "No navigation connection" }, 404);
    }
    case "/api/desk/navigation/disconnect": {
      const parsed = deskNavigationConnectionSchema.strict().safeParse(body);
      if (!parsed.success)
        return reply({ error: "Invalid navigation connection" }, 400);
      const ok = deskTextNavigation.disconnect(
        login,
        parsed.data.connectionId,
        parsed.data.token,
      );
      return reply({ ok }, ok ? 200 : 404);
    }
    default:
      return undefined;
  }
}
