/**
 * Settings API for the additional per-account GitHub Apps
 * (github-app-registry.ts): list them with their installations and the
 * caller's sign-in, sign in to one with the device flow, sign out, and remove
 * an App. Creating one goes through the manifest flow
 * (`POST /api/setup/github/manifest` with `additional: true`).
 *
 * Who may do what mirrors the primary App's routes in connections.ts: with
 * web sign-in on, people manage only their own sign-in; without it, the one
 * install user manages the sole account.
 */
import { randomUUID } from "node:crypto";
import type { RouteContext } from "./context";

const APPS_PATH = "/api/connections/github/apps";
const OAUTH_START_PATH = "/api/connections/github/oauth/start";
const OAUTH_CALLBACK_PATH = "/api/connections/github/oauth/callback";
const OAUTH_STATE_TTL_MS = 15 * 60_000;
const MAX_PENDING_OAUTH_STATES = 64;

interface PendingGithubOAuthState {
  readonly createdAt: number;
  readonly appId: string | null;
  readonly authLogin: string | null;
  readonly origin: string;
  readonly publicPrefix: string;
  readonly returnTo: "settings" | "welcome";
  readonly redirectUri: string;
  used: boolean;
}

const oauthGlobals = globalThis as {
  __opensessionGithubOAuthStates?: Map<string, PendingGithubOAuthState>;
};

function pendingOAuthStates(): Map<string, PendingGithubOAuthState> {
  return (oauthGlobals.__opensessionGithubOAuthStates ??= new Map());
}

export function __resetGithubOAuthStatesForTest(): void {
  pendingOAuthStates().clear();
}

function prunePendingOAuthStates(now = Date.now()): void {
  const states = pendingOAuthStates();
  for (const [key, entry] of states) {
    if (now - entry.createdAt > OAUTH_STATE_TTL_MS) states.delete(key);
  }
  while (states.size >= MAX_PENDING_OAUTH_STATES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    states.delete(oldest);
  }
}

function oauthRedirectTarget(
  pending: PendingGithubOAuthState,
  status: "ok" | "error",
  message?: string,
): Response {
  const destPath =
    pending.returnTo === "welcome"
      ? `${pending.publicPrefix}/welcome`
      : `${pending.publicPrefix}/settings/integrations`;
  const target = new URL(destPath, pending.origin);
  if (pending.returnTo === "welcome") target.searchParams.set("step", "github");
  target.searchParams.set("github_oauth", status);
  if (message)
    target.searchParams.set("github_oauth_error", message.slice(0, 160));
  return Response.redirect(target, 303);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function primaryAppSummary() {
  const { githubAppIdentity, githubAppInstallUrl, githubAppOAuthClient } =
    await import("../github-auth");
  const {
    configuredGithubInstallationOwner,
    githubConfiguredCredential,
    loadGithubAppKeyState,
  } = await import("../github-app");
  await loadGithubAppKeyState();
  const { slug } = githubAppIdentity();
  const { clientId, clientSecret } = githubAppOAuthClient(null);
  return {
    configured: githubConfiguredCredential(),
    slug,
    owner: configuredGithubInstallationOwner() || null,
    installUrl: githubAppInstallUrl(),
    oauthReady: Boolean(clientId && clientSecret),
  };
}

export async function handleGithubAppsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  const isOAuthRoute =
    path === OAUTH_START_PATH || path === OAUTH_CALLBACK_PATH;
  if (!isOAuthRoute && path !== APPS_PATH && !path.startsWith(`${APPS_PATH}/`))
    return undefined;

  // App credentials are a person's decision, never an automation's.
  if (ctx.authUser?.automation)
    return json({ error: "Not available to automations" }, 403);
  const { webAuthRequired } = await import("../web-auth");
  const simpleMode = !webAuthRequired();
  const ownLogin = ctx.authUser?.login || null;
  if (!simpleMode && !ownLogin)
    return json({ error: "Sign in to manage GitHub accounts" }, 403);

  const registry = await import("../github-app-registry");

  if (path === OAUTH_START_PATH && req.method === "GET") {
    const appIdParam = ctx.url.searchParams.get("appId")?.trim() || null;
    const returnTo =
      ctx.url.searchParams.get("returnTo") === "welcome"
        ? "welcome"
        : "settings";
    const auth = await import("../github-auth");
    let clientId: string | null = null;
    let clientSecret: string | null = null;
    if (appIdParam) {
      const entry = registry.additionalGithubAppById(appIdParam);
      if (!entry) return json({ error: "Unknown GitHub App" }, 404);
      clientId = entry.clientId;
      clientSecret = entry.clientSecret;
    } else {
      const primary = auth.githubAppOAuthClient(null);
      clientId = primary.clientId;
      clientSecret = primary.clientSecret;
    }
    if (!clientId || !clientSecret) {
      return json(
        { error: "GitHub App OAuth client secret is not configured" },
        400,
      );
    }
    prunePendingOAuthStates();
    const state = `${randomUUID()}${randomUUID()}`;
    const redirectUri = `${ctx.url.origin}${ctx.publicPrefix}${OAUTH_CALLBACK_PATH}`;
    pendingOAuthStates().set(state, {
      createdAt: Date.now(),
      appId: appIdParam,
      authLogin: ownLogin,
      origin: ctx.url.origin,
      publicPrefix: ctx.publicPrefix,
      returnTo,
      redirectUri,
      used: false,
    });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);
    return Response.redirect(authorize, 302);
  }

  if (path === OAUTH_CALLBACK_PATH && req.method === "GET") {
    prunePendingOAuthStates();
    const state = ctx.url.searchParams.get("state") || "";
    const code = ctx.url.searchParams.get("code") || "";
    const oauthError =
      ctx.url.searchParams.get("error_description") ||
      ctx.url.searchParams.get("error") ||
      "";
    const pending = pendingOAuthStates().get(state);
    if (!pending || pending.used || pending.authLogin !== ownLogin) {
      return json(
        {
          error:
            "This GitHub sign-in link is missing, expired, or already used",
        },
        400,
      );
    }
    pending.used = true;
    if (oauthError || !code) {
      return oauthRedirectTarget(
        pending,
        "error",
        oauthError || "GitHub did not return an authorization code",
      );
    }
    const auth = await import("../github-auth");
    const result = await auth.exchangeGithubOAuthCode(
      code,
      pending.redirectUri,
      ownLogin,
      pending.appId,
    );
    if (result.status === "ok") {
      return oauthRedirectTarget(pending, "ok");
    }
    return oauthRedirectTarget(
      pending,
      "error",
      result.status === "error"
        ? result.error
        : "GitHub sign-in did not complete",
    );
  }

  if (path === APPS_PATH && req.method === "GET") {
    const auth = await import("../github-auth");
    const app = await import("../github-app");
    const fresh = ctx.url.searchParams.get("refresh") === "1";
    const apps = await Promise.all(
      registry.additionalGithubApps().map(async (entry) => {
        const keyConfigured = await app.loadAdditionalGithubAppKeyState(entry);
        const installations = keyConfigured
          ? await app.listAdditionalGithubAppInstallations(entry, { fresh })
          : null;
        const accounts = auth.connectedGithubAppAccounts(entry.id);
        const mine = simpleMode
          ? accounts
          : accounts.filter(
              (a) => a.login.toLowerCase() === ownLogin!.toLowerCase(),
            );
        return {
          id: entry.id,
          owner: entry.owner,
          ownerType: entry.ownerType || null,
          slug: entry.slug,
          keyConfigured,
          webhookConfigured: !!entry.webhookSecret,
          oauthReady: Boolean(entry.clientId && entry.clientSecret),
          installUrl: `https://github.com/apps/${entry.slug}/installations/new`,
          settingsUrl:
            entry.ownerType === "Organization"
              ? `https://github.com/organizations/${encodeURIComponent(entry.owner)}/settings/apps/${entry.slug}`
              : `https://github.com/settings/apps/${entry.slug}`,
          installed: installations
            ? installations.some(
                (i) => i.login.toLowerCase() === entry.owner.toLowerCase(),
              )
            : null,
          accounts: mine,
        };
      }),
    );
    return json({ primary: await primaryAppSummary(), apps });
  }

  const match = path.slice(APPS_PATH.length + 1).split("/");
  const id = decodeURIComponent(match[0] || "");
  const entry = registry.additionalGithubAppById(id);
  if (!entry) return json({ error: "Unknown GitHub App" }, 404);
  const rest = match.slice(1).join("/");

  if (rest === "" && req.method === "DELETE") {
    const { rawConfig, persistRawConfig, withConfigMutationLock } =
      await import("../config-mutation");
    const { commitAdditionalGithubAppKeyMutation } =
      await import("../github-app");
    const { removeGithubAppStore } = await import("../github-auth");
    try {
      await withConfigMutationLock(async () => {
        const config = await rawConfig();
        const integrations = config.integrations as
          | Record<string, unknown>
          | undefined;
        const github = integrations?.github as
          | Record<string, unknown>
          | undefined;
        if (!github || !Array.isArray(github.apps)) return;
        github.apps = github.apps.filter(
          (raw) =>
            !raw ||
            typeof raw !== "object" ||
            (raw as Record<string, unknown>).id !== entry.id,
        );
        if (!(github.apps as unknown[]).length) delete github.apps;
        await commitAdditionalGithubAppKeyMutation(entry.id, null, () =>
          persistRawConfig(config),
        );
      });
      await removeGithubAppStore(entry.id);
    } catch (error) {
      return json({ error: String((error as Error)?.message || error) }, 409);
    }
    const { audit } = await import("../audit");
    audit({
      kind: "github_app_removed",
      app: entry.id,
      owner: entry.owner,
      by: ownLogin,
    });
    return json({ ok: true });
  }

  if (rest === "device" && req.method === "POST") {
    const { startGithubDeviceFlow } = await import("../github-auth");
    const result = await startGithubDeviceFlow(entry.id);
    if ("error" in result) return json(result, 400);
    return json(result);
  }

  if (rest === "device/poll" && req.method === "POST") {
    const { pollGithubDeviceFlow } = await import("../github-auth");
    const body = (await req.json().catch(() => null)) as {
      deviceCode?: unknown;
    } | null;
    const deviceCode =
      typeof body?.deviceCode === "string" ? body.deviceCode : "";
    if (!deviceCode) return json({ error: "deviceCode required" }, 400);
    // The token is stored under whichever login GitHub says authorized it;
    // with sign-in on, that must be the signed-in person.
    return json(await pollGithubDeviceFlow(deviceCode, ownLogin, entry.id));
  }

  const accountMatch = rest.match(/^account\/([^/]+)$/);
  if (accountMatch && req.method === "DELETE") {
    const login = decodeURIComponent(accountMatch[1]!);
    if (!simpleMode && login.toLowerCase() !== ownLogin!.toLowerCase())
      return json(
        { error: "You can only sign out your own GitHub account" },
        403,
      );
    const { removeGithubAppAccount } = await import("../github-auth");
    const removed = await removeGithubAppAccount(entry.id, login);
    return removed ? json({ ok: true }) : json({ error: "Not connected" }, 404);
  }

  return undefined;
}
