/**
 * Claude API credentials: Claude accounts that bill an Anthropic API
 * organization instead of a Claude subscription.
 *
 * Two kinds:
 *  - "api-key": a static `sk-ant-api…` key, sent as ANTHROPIC_API_KEY.
 *  - "federation": Workload Identity Federation. This server signs a
 *    short-lived ID token with its own workload identity issuer
 *    (workload-identity.ts), exchanges it at Anthropic's token endpoint
 *    (RFC 7523 jwt-bearer grant) for a short-lived access token bound to a
 *    service account, and hands that token to Claude Code. No secret is
 *    stored; the organization trusts this server's issuer in the Claude
 *    Console.
 *
 * API accounts serve only the models a subscription cannot (Mythos, which
 * Anthropic offers to verified API organizations), so metered API spend never
 * replaces subscription capacity.
 */

import { createHash } from "crypto";

/** Loaded on first use: the account store imports this module, and has no
 *  business pulling the identity issuer (and its sandbox config) into every
 *  importer's graph. */
const identity = () => import("./workload-identity");

export const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
/** The `sub` of every ID token this server presents to Anthropic. */
export const CLAUDE_FEDERATION_SUBJECT = "opensession:claude-api";
/** The `aud` of every ID token this server presents to Anthropic. */
export const CLAUDE_FEDERATION_AUDIENCE = CLAUDE_API_BASE_URL;

const TOKEN_ENDPOINT = "/v1/oauth/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const FEDERATION_BETAS = "oauth-2025-04-20,oidc-federation-2026-04-01";
/** Anthropic caps a minted token at twice the ID token's remaining lifetime,
 *  so an hour-long ID token lets a rule's lifetime of up to two hours apply. */
const IDENTITY_TOKEN_TTL_SECONDS = 60 * 60;
/** Re-exchange this long before expiry (or at half the lifetime, for a short
 *  rule), so a turn never starts on a token that expires mid-response. */
const MAX_REFRESH_MARGIN_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 15_000;

export type ClaudeApiAuthKind = "api-key" | "federation";

export interface ClaudeFederation {
  organizationId: string;
  federationRuleId: string;
  serviceAccountId: string;
  /** `wrkspc_…` or "default"; needed when the rule covers several workspaces. */
  workspaceId?: string;
}

interface CredentialAccount {
  id: string;
  token: string;
  authKind?: string;
  federation?: ClaudeFederation;
}

export function isClaudeApiAccount(account: { authKind?: string }): boolean {
  return account.authKind === "api-key" || account.authKind === "federation";
}

/** Models only Claude API accounts serve: Mythos is offered to verified API
 *  organizations, not Claude subscriptions. */
export function isClaudeApiOnlyModel(model?: string | null): boolean {
  return !!model && model.toLowerCase().includes("mythos");
}

/** The Mythos releases, by Models API id. An API account serves one only
 *  after a Models API check shows its organization can use it. */
export const CLAUDE_MYTHOS_MODELS = [
  "claude-mythos-5-2",
  "claude-mythos-5-1",
] as const;

/** The Mythos release a model id (bare or `pi/anthropic/…`) names. */
export function claudeMythosModelOf(model?: string | null): string | undefined {
  const m = model?.toLowerCase();
  return m ? CLAUDE_MYTHOS_MODELS.find((id) => m.includes(id)) : undefined;
}

/** What a Mythos access check found: the releases the organization can use,
 *  and whether every answer was definite. An inconclusive check (network
 *  error, 5xx, rate limit, failed token exchange) proves nothing either way. */
export interface ClaudeMythosAccess {
  models: string[];
  conclusive: boolean;
}

/**
 * Ask the Models API which Mythos releases this account's organization can
 * use. A 200 grants a release, a 403 or 404 denies it, and anything else
 * leaves the check inconclusive.
 */
export async function checkClaudeMythosAccess(
  account: CredentialAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeMythosAccess> {
  let headers: Record<string, string>;
  try {
    if (account.authKind === "api-key") {
      headers = { "x-api-key": account.token };
    } else if (account.authKind === "federation" && account.federation) {
      const token = await federatedAccessToken(
        account.id,
        account.federation,
        fetchImpl,
      );
      headers = {
        authorization: `Bearer ${token.token}`,
        "anthropic-beta": "oauth-2025-04-20",
      };
    } else {
      return { models: [], conclusive: true };
    }
  } catch {
    return { models: [], conclusive: false };
  }
  const models: string[] = [];
  let conclusive = true;
  for (const id of CLAUDE_MYTHOS_MODELS) {
    try {
      const res = await fetchImpl(`${CLAUDE_API_BASE_URL}/v1/models/${id}`, {
        headers: { ...headers, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      if (res.ok) models.push(id);
      else if (res.status !== 403 && res.status !== 404) conclusive = false;
    } catch {
      conclusive = false;
    }
  }
  return { models, conclusive };
}

export interface ClaudeFederationSetup {
  issuer: string;
  jwksUrl: string;
  /** The public key set, for an issuer Anthropic cannot reach (a private or
   *  plain-HTTP base URL): the Console accepts it pasted inline. */
  jwks: string;
  /** Whether Anthropic can fetch the issuer's discovery document itself. */
  publicIssuer: boolean;
  subject: string;
  audience: string;
}

/** The values to enter in the Claude Console when trusting this server. */
export async function claudeFederationSetup(): Promise<ClaudeFederationSetup> {
  const { workloadIdentityIssuer, workloadIdentityJwks } = await identity();
  const issuer = workloadIdentityIssuer();
  let host = "";
  let https = false;
  try {
    const url = new URL(issuer);
    host = url.hostname;
    https = url.protocol === "https:";
  } catch {}
  const privateHost =
    host === "localhost" ||
    /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      host,
    ) ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".ts.net");
  return {
    issuer,
    jwksUrl: `${issuer}/jwks.json`,
    jwks: JSON.stringify(await workloadIdentityJwks()),
    publicIssuer: https && !privateHost,
    subject: CLAUDE_FEDERATION_SUBJECT,
    audience: CLAUDE_FEDERATION_AUDIENCE,
  };
}

/** Normalize and validate a federation config from a form or request body. */
export function parseClaudeFederation(
  input: unknown,
): ClaudeFederation | { error: string } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const text = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
  const organizationId = text("organizationId");
  const federationRuleId = text("federationRuleId");
  const serviceAccountId = text("serviceAccountId");
  const workspaceId = text("workspaceId");
  if (!/^[0-9a-f-]{36}$/i.test(organizationId))
    return { error: "Organization ID should be a UUID" };
  if (!/^fdrl_[A-Za-z0-9]+$/.test(federationRuleId))
    return { error: "Federation rule ID should start with fdrl_" };
  if (!/^svac_[A-Za-z0-9]+$/.test(serviceAccountId))
    return { error: "Service account ID should start with svac_" };
  if (workspaceId && !/^(?:wrkspc_[A-Za-z0-9]+|default)$/.test(workspaceId))
    return { error: 'Workspace ID should start with wrkspc_ or be "default"' };
  return {
    organizationId,
    federationRuleId,
    serviceAccountId,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export interface FederatedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  lifetimeMs: number;
}

/** Keep the response's error, never anything that could be a credential. */
function exchangeError(status: number, body: string): string {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    detail =
      typeof error === "string"
        ? [error, parsed?.error_description].filter(Boolean).join(": ")
        : [error?.type, error?.message].filter(Boolean).join(": ") || detail;
  } catch {}
  detail = detail.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…");
  const hint =
    status === 401 || status === 403
      ? " Check that the federation rule trusts this server's issuer and subject; the Claude Console's Workload identity page lists each failed exchange."
      : "";
  return `Anthropic token exchange failed (${status})${detail ? `: ${detail}` : ""}.${hint}`;
}

/** One RFC 7523 exchange with a freshly signed ID token. */
export async function exchangeFederatedToken(
  federation: ClaudeFederation,
  fetchImpl: typeof fetch = fetch,
): Promise<FederatedToken> {
  const { signServerIdentityToken } = await identity();
  const assertion = await signServerIdentityToken({
    subject: CLAUDE_FEDERATION_SUBJECT,
    audience: CLAUDE_FEDERATION_AUDIENCE,
    ttlSeconds: IDENTITY_TOKEN_TTL_SECONDS,
  });
  const body: Record<string, string> = {
    grant_type: JWT_BEARER_GRANT,
    assertion,
    federation_rule_id: federation.federationRuleId,
    organization_id: federation.organizationId,
    service_account_id: federation.serviceAccountId,
  };
  if (federation.workspaceId) body.workspace_id = federation.workspaceId;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${CLAUDE_API_BASE_URL}${TOKEN_ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": FEDERATION_BETAS,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Could not reach Anthropic's token endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(exchangeError(res.status, text));
  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Anthropic's token endpoint returned invalid JSON");
  }
  const expiresIn = Number(parsed.expires_in);
  if (typeof parsed.access_token !== "string" || !Number.isFinite(expiresIn))
    throw new Error("Anthropic's token endpoint returned no access token");
  const lifetimeMs = Math.max(0, expiresIn * 1_000);
  return {
    token: parsed.access_token,
    expiresAt: started + lifetimeMs,
    lifetimeMs,
  };
}

const g = globalThis as typeof globalThis & {
  __claudeFederatedTokens?: Map<string, FederatedToken>;
  __claudeFederatedExchanges?: Map<string, Promise<FederatedToken>>;
};

function tokens(): Map<string, FederatedToken> {
  return (g.__claudeFederatedTokens ??= new Map());
}

function exchanges(): Map<string, Promise<FederatedToken>> {
  return (g.__claudeFederatedExchanges ??= new Map());
}

function cacheKey(accountId: string, federation: ClaudeFederation): string {
  return `${accountId}:${JSON.stringify(federation)}`;
}

function fresh(token: FederatedToken | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const margin = Math.min(MAX_REFRESH_MARGIN_MS, token.lifetimeMs / 2);
  return token.expiresAt - now > margin;
}

/** The account's current access token, exchanged once per refresh window and
 *  shared by every run on the account. */
export async function federatedAccessToken(
  accountId: string,
  federation: ClaudeFederation,
  fetchImpl?: typeof fetch,
): Promise<FederatedToken> {
  const key = cacheKey(accountId, federation);
  const cached = tokens().get(key);
  if (fresh(cached)) return cached!;
  const pending = exchanges().get(key);
  if (pending) return pending;
  const exchange = exchangeFederatedToken(federation, fetchImpl)
    .then((token) => {
      tokens().set(key, token);
      return token;
    })
    .finally(() => exchanges().delete(key));
  exchanges().set(key, exchange);
  return exchange;
}

/** Drop an account's cached access tokens (removal, config change). */
export function forgetFederatedTokens(accountId: string): void {
  for (const key of [...tokens().keys()])
    if (key.startsWith(`${accountId}:`)) tokens().delete(key);
}

/** A credential's identity without the credential. */
function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/**
 * Claude Code environment that authenticates as this account, and a key that
 * changes whenever that credential does. A long-lived SDK conversation started
 * with an older key must restart (it resumes from its session file), because
 * the Claude Code process reads its credential once at spawn.
 *
 * A federated token rides CLAUDE_CODE_OAUTH_TOKEN: Claude Code then sends it
 * as a Bearer token with the `oauth-2025-04-20` beta, which is exactly how
 * Anthropic's SDKs send a federated token. ANTHROPIC_AUTH_TOKEN would omit
 * that beta.
 */
export async function claudeCodeAuth(
  account: CredentialAccount,
  fetchImpl?: typeof fetch,
): Promise<{ env: Record<string, string>; key: string }> {
  if (account.authKind === "api-key") {
    return {
      env: { ANTHROPIC_API_KEY: account.token },
      key: `api-key:${digest(account.token)}`,
    };
  }
  if (account.authKind === "federation") {
    if (!account.federation)
      throw new Error("Claude API account has no federation settings");
    const token = await federatedAccessToken(
      account.id,
      account.federation,
      fetchImpl,
    );
    return {
      env: { CLAUDE_CODE_OAUTH_TOKEN: token.token },
      key: `federation:${digest(token.token)}`,
    };
  }
  return {
    env: { CLAUDE_CODE_OAUTH_TOKEN: account.token },
    key: "subscription",
  };
}

/** Check an API key against the Models API. Only a 401 proves it bad. */
export async function validateClaudeApiKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ error?: string }> {
  try {
    const res = await fetchImpl(`${CLAUDE_API_BASE_URL}/v1/models?limit=1`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (res.status === 401) return { error: "Anthropic rejected this API key" };
    return {};
  } catch {
    return {};
  }
}
