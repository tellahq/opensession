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
import type { RouteContext } from "./context";

const APPS_PATH = "/api/connections/github/apps";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function primaryAppSummary() {
  const { githubAppIdentity, githubAppInstallUrl } =
    await import("../github-auth");
  const {
    configuredGithubInstallationOwner,
    githubConfiguredCredential,
    loadGithubAppKeyState,
  } = await import("../github-app");
  await loadGithubAppKeyState();
  const { slug } = githubAppIdentity();
  return {
    configured: githubConfiguredCredential(),
    slug,
    owner: configuredGithubInstallationOwner() || null,
    installUrl: githubAppInstallUrl(),
  };
}

export async function handleGithubAppsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== APPS_PATH && !path.startsWith(`${APPS_PATH}/`)) return undefined;

  // App credentials are a person's decision, never an automation's.
  if (ctx.authUser?.automation)
    return json({ error: "Not available to automations" }, 403);
  const { webAuthRequired } = await import("../web-auth");
  const simpleMode = !webAuthRequired();
  const ownLogin = ctx.authUser?.login || null;
  if (!simpleMode && !ownLogin)
    return json({ error: "Sign in to manage GitHub accounts" }, 403);

  const registry = await import("../github-app-registry");

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
