/**
 * Instance-settings routes: the writable slice of ~/.opensession/config.json
 * exposed in Settings → General and Settings → Identity.
 * Config reads are mtime-guarded per call, so a write applies to new runs
 * immediately; the frontend rebuild re-injects the instance blob + HTML
 * titles and nudges open tabs via the `frontend_updated` broadcast.
 */

import type { RouteContext } from "./context";
import {
  configPath,
  configuredRepos,
  configuredSelfDev,
  getConfig,
  organizationName,
  personaName,
  productName,
  productMark,
  type ResolvedAssetStorage,
  type SelfDevMode,
} from "../config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import { refreshIndexHtml } from "../frontend-build";
import {
  OrganizationIconError,
  MAX_ORGANIZATION_ICON_BYTES,
  organizationIconRevision,
  removeOrganizationIcon,
  saveOrganizationIcon,
} from "../organization-settings";
import { requireWorkspaceAdmin } from "../workspace-auth";
import { testS3AssetStorage } from "../session-assets";
import { githubCredentialForLogin } from "../github-auth";
import { fetchWithTimeout } from "../shared/fetch-with-timeout";

const MAX_NAME_LENGTH = 80;
const MAX_STORAGE_FIELD_LENGTH = 500;

class OrganizationIconBodyTooLarge extends Error {}

async function organizationIconBody(req: Request): Promise<Uint8Array> {
  const contentLength = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_ORGANIZATION_ICON_BYTES
  ) {
    throw new OrganizationIconBodyTooLarge();
  }
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ORGANIZATION_ICON_BYTES) {
      await reader.cancel();
      throw new OrganizationIconBodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function identityDto() {
  return {
    personaName: personaName(),
    productName: productName(),
    productMark: productMark(),
    configPath: configPath(),
  };
}

function generalDto(publicPrefix: string) {
  const revision = organizationIconRevision();
  return {
    organizationName: organizationName(),
    organizationIconUrl:
      revision === null
        ? null
        : `${publicPrefix}/organization-icon.png?v=${revision}`,
    organizationIconRevision: revision,
    configPath: configPath(),
  };
}

function worktreeSettingsDto() {
  return {
    mode: configuredSelfDev(),
    repos: Object.values(configuredRepos())
      .filter((repo) => repo.sharedCheckout)
      .map((repo) => ({ id: repo.id, label: repo.label })),
  };
}

/**
 * The connected GitHub organization's public profile, so the onboarding
 * organization step can fill itself in rather than ask for two things the
 * connection already knows.
 *
 * Server-side because the token lives here: the browser never sees it, and an
 * organization that is private to the installation still resolves. The avatar
 * is handed back as a URL rather than bytes, since avatars.githubusercontent.com
 * allows cross-origin reads and the browser already has the canvas path that
 * turns any picked image into the square PNG the icon endpoint wants.
 */
async function githubOrganizationProfile(
  ctx: RouteContext,
  login: string,
): Promise<Response> {
  const { githubToken } = await import("../github-app");
  const tokens = [
    ctx.authUser?.login
      ? githubCredentialForLogin(ctx.authUser.login)?.env.GH_TOKEN
      : undefined,
    await githubToken(),
  ].filter((token): token is string => !!token);
  const response = await fetchWithTimeout(
    `https://api.github.com/orgs/${encodeURIComponent(login)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "opensession",
        ...(tokens[0] ? { Authorization: `Bearer ${tokens[0]}` } : {}),
      },
    },
  ).catch(() => null);
  const body = (await response?.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response?.ok || !body) {
    // A missing or unreadable organization is not an error worth stopping
    // onboarding for: the fields simply stay empty and editable.
    return Response.json({ login, name: "", avatarUrl: "" });
  }
  const str = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  return Response.json({
    login,
    name: str(body.name) || login,
    avatarUrl: str(body.avatar_url),
  });
}

function assetStorageDto() {
  const config = getConfig().storage?.assets;
  if (!config || config.provider !== "s3") {
    return {
      provider: "local" as const,
      bucket: "",
      region: "us-east-1",
      endpoint: "",
      prefix: "opensession-assets",
      accessKeyId: "",
      secretAccessKeySet: false,
      forcePathStyle: false,
    };
  }
  return {
    provider: "s3" as const,
    bucket: config.bucket || "",
    region: config.region || "us-east-1",
    endpoint: config.endpoint || "",
    prefix: config.prefix || "opensession-assets",
    accessKeyId: config.accessKeyId || "",
    secretAccessKeySet: !!config.secretAccessKey,
    forcePathStyle: config.forcePathStyle === true,
  };
}

function storageString(
  value: unknown,
  label: string,
  required = false,
): string {
  if (typeof value !== "string") {
    if (!required && value === undefined) return "";
    throw new Error(`${label} must be a string`);
  }
  const clean = value.trim();
  if (required && !clean) throw new Error(`${label} is required`);
  if (clean.length > MAX_STORAGE_FIELD_LENGTH)
    throw new Error(
      `${label} must be at most ${MAX_STORAGE_FIELD_LENGTH} characters`,
    );
  return clean;
}

export function assetStorageCandidate(
  body: Record<string, unknown>,
): ResolvedAssetStorage {
  if (body.provider === "local") return { provider: "local" };
  if (body.provider !== "s3") throw new Error("provider must be local or s3");
  const current = getConfig().storage?.assets;
  const endpoint = storageString(body.endpoint, "endpoint");
  if (endpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("endpoint must be a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new Error("endpoint must use http or https");
  }
  const prefix =
    storageString(body.prefix, "prefix").replace(/^\/+|\/+$/g, "") ||
    "opensession-assets";
  if (prefix.split("/").includes(".."))
    throw new Error("prefix cannot contain .. segments");
  const secretFromBody = storageString(body.secretAccessKey, "secretAccessKey");
  const secretAccessKey =
    secretFromBody || current?.secretAccessKey?.trim() || "";
  if (!secretAccessKey) throw new Error("secretAccessKey is required");
  return {
    provider: "s3",
    bucket: storageString(body.bucket, "bucket", true),
    region: storageString(body.region, "region") || "us-east-1",
    ...(endpoint ? { endpoint } : {}),
    prefix,
    accessKeyId: storageString(body.accessKeyId, "accessKeyId", true),
    secretAccessKey,
    forcePathStyle: body.forcePathStyle === true,
  };
}

function persistAssetStorage(config: ResolvedAssetStorage): void {
  const raw = rawConfig();
  const storage =
    raw.storage &&
    typeof raw.storage === "object" &&
    !Array.isArray(raw.storage)
      ? { ...(raw.storage as Record<string, unknown>) }
      : {};
  if (config.provider === "local") {
    delete storage.assets;
    if (Object.keys(storage).length) raw.storage = storage;
    else delete raw.storage;
  } else {
    storage.assets = config;
    raw.storage = storage;
  }
  persistRawConfig(raw);
}

/** Optional string field: absent → undefined, otherwise a length-capped string. */
function nameField(v: unknown, label: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${label} must be a string`);
  if (v.trim().length > MAX_NAME_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return v;
}

function setOrDelete(
  config: Record<string, unknown>,
  section: string,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const current =
    config[section] &&
    typeof config[section] === "object" &&
    !Array.isArray(config[section])
      ? { ...(config[section] as Record<string, unknown>) }
      : {};
  const trimmed = value.trim();
  if (trimmed) current[key] = trimmed;
  else delete current[key];
  if (Object.keys(current).length) config[section] = current;
  else delete config[section];
}

export async function handleInstanceSettingsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, publicPrefix } = ctx;

  if (path === "/api/settings/general" && req.method === "GET") {
    return Response.json(generalDto(publicPrefix));
  }

  if (path === "/api/settings/worktrees" && req.method === "GET") {
    return Response.json(worktreeSettingsDto());
  }

  if (path === "/api/settings/worktrees" && req.method === "PUT") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return Response.json({ error: "expected a JSON body" }, { status: 400 });
    }
    if (body.mode !== "shared" && body.mode !== "worktree") {
      return Response.json(
        { error: "mode must be shared or worktree" },
        { status: 400 },
      );
    }
    const mode: SelfDevMode = body.mode;
    await withConfigMutationLock(async () => {
      const config = rawConfig();
      config.selfDev = mode;
      persistRawConfig(config);
    });
    return Response.json(worktreeSettingsDto());
  }

  if (
    path === "/api/settings/general/github-organization" &&
    req.method === "GET"
  ) {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const login = new URL(req.url).searchParams.get("login")?.trim() || "";
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
      return Response.json(
        { error: "login must be a GitHub org" },
        { status: 400 },
      );
    }
    return githubOrganizationProfile(ctx, login);
  }

  if (path === "/api/settings/general" && req.method === "PUT") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return Response.json({ error: "expected a JSON body" }, { status: 400 });
    }
    try {
      const name = nameField(body.organizationName, "organizationName");
      await withConfigMutationLock(async () => {
        const config = rawConfig();
        setOrDelete(config, "organization", "name", name);
        persistRawConfig(config);
      });
    } catch (error: any) {
      return Response.json(
        { error: error?.message || String(error) },
        { status: 400 },
      );
    }
    return Response.json(generalDto(publicPrefix));
  }

  if (path === "/api/settings/general/icon" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    try {
      saveOrganizationIcon(await organizationIconBody(req));
      return Response.json(generalDto(publicPrefix));
    } catch (error) {
      if (error instanceof OrganizationIconBodyTooLarge) {
        return Response.json(
          { error: "That image is too large. Icons cap at 4 MB." },
          { status: 413 },
        );
      }
      return Response.json(
        {
          error:
            error instanceof OrganizationIconError
              ? error.message
              : "Couldn’t store that icon",
        },
        { status: error instanceof OrganizationIconError ? 400 : 500 },
      );
    }
  }

  if (path === "/api/settings/general/icon" && req.method === "DELETE") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    removeOrganizationIcon();
    return Response.json(generalDto(publicPrefix));
  }

  if (path === "/api/settings/asset-storage" && req.method === "GET") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    return Response.json(assetStorageDto());
  }

  if (path === "/api/settings/asset-storage/test" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return Response.json({ error: "expected a JSON body" }, { status: 400 });
    try {
      const candidate = assetStorageCandidate(body);
      if (candidate.provider === "s3") await testS3AssetStorage(candidate);
      return Response.json({ ok: true });
    } catch (error: any) {
      return Response.json(
        { error: error?.message || String(error) },
        { status: 400 },
      );
    }
  }

  if (path === "/api/settings/asset-storage" && req.method === "PUT") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return Response.json({ error: "expected a JSON body" }, { status: 400 });
    try {
      const candidate = assetStorageCandidate(body);
      if (candidate.provider === "s3") await testS3AssetStorage(candidate);
      await withConfigMutationLock(async () => persistAssetStorage(candidate));
      return Response.json(assetStorageDto());
    } catch (error: any) {
      return Response.json(
        { error: error?.message || String(error) },
        { status: 400 },
      );
    }
  }

  if (path === "/api/settings/identity" && req.method === "GET") {
    return Response.json(identityDto());
  }

  if (path === "/api/settings/identity" && req.method === "PUT") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return Response.json({ error: "expected a JSON body" }, { status: 400 });
    }
    try {
      const patch = {
        personaName: nameField(body.personaName, "personaName"),
        productName: nameField(body.productName, "productName"),
        productMark: nameField(body.productMark, "productMark"),
      };
      await withConfigMutationLock(async () => {
        const config = rawConfig();
        setOrDelete(config, "persona", "name", patch.personaName);
        setOrDelete(config, "branding", "productName", patch.productName);
        setOrDelete(config, "branding", "productMark", patch.productMark);
        persistRawConfig(config);
      });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
    refreshIndexHtml("identity settings");
    return Response.json(identityDto());
  }

  return undefined;
}
