import { createPrivateKey, randomUUID } from "node:crypto";
import { audit } from "../audit";
import { configuredIngress } from "../config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import { prepareEnvFileEdits } from "../env-file-edit";
import { githubAppConfigSource } from "../github-auth";
import { commitGithubAppKeyMutation } from "../github-app";
import { GITHUB_APP_GRANT_PERMISSIONS } from "../../shared/github-app-permissions";
import type { RouteContext } from "./context";

const MANIFEST_TTL_MS = 60 * 60_000;
const MAX_PENDING_MANIFESTS = 32;
const GITHUB_API_VERSION = "2022-11-28";

export const GITHUB_APP_MANIFEST_EVENTS = [
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_run",
] as const;

type ManifestOwner =
  | { type: "personal" }
  | { type: "organization"; login: string };

interface PendingManifest {
  createdAt: number;
  origin: string;
  publicPrefix: string;
  owner: ManifestOwner;
  returnTo: "welcome" | "settings";
  authLogin: string | null;
  used: boolean;
}

interface ManifestConversion {
  slug?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  webhook_secret?: unknown;
  pem?: unknown;
  owner?: { login?: unknown };
}

const runtime = globalThis as {
  __opensessionGithubManifestStates?: Map<string, PendingManifest>;
};

function pendingManifests(): Map<string, PendingManifest> {
  return (runtime.__opensessionGithubManifestStates ??= new Map());
}

/** Test seam. Pending registration state contains no credential, but clearing it
 * keeps route tests independent and proves a callback cannot rely on old state. */
export function __resetGithubManifestStatesForTest(): void {
  pendingManifests().clear();
}

function prunePendingManifests(now = Date.now()): void {
  const states = pendingManifests();
  for (const [state, pending] of states) {
    if (now - pending.createdAt > MANIFEST_TTL_MS) states.delete(state);
  }
}

function makeRoomForManifest(): void {
  const states = pendingManifests();
  while (states.size >= MAX_PENDING_MANIFESTS) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    states.delete(oldest);
  }
}

function githubLogin(value: unknown): string {
  const login = typeof value === "string" ? value.trim() : "";
  if (
    !login ||
    login.length > 39 ||
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(login) ||
    login.includes("--")
  ) {
    throw new Error("Enter a valid GitHub organization login");
  }
  return login;
}

function manifestCallbackUrl(origin: string, publicPrefix: string): string {
  return `${origin}${publicPrefix}/api/setup/github/manifest/callback`;
}

export function buildGithubAppManifest(input: {
  origin: string;
  publicPrefix: string;
  appName?: string;
  ingressUrl?: string;
}): Record<string, unknown> {
  const ingressUrl = input.ingressUrl?.trim().replace(/\/+$/, "") || "";
  const hookBaseUrl = ingressUrl || `${input.origin}${input.publicPrefix}`;
  return {
    name:
      input.appName ||
      `Open Session (${Math.random().toString(36).slice(2, 6)})`,
    url: input.origin,
    redirect_url: manifestCallbackUrl(input.origin, input.publicPrefix),
    public: false,
    default_permissions: GITHUB_APP_GRANT_PERMISSIONS,
    default_events: GITHUB_APP_MANIFEST_EVENTS,
    // GitHub rejects a manifest with subscribed events and no hook URL. A
    // private instance still supplies its own valid URL, but leaves delivery
    // inactive until public ingress is configured in Settings.
    hook_attributes: {
      url: `${hookBaseUrl}/github/webhook`,
      active: Boolean(ingressUrl),
    },
  };
}

function integrationSection(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const integrations =
    config.integrations &&
    typeof config.integrations === "object" &&
    !Array.isArray(config.integrations)
      ? (config.integrations as Record<string, unknown>)
      : {};
  config.integrations = integrations;
  const github =
    integrations.github &&
    typeof integrations.github === "object" &&
    !Array.isArray(integrations.github)
      ? (integrations.github as Record<string, unknown>)
      : {};
  integrations.github = github;
  return github;
}

function validateConversion(
  body: ManifestConversion,
  owner: ManifestOwner,
): {
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
  ownerLogin: string;
} {
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const clientId =
    typeof body.client_id === "string" ? body.client_id.trim() : "";
  const clientSecret =
    typeof body.client_secret === "string" ? body.client_secret.trim() : "";
  const webhookSecret =
    typeof body.webhook_secret === "string" ? body.webhook_secret.trim() : "";
  const pem = typeof body.pem === "string" ? body.pem.trim() : "";
  const ownerLogin =
    typeof body.owner?.login === "string" ? body.owner.login.trim() : "";
  if (
    !slug ||
    !clientId ||
    !clientSecret ||
    !webhookSecret ||
    !pem ||
    !ownerLogin
  ) {
    throw new Error("GitHub returned an incomplete App registration");
  }
  if (
    owner.type === "organization" &&
    ownerLogin.toLowerCase() !== owner.login.toLowerCase()
  ) {
    throw new Error(
      `GitHub created the App under ${ownerLogin}, not ${owner.login}`,
    );
  }
  if (
    /\s/.test(clientId) ||
    /\s/.test(clientSecret) ||
    /[\r\n\0]/.test(webhookSecret)
  ) {
    throw new Error("GitHub returned malformed App credentials");
  }
  try {
    createPrivateKey(pem);
  } catch {
    throw new Error("GitHub returned an invalid App private key");
  }
  return { slug, clientId, clientSecret, webhookSecret, pem, ownerLogin };
}

async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "opensession",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json().catch(() => null)) as
    | ManifestConversion
    | { message?: unknown }
    | null;
  if (!response.ok || !body) {
    const message =
      typeof (body as { message?: unknown } | null)?.message === "string"
        ? String((body as { message: string }).message).slice(0, 180)
        : `GitHub manifest exchange failed (${response.status})`;
    throw new Error(message);
  }
  return body as ManifestConversion;
}

function callbackRedirect(
  pending: PendingManifest,
  result: "created" | "error",
): Response {
  const path =
    pending.returnTo === "settings"
      ? `${pending.publicPrefix}/settings/integrations`
      : `${pending.publicPrefix}/welcome`;
  const target = new URL(path, pending.origin);
  if (pending.returnTo === "welcome") target.searchParams.set("step", "github");
  target.searchParams.set("github_manifest", result);
  return Response.redirect(target, 303);
}

export async function handleSetupGithubManifestRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;
  if (path === "/api/setup/github/manifest" && req.method === "POST") {
    if (
      githubAppConfigSource() === "env" ||
      process.env.OPENSESSION_GITHUB_APP_KEY
    ) {
      return Response.json(
        {
          error:
            "A GitHub App is managed through environment settings and cannot be replaced here",
        },
        { status: 409 },
      );
    }
    const current = integrationSection(rawConfig());
    if (
      typeof current.oauthClientId === "string" &&
      current.oauthClientId.trim()
    ) {
      return Response.json(
        { error: "A GitHub App is already configured" },
        { status: 409 },
      );
    }
    const body = (await req.json().catch(() => null)) as {
      owner?: unknown;
      organization?: unknown;
      returnTo?: unknown;
    } | null;
    let owner: ManifestOwner;
    try {
      owner =
        body?.owner === "personal"
          ? { type: "personal" }
          : body?.owner === "organization"
            ? { type: "organization", login: githubLogin(body.organization) }
            : (() => {
                throw new Error("Choose who will own the GitHub App");
              })();
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return Response.json(
        { error: "Open Session needs an HTTP address" },
        { status: 400 },
      );
    }
    prunePendingManifests();
    makeRoomForManifest();
    const state = `${randomUUID()}${randomUUID()}`;
    const pending: PendingManifest = {
      createdAt: Date.now(),
      origin: url.origin,
      publicPrefix,
      owner,
      returnTo: body?.returnTo === "settings" ? "settings" : "welcome",
      authLogin: ctx.authUser?.login ?? null,
      used: false,
    };
    pendingManifests().set(state, pending);
    const base =
      owner.type === "organization"
        ? `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/new`
        : "https://github.com/settings/apps/new";
    const action = new URL(base);
    action.searchParams.set("state", state);
    return Response.json({
      action: action.toString(),
      manifest: JSON.stringify(
        buildGithubAppManifest({
          origin: url.origin,
          publicPrefix,
          ingressUrl: configuredIngress().publicBaseUrl,
        }),
      ),
    });
  }

  if (path === "/api/setup/github/manifest/callback" && req.method === "GET") {
    prunePendingManifests();
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const pending = pendingManifests().get(state);
    if (
      !pending ||
      pending.used ||
      !code ||
      pending.authLogin !== (ctx.authUser?.login ?? null)
    ) {
      return Response.json(
        {
          error:
            "This GitHub App registration is missing, expired, or already used",
        },
        { status: 400 },
      );
    }
    pending.used = true;
    try {
      const converted = validateConversion(
        await exchangeManifestCode(code),
        pending.owner,
      );
      await withConfigMutationLock(async () => {
        const config = rawConfig();
        const github = integrationSection(config);
        github.oauthClientId = converted.clientId;
        github.oauthClientSecret = converted.clientSecret;
        github.appSlug = converted.slug;
        github.installationOwner = converted.ownerLogin;
        // App setup is also sign-in setup. Arm the connect-time bootstrap for
        // both personal and organization-owned Apps, but do not enable the gate
        // yet: the device-flow account must be rostered and receive its session
        // first, or the operator would be locked out.
        github.authOnConnect = true;
        if (pending.owner.type === "organization") {
          github.appOrg = converted.ownerLogin;
        } else {
          delete github.appOrg;
        }
        const envEdit = prepareEnvFileEdits({
          GITHUB_WEBHOOK_SECRET: converted.webhookSecret,
        });
        envEdit.commit();
        try {
          await commitGithubAppKeyMutation(converted.pem, () =>
            persistRawConfig(config),
          );
        } catch (error) {
          envEdit.rollback();
          throw error;
        }
      });
      pendingManifests().delete(state);
      audit({
        kind: "setup_github_manifest_complete",
        owner: converted.ownerLogin,
        by: ctx.authUser?.login || null,
      });
      return callbackRedirect(pending, "created");
    } catch (error) {
      console.error(
        `[setup] GitHub App manifest completion failed: ${String((error as Error)?.message || error).slice(0, 200)}`,
      );
      return callbackRedirect(pending, "error");
    }
  }

  return undefined;
}
