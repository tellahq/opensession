/**
 * GitHub REST client for personal Apps over an injected transport.
 *
 * There is no default transport. A caller that wants live GitHub traffic must
 * pass one explicitly, and the client refuses any URL outside GitHub's API and
 * OAuth hosts before the transport sees it. Every response body is bounded and
 * every parser returns typed values or null; nothing is trusted from the wire
 * beyond what is validated here. The client holds no credential: App JWTs,
 * installation tokens, user tokens and the confidential client pair are
 * supplied per call by the service or by the broker.
 */
import { PERSONAL_APP_PERMISSIONS } from "./permissions";
import { isGithubAccountId } from "../../shared/access-scope";
import { PersonalGithubWiringError } from "./errors";
import { validatePrivateKeyPem } from "./jwt";

export type PersonalGithubTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<Response>;

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_OAUTH_ORIGIN = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Per-response body ceilings. Lists are paged, so even the largest page
 * stays far under this. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_LIST_RESPONSE_BYTES = 1024 * 1024;
export const REPOSITORY_PAGE_SIZE = 100;
export const MAX_REPOSITORY_PAGES = 5;
export const MAX_DISCOVERED_REPOSITORIES =
  REPOSITORY_PAGE_SIZE * MAX_REPOSITORY_PAGES;
export const INSTALLATION_PAGE_SIZE = 100;
export const MAX_INSTALLATION_PAGES = 3;
const MAX_CODE_LENGTH = 512;
const MAX_TOKEN_LENGTH = 4096;

export interface ManifestConversion {
  githubAppId: number;
  name: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  owner: { id: number; login: string; type: string };
}

export interface InstallationSummary {
  installationId: number;
  account: { id: number; login: string; type: string };
  targetType: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
}

export interface RepositorySummary {
  repositoryId: number;
  name: string;
  fullName: string;
  owner: { id: number; login: string };
  private: boolean;
  defaultBranch: string | null;
}

export interface TokenGrant {
  accessToken: string;
  expiresInSeconds: number | null;
  refreshToken: string | null;
  refreshTokenExpiresInSeconds: number | null;
  scope: string | null;
}

export interface AuthenticatedUser {
  id: number;
  login: string;
  type: string;
}

export type ApiFailureCode =
  | "github_unavailable"
  | "response_too_large"
  | "denied"
  | "invalid";

export type ApiOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: ApiFailureCode; status: number; error: string };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function tokenString(value: unknown): string | null {
  const token = str(value, MAX_TOKEN_LENGTH);
  return token && !/\s/.test(token) ? token : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function accountFromJson(
  value: unknown,
): { id: number; login: string; type: string } | null {
  if (!isObject(value)) return null;
  const login = str(value.login, 64);
  const type = str(value.type, 32);
  if (!isGithubAccountId(value.id) || !login || !type) return null;
  return { id: value.id, login, type };
}

// ── Pure parsers ─────────────────────────────────────────────────────────────

/** GitHub's manifest conversion (`POST /app-manifests/{code}/conversions`).
 * The webhook secret GitHub also returns is deliberately not parsed: personal
 * Apps have no webhook and must never receive the shared webhook path. */
export function parseManifestConversion(
  body: unknown,
): ManifestConversion | null {
  if (!isObject(body)) return null;
  const name = str(body.name, 100);
  const slug = str(body.slug, 100);
  const clientId = str(body.client_id, 100);
  const clientSecret = str(body.client_secret, 200);
  const privateKeyPem = validatePrivateKeyPem(body.pem);
  const owner = accountFromJson(body.owner);
  if (
    !isGithubAccountId(body.id) ||
    !name ||
    body.public === true ||
    !Array.isArray(body.events) ||
    body.events.length !== 0 ||
    !slug ||
    !clientId ||
    !clientSecret ||
    !privateKeyPem ||
    !owner ||
    /\s/.test(clientId) ||
    /\s/.test(clientSecret) ||
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(slug)
  )
    return null;
  return {
    githubAppId: body.id,
    name,
    slug,
    clientId,
    clientSecret,
    privateKeyPem,
    owner,
  };
}

export function parseInstallation(body: unknown): InstallationSummary | null {
  if (!isObject(body)) return null;
  const account = accountFromJson(body.account);
  const targetType = str(body.target_type, 32);
  const selection = body.repository_selection;
  if (
    !isGithubAccountId(body.id) ||
    !account ||
    !targetType ||
    (selection !== "all" && selection !== "selected")
  )
    return null;
  return {
    installationId: body.id,
    account,
    targetType,
    repositorySelection: selection,
    suspended: body.suspended_at != null,
  };
}

export function parseRepository(body: unknown): RepositorySummary | null {
  if (!isObject(body)) return null;
  const name = str(body.name, 128);
  const fullName = str(body.full_name, 256);
  const owner = accountFromJson(body.owner);
  if (
    !isGithubAccountId(body.id) ||
    !name ||
    !fullName ||
    !owner ||
    owner.type !== "User" ||
    !/^[a-z0-9_.-]+$/i.test(name) ||
    name === "." ||
    name === ".." ||
    !/^[a-z0-9-]+$/i.test(owner.login) ||
    fullName !== `${owner.login}/${name}` ||
    typeof body.private !== "boolean"
  )
    return null;
  return {
    repositoryId: body.id,
    name,
    fullName,
    owner: { id: owner.id, login: owner.login },
    private: body.private,
    defaultBranch: str(body.default_branch, 256),
  };
}

export function parseTokenGrant(body: unknown): TokenGrant | null {
  if (!isObject(body)) return null;
  const accessToken = tokenString(body.access_token);
  if (!accessToken) return null;
  for (const field of ["expires_in", "refresh_token_expires_in"] as const) {
    if (
      body[field] !== undefined &&
      (nonNegativeInt(body[field]) === null ||
        Number(body[field]) < 1 ||
        Number(body[field]) > 366 * 86400)
    )
      return null;
  }
  const refreshToken =
    body.refresh_token === undefined ? null : tokenString(body.refresh_token);
  if (body.refresh_token !== undefined && !refreshToken) return null;
  return {
    accessToken,
    expiresInSeconds: nonNegativeInt(body.expires_in),
    refreshToken,
    refreshTokenExpiresInSeconds: nonNegativeInt(body.refresh_token_expires_in),
    scope: str(body.scope, 512),
  };
}

export function parseAuthenticatedUser(
  body: unknown,
): AuthenticatedUser | null {
  const account = accountFromJson(body);
  return account
    ? { id: account.id, login: account.login, type: account.type }
    : null;
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface PersonalGithubApiOptions {
  transport: PersonalGithubTransport;
  timeoutMs?: number;
  userAgent?: string;
}

interface RequestSpec {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: Json;
  maxBytes?: number;
}

interface RawResponse {
  status: number;
  body: unknown;
}

export type DeviceFlowPollOutcome =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "granted"; grant: TokenGrant }
  | { status: "denied"; error: string };

export type RefreshOutcome =
  | { status: "granted"; grant: TokenGrant }
  | { status: "dead"; error: string };

export function createPersonalGithubApi(options: PersonalGithubApiOptions) {
  if (typeof options.transport !== "function")
    throw new PersonalGithubWiringError(
      "personal GitHub API needs an explicit transport",
    );
  const transport = options.transport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new PersonalGithubWiringError("Invalid GitHub timeout");
  const userAgent = options.userAgent ?? "opensession-personal";

  function assertAllowedUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PersonalGithubWiringError(`invalid GitHub URL: ${url}`);
    }
    const allowed =
      parsed.origin === GITHUB_API_ORIGIN ||
      (parsed.origin === GITHUB_OAUTH_ORIGIN &&
        parsed.pathname.startsWith("/login/"));
    if (!allowed)
      throw new PersonalGithubWiringError(
        `refusing non-GitHub request to ${parsed.origin}`,
      );
  }

  async function request(spec: RequestSpec): Promise<ApiOutcome<RawResponse>> {
    assertAllowedUrl(spec.url);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": userAgent,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(spec.headers ?? {}),
    };
    if (spec.body) headers["Content-Type"] = "application/json";
    const encoded = spec.body ? JSON.stringify(spec.body) : undefined;
    if (
      (encoded && Buffer.byteLength(encoded) > 16_384) ||
      Object.values(headers).some(
        (value) => value.length > 8192 || /[\r\n]/.test(value),
      )
    )
      return {
        ok: false,
        code: "invalid",
        status: 0,
        error: "GitHub request exceeds limits",
      };
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await boundedWait(
        transport(spec.url, {
          method: spec.method,
          headers,
          ...(encoded ? { body: encoded } : {}),
          signal,
          redirect: "error",
        }),
        signal,
      );
    } catch {
      return {
        ok: false,
        code: "github_unavailable",
        status: 0,
        error: "GitHub unreachable",
      };
    }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => {});
      return {
        ok: false,
        code: "denied",
        status: response.status,
        error: "GitHub redirect refused",
      };
    }
    const max = spec.maxBytes ?? MAX_RESPONSE_BYTES;
    let text: string;
    try {
      text = await readBoundedText(response, max, signal);
    } catch {
      return {
        ok: false,
        code: "response_too_large",
        status: response.status,
        error: "GitHub response could not be read within limits",
      };
    }
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { ok: true, value: { status: response.status, body } };
  }

  function failure(raw: RawResponse, fallback: string): ApiOutcome<never> {
    return {
      ok: false,
      code:
        raw.status === 401 || raw.status === 403 || raw.status === 404
          ? "denied"
          : raw.status >= 500 || raw.status === 0
            ? "github_unavailable"
            : "invalid",
      status: raw.status,
      error: `${fallback} (${raw.status})`,
    };
  }

  function invalid(status: number, error: string): ApiOutcome<never> {
    return { ok: false, code: "invalid", status, error };
  }

  function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  return {
    async convertManifest(
      code: string,
    ): Promise<ApiOutcome<ManifestConversion>> {
      if (
        !code ||
        code.length > MAX_CODE_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(code)
      )
        return invalid(0, "Malformed manifest code");
      const raw = await request({
        method: "POST",
        url: `${GITHUB_API_ORIGIN}/app-manifests/${encodeURIComponent(code)}/conversions`,
      });
      if (!raw.ok) return raw;
      if (raw.value.status !== 201 && raw.value.status !== 200)
        return failure(raw.value, "GitHub manifest exchange failed");
      const conversion = parseManifestConversion(raw.value.body);
      return conversion
        ? { ok: true, value: conversion }
        : invalid(
            raw.value.status,
            "GitHub returned an incomplete App registration",
          );
    },

    async listAppInstallations(
      appJwt: string,
    ): Promise<ApiOutcome<InstallationSummary[]>> {
      const installations: InstallationSummary[] = [];
      for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
        const raw = await request({
          method: "GET",
          url: `${GITHUB_API_ORIGIN}/app/installations?per_page=${INSTALLATION_PAGE_SIZE}&page=${page}`,
          headers: bearer(appJwt),
          maxBytes: MAX_LIST_RESPONSE_BYTES,
        });
        if (!raw.ok) return raw;
        if (raw.value.status !== 200 || !Array.isArray(raw.value.body))
          return failure(raw.value, "cannot list App installations");
        if (raw.value.body.length > INSTALLATION_PAGE_SIZE)
          return invalid(raw.value.status, "Too many installations in page");
        for (const entry of raw.value.body) {
          const installation = parseInstallation(entry);
          if (!installation)
            return invalid(raw.value.status, "Invalid installation");
          installations.push(installation);
        }
        if (raw.value.body.length < INSTALLATION_PAGE_SIZE) break;
        if (page === MAX_INSTALLATION_PAGES)
          return invalid(raw.value.status, "Installation list exceeds limit");
      }
      return { ok: true, value: installations };
    },

    async mintInstallationToken(input: {
      appJwt: string;
      installationId: number;
      repositoryIds?: number[];
      permissions: Record<string, string>;
    }): Promise<ApiOutcome<{ token: string; expiresAt: number | null }>> {
      if (!isGithubAccountId(input.installationId))
        return invalid(0, "Invalid installation id");
      for (const [scope, level] of Object.entries(input.permissions)) {
        if (
          PERSONAL_APP_PERMISSIONS[scope] === undefined ||
          (level === "write" && PERSONAL_APP_PERMISSIONS[scope] !== "write") ||
          (level !== "read" && level !== "write")
        )
          return invalid(
            0,
            `permission ${scope} is outside the personal App grant`,
          );
      }
      if (
        input.repositoryIds &&
        (!input.repositoryIds.length ||
          input.repositoryIds.length > 50 ||
          !input.repositoryIds.every(isGithubAccountId))
      )
        return invalid(0, "invalid repository selection");
      const raw = await request({
        method: "POST",
        url: `${GITHUB_API_ORIGIN}/app/installations/${input.installationId}/access_tokens`,
        headers: bearer(input.appJwt),
        body: {
          permissions: input.permissions,
          ...(input.repositoryIds
            ? { repository_ids: input.repositoryIds }
            : {}),
        },
      });
      if (!raw.ok) return raw;
      if (raw.value.status !== 201 || !isObject(raw.value.body))
        return failure(raw.value, "installation token mint failed");
      const token = tokenString(raw.value.body.token);
      if (!token)
        return invalid(
          raw.value.status,
          "GitHub returned no installation token",
        );
      const expires = str(raw.value.body.expires_at, 64);
      const expiresAt = expires ? Date.parse(expires) : NaN;
      return {
        ok: true,
        value: {
          token,
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        },
      };
    },

    async listInstallationRepositories(
      installationToken: string,
    ): Promise<
      ApiOutcome<{ repositories: RepositorySummary[]; truncated: boolean }>
    > {
      const repositories: RepositorySummary[] = [];
      let truncated = false;
      for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
        const raw = await request({
          method: "GET",
          url: `${GITHUB_API_ORIGIN}/installation/repositories?per_page=${REPOSITORY_PAGE_SIZE}&page=${page}`,
          headers: bearer(installationToken),
          maxBytes: MAX_LIST_RESPONSE_BYTES,
        });
        if (!raw.ok) return raw;
        const body = raw.value.body;
        if (
          raw.value.status !== 200 ||
          !isObject(body) ||
          !Array.isArray(body.repositories)
        )
          return failure(raw.value, "cannot list installation repositories");
        if (body.repositories.length > REPOSITORY_PAGE_SIZE)
          return invalid(raw.value.status, "Too many repositories in page");
        for (const entry of body.repositories) {
          const repository = parseRepository(entry);
          if (!repository)
            return invalid(raw.value.status, "Invalid repository");
          repositories.push(repository);
        }
        const total = nonNegativeInt(body.total_count);
        if (total === null)
          return invalid(raw.value.status, "Missing repository count");
        if (
          body.repositories.length < REPOSITORY_PAGE_SIZE ||
          repositories.length >= total
        )
          break;
        if (page === MAX_REPOSITORY_PAGES) truncated = true;
      }
      return { ok: true, value: { repositories, truncated } };
    },

    async revokeInstallationToken(
      installationToken: string,
    ): Promise<ApiOutcome<null>> {
      const raw = await request({
        method: "DELETE",
        url: `${GITHUB_API_ORIGIN}/installation/token`,
        headers: bearer(installationToken),
      });
      if (!raw.ok) return raw;
      return raw.value.status === 204
        ? { ok: true, value: null }
        : failure(raw.value, "installation token revoke failed");
    },

    async startDeviceFlow(clientId: string): Promise<
      ApiOutcome<{
        deviceCode: string;
        userCode: string;
        interval: number;
        expiresIn: number;
      }>
    > {
      const raw = await request({
        method: "POST",
        url: `${GITHUB_OAUTH_ORIGIN}/login/device/code`,
        body: { client_id: clientId },
      });
      if (!raw.ok) return raw;
      const body = raw.value.body;
      if (raw.value.status !== 200 || !isObject(body))
        return failure(raw.value, "device flow start failed");
      const deviceCode = tokenString(body.device_code);
      const userCode = str(body.user_code, 32);
      if (!deviceCode || !userCode) {
        const code = str(body.error, 64);
        return invalid(
          raw.value.status,
          code === "device_flow_disabled"
            ? "Enable Device Flow in the personal App's settings on GitHub, then try again."
            : "device flow start failed",
        );
      }
      return {
        ok: true,
        value: {
          deviceCode,
          userCode,
          interval: nonNegativeInt(body.interval) ?? 5,
          expiresIn: nonNegativeInt(body.expires_in) ?? 900,
        },
      };
    },

    async pollDeviceFlow(input: {
      clientId: string;
      deviceCode: string;
    }): Promise<ApiOutcome<DeviceFlowPollOutcome>> {
      if (!tokenString(input.deviceCode))
        return invalid(0, "Malformed device code");
      const raw = await request({
        method: "POST",
        url: `${GITHUB_OAUTH_ORIGIN}/login/oauth/access_token`,
        body: {
          client_id: input.clientId,
          device_code: input.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      });
      if (!raw.ok) return raw;
      const body = raw.value.body;
      if (raw.value.status !== 200 || !isObject(body))
        return failure(raw.value, "device flow poll failed");
      const error = str(body.error, 64);
      if (error === "authorization_pending")
        return { ok: true, value: { status: "pending" } };
      if (error === "slow_down")
        return {
          ok: true,
          value: {
            status: "slow_down",
            interval: nonNegativeInt(body.interval) ?? 10,
          },
        };
      if (error)
        return {
          ok: true,
          value: {
            status: "denied",
            error: "GitHub authorization denied",
          },
        };
      const grant = parseTokenGrant(body);
      return grant
        ? { ok: true, value: { status: "granted", grant } }
        : failure(raw.value, "GitHub returned no access token");
    },

    /** Confidential. Intended for broker implementations only: the client
     * secret must be supplied by the broker's own storage. */
    async refreshUserToken(input: {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    }): Promise<ApiOutcome<RefreshOutcome>> {
      const raw = await request({
        method: "POST",
        url: `${GITHUB_OAUTH_ORIGIN}/login/oauth/access_token`,
        body: {
          client_id: input.clientId,
          client_secret: input.clientSecret,
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
        },
      });
      if (!raw.ok) return raw;
      const body = raw.value.body;
      if (raw.value.status !== 200 || !isObject(body))
        return failure(raw.value, "refresh failed");
      const error = str(body.error, 64);
      if (error === "bad_refresh_token")
        return {
          ok: true,
          value: {
            status: "dead",
            error: "GitHub authorization denied",
          },
        };
      if (error)
        return invalid(raw.value.status, "GitHub authorization denied");
      const grant = parseTokenGrant(body);
      return grant
        ? { ok: true, value: { status: "granted", grant } }
        : failure(raw.value, "GitHub returned no access token");
    },

    async getAuthenticatedUser(
      userToken: string,
    ): Promise<ApiOutcome<AuthenticatedUser>> {
      const raw = await request({
        method: "GET",
        url: `${GITHUB_API_ORIGIN}/user`,
        headers: bearer(userToken),
      });
      if (!raw.ok) return raw;
      if (raw.value.status !== 200)
        return failure(raw.value, "GET /user failed");
      const user = parseAuthenticatedUser(raw.value.body);
      return user
        ? { ok: true, value: user }
        : invalid(raw.value.status, "GitHub returned no stable account id");
    },

    async revokeUserToken(input: {
      clientId: string;
      clientSecret: string;
      accessToken: string;
    }): Promise<ApiOutcome<null>> {
      const raw = await request({
        method: "DELETE",
        url: `${GITHUB_API_ORIGIN}/applications/${encodeURIComponent(input.clientId)}/token`,
        headers: {
          Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
        },
        body: { access_token: input.accessToken },
      });
      if (!raw.ok) return raw;
      return raw.value.status === 204 || raw.value.status === 404
        ? { ok: true, value: null }
        : failure(raw.value, "token revoke failed");
    },

    /** Confidential. Revoke the App's user grant, which invalidates every
     * token GitHub issued for it. Broker implementations only. */
    async revokeUserGrant(input: {
      clientId: string;
      clientSecret: string;
      accessToken: string;
    }): Promise<ApiOutcome<null>> {
      const raw = await request({
        method: "DELETE",
        url: `${GITHUB_API_ORIGIN}/applications/${encodeURIComponent(input.clientId)}/grant`,
        headers: {
          Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
        },
        body: { access_token: input.accessToken },
      });
      if (!raw.ok) return raw;
      return raw.value.status === 204 || raw.value.status === 404
        ? { ok: true, value: null }
        : failure(raw.value, "grant revoke failed");
    },
  };
}

export type PersonalGithubApi = ReturnType<typeof createPersonalGithubApi>;

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error("GitHub response exceeds limit");
  }
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await boundedWait(reader.read(), signal);
    } catch {
      void reader.cancel().catch(() => {});
      throw new Error("GitHub body timed out");
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new Error(`GitHub response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A transport ignoring AbortSignal still cannot hold the broker mutation lane
 * indefinitely. Live adapters MUST abort underlying I/O and reject redirects. */
async function boundedWait<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("GitHub request timed out"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
