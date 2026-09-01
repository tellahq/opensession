/**
 * Web sign-in routes (GitHub device flow → HttpOnly session cookie). These
 * are the ONLY /api/* routes exempt from the sign-in gate in
 * opensession.ts — they're how a signed-out browser gets in. Active only
 * when per-user GitHub auth is opted in (web-auth.ts / github-auth.ts);
 * otherwise /auth/status just reports `required: false` and the UI keeps
 * the local name picker.
 *
 * The device flow is the only way in, for every client. An
 * authorization-code redirect has to return to the exact origin it left, and
 * on the iOS PWA it comes back in Safari rather than the installed app; the
 * native clients can't take a browser redirect at all. One flow also means
 * one path to keep honest, rather than a fallback nobody exercises.
 */

import { organizationName } from "../config";
import { organizationIconRevision } from "../organization-settings";
import type { RouteContext } from "./context";
import {
  createWebSession,
  destroyWebSession,
  resolveWebAuth,
  teamMemberForLogin,
  webAuthClearCookie,
  webAuthRequired,
  webAuthSetCookie,
  webAuthToken,
} from "../web-auth";
import {
  githubDeviceFlowResult,
  githubReconnectRequired,
  pollGithubDeviceFlow,
  removeGithubAccount,
  startGithubDeviceFlow,
  watchGithubDeviceFlow,
} from "../github-auth";
import { workspaceAdminAuthorized } from "../workspace-auth";

export async function handleAuthRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (!path.startsWith("/api/auth/")) return undefined;

  if (path === "/api/auth/status" && req.method === "GET") {
    const identity = resolveWebAuth(req);
    // GitHub has permanently rejected this person's grant, so the sign-in
    // gate is already refusing their session (opensession.ts). Report them
    // as signed out, which is what every client's gate keys on, but say
    // which of the two it is, so the screen can ask for a reconnect and
    // name the account instead of offering a plain sign-in.
    const reconnect =
      !!identity &&
      !identity.automation &&
      githubReconnectRequired(identity.login);
    const signedIn = !!identity && !reconnect;
    // The mark rides along with the name: the gate card shows the
    // organization's own icon when one is configured. The image itself is a
    // static asset, already served pre-auth (page loads stay open so the
    // sign-in screen can render); only the revisioned URL needed a way out.
    const iconRevision = organizationIconRevision();
    return Response.json({
      required: webAuthRequired(),
      authenticated: signedIn,
      // The sign-in gate is the one screen a signed-out browser can see, so
      // it names the server it belongs to from here — every other source of
      // the organization name sits behind the gate this response unlocks.
      organizationName: organizationName(),
      organizationIconUrl:
        iconRevision === null
          ? null
          : `${ctx.publicPrefix}/organization-icon.png?v=${iconRevision}`,
      // When web auth isn't required (a single-user install), there is no
      // identity to sign in as, but that user administers the workspace —
      // workspaceAdminAuthorized() says as much. Report it so the admin-only
      // settings (Repositories, Connections, …) are reachable; falling
      // through to `false` here would hide them from the only user.
      admin: signedIn
        ? workspaceAdminAuthorized({ authUser: identity })
        : !webAuthRequired(),
      ...(reconnect ? { reconnectRequired: true } : {}),
      // The login rides along even for a reconnect: the card names the
      // account whose authorization lapsed, which is the whole difference
      // between "sign in" and "sign in again as you".
      ...(identity ? { login: identity.login, name: identity.name } : {}),
    });
  }

  if (path === "/api/auth/device" && req.method === "POST") {
    if (!webAuthRequired())
      return Response.json(
        { error: "Sign-in is not enabled" },
        { status: 400 },
      );
    const result = await startGithubDeviceFlow();
    if ("error" in result) return Response.json(result, { status: 400 });
    // The server polls GitHub to completion itself — mobile clients get
    // suspended/killed while the code is entered in Safari, so their own
    // poll loop can't be trusted to survive to the finish.
    watchGithubDeviceFlow(result);
    return Response.json(result);
  }

  // One poll of the device flow. On success this BOTH connects the person's
  // PR token (github-auth store) and signs the browser in (session cookie) —
  // one authorize covers both. Non-team logins are rejected and their token
  // discarded.
  if (path === "/api/auth/device/poll" && req.method === "POST") {
    if (!webAuthRequired())
      return Response.json(
        { error: "Sign-in is not enabled" },
        { status: 400 },
      );
    const body = await req.json().catch(() => null);
    const deviceCode =
      typeof body?.deviceCode === "string" ? body.deviceCode : "";
    if (!deviceCode)
      return Response.json({ error: "deviceCode required" }, { status: 400 });
    // Prefer the server-watched outcome (idempotent — a client whose
    // earlier response got lost to an app suspension just asks again).
    // Direct GitHub polling remains as fallback for flows started before
    // server-side watching existed (e.g. across a process restart).
    const watched = githubDeviceFlowResult(deviceCode);
    console.log(
      `[auth] device/poll …${deviceCode.slice(-6)} → ${watched?.status ?? "unwatched"} (ua: ${req.headers.get("user-agent") ?? "?"})`,
    );
    let result: Awaited<ReturnType<typeof pollGithubDeviceFlow>>;
    if (watched && watched.status === "pending") {
      return Response.json({ status: "pending" });
    } else if (watched && watched.status === "error") {
      return Response.json(watched);
    } else if (watched) {
      result = { status: "ok", login: watched.login, name: watched.name };
    } else {
      result = await pollGithubDeviceFlow(deviceCode);
    }
    if (result.status !== "ok") return Response.json(result);
    if (!teamMemberForLogin(result.login)) {
      removeGithubAccount(result.login);
      return Response.json({
        status: "error",
        error: `GitHub account @${result.login} is not a workspace member. Add it in Settings > Members before enabling sign-in.`,
      });
    }
    const session = createWebSession(result.login);
    if (!session)
      return Response.json(
        { status: "error", error: "Could not create a session" },
        { status: 500 },
      );
    // Native clients (iOS app) can't use the HttpOnly cookie — they ask for
    // the token in the body (`native: true`) and store it in the keychain,
    // sending it back as `Authorization: Bearer`.
    const native = body?.native === true;
    console.log(
      `[auth] device-flow session delivered to ${native ? "native" : "web"} client for @${result.login}`,
    );
    return Response.json(
      {
        status: "ok",
        login: result.login,
        name: session.name,
        admin: workspaceAdminAuthorized({
          authUser: { login: result.login, name: session.name },
        }),
        ...(native ? { token: session.token } : {}),
      },
      { headers: { "Set-Cookie": webAuthSetCookie(session.token) } },
    );
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const token = webAuthToken(req);
    if (token) destroyWebSession(token);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": webAuthClearCookie() } },
    );
  }

  return undefined;
}
