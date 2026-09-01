import {
  configureCloudflareTunnel,
  installManagedCaddy,
  publicIngressStatus,
  savePrivateAppOrigin,
  savePublicIngress,
  setupPrivateAppDomain,
  verifyPrivateAppDomain,
} from "../ingress-settings";
import { audit } from "../audit";
import { readEnvFileValues } from "../env-file-edit";
import { githubAppConfigured, updateGithubAppWebhook } from "../github-app";
import {
  requireWorkspaceAdmin,
  workspaceAdminAuthorized,
} from "../workspace-auth";
import type { IngressExposure } from "../config";
import { refreshIndexHtml } from "../frontend-build";
import type { RouteContext } from "./context";

function errorResponse(error: unknown): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 400 },
  );
}

type GithubWebhookSync = { updated: true } | { updated: false; error: string };

async function syncGithubWebhook(
  publicBaseUrl: string,
): Promise<GithubWebhookSync | undefined> {
  if (!githubAppConfigured()) return undefined;
  const secret =
    readEnvFileValues().GITHUB_WEBHOOK_SECRET ||
    process.env.GITHUB_WEBHOOK_SECRET ||
    "";
  if (!secret) {
    return { updated: false, error: "The GitHub App has no webhook secret" };
  }
  try {
    await updateGithubAppWebhook(publicBaseUrl, secret);
    audit({ kind: "ingress_github_webhook_update", publicBaseUrl });
    return { updated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[public-ingress] GitHub webhook update failed: ${message.slice(0, 200)}`,
    );
    return { updated: false, error: message };
  }
}

async function changedIngressResponse(): Promise<Record<string, unknown>> {
  const settings = await publicIngressStatus(true);
  const githubWebhook = settings.publicBaseUrl
    ? await syncGithubWebhook(settings.publicBaseUrl)
    : undefined;
  return { ...settings, ...(githubWebhook ? { githubWebhook } : {}) };
}

export async function handleIngressRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path === "/api/ingress" && req.method === "GET") {
    return Response.json(
      await publicIngressStatus(workspaceAdminAuthorized(ctx)),
    );
  }
  if (path === "/api/ingress/app/setup" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    try {
      const provider =
        body?.provider === "cloudflare" || body?.provider === "vercel"
          ? body.provider
          : null;
      if (!provider) throw new Error("Choose Cloudflare DNS or Vercel DNS");
      const appBaseUrl = await setupPrivateAppDomain({
        domain: String(body?.domain || ""),
        provider,
        email: typeof body?.email === "string" ? body.email : undefined,
        apiToken:
          typeof body?.apiToken === "string" ? body.apiToken : undefined,
        teamId: typeof body?.teamId === "string" ? body.teamId : undefined,
      });
      audit({
        kind: "ingress_private_app_managed",
        publicBaseUrl: appBaseUrl,
        dnsProvider: provider,
      });
      refreshIndexHtml("private app domain changed");
      return Response.json({
        ...(await publicIngressStatus(true, { appBaseUrl })),
        restartRequired: true,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/app/test" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    try {
      return Response.json(await verifyPrivateAppDomain());
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/app" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    try {
      const appBaseUrl = await savePrivateAppOrigin(String(body?.domain || ""));
      audit({ kind: "ingress_private_app_update", publicBaseUrl: appBaseUrl });
      refreshIndexHtml("private app domain changed");
      return Response.json({
        ...(await publicIngressStatus(true, { appBaseUrl })),
        restartRequired: true,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress" && req.method === "PUT") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return errorResponse("Expected a JSON body");
    try {
      await savePublicIngress({
        publicBaseUrl: String(body.publicBaseUrl || ""),
        exposure: String(body.exposure || "") as IngressExposure,
        cloudflareTunnelId:
          typeof body.cloudflareTunnelId === "string"
            ? body.cloudflareTunnelId
            : undefined,
      });
      refreshIndexHtml("public ingress changed");
      return Response.json(await changedIngressResponse());
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/cloudflare" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    try {
      await configureCloudflareTunnel({
        publicBaseUrl: String(body?.publicBaseUrl || ""),
        tunnelId: String(body?.tunnelId || ""),
        token: typeof body?.token === "string" ? body.token : undefined,
      });
      refreshIndexHtml("public ingress changed");
      return Response.json(await changedIngressResponse());
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/custom" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    try {
      await installManagedCaddy(
        String(body?.publicBaseUrl || ""),
        typeof body?.publicIp === "string" ? body.publicIp : undefined,
      );
      refreshIndexHtml("public ingress changed");
      return Response.json(await changedIngressResponse());
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/test" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    return Response.json(await publicIngressStatus(true));
  }
  return undefined;
}
