/**
 * xAI (SuperGrok) OAuth and cli-chat-proxy helpers for the xAI account pool.
 *
 * Pure network and parsing code, no store access. xai-accounts.ts owns the
 * credential store and picks accounts; xai-device-login.ts drives the
 * interactive sign-in; this module talks to xAI.
 *
 * Wire details follow stnly/pi-grok v0.10.1 (MIT), the reference the feature
 * request named: device-code OAuth against auth.x.ai with the Grok CLI client
 * id, and every subscription call (inference, catalog, account, billing)
 * routed through cli-chat-proxy.grok.com so it draws on SuperGrok quota, not
 * billed API credits. Requests carry the proxy's client identity headers; the
 * proxy rejects a version it does not admit.
 */

import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";

export { XAI_OAUTH_PROVIDER };

const ISSUER = "https://auth.x.ai";
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
// conversations:* lets the proxy attach server-side history to x-grok-conv-id.
const SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const CLIENT_VERSION = "0.2.101";
const CLIENT_IDENTIFIER = "grok-shell";

/** Every subscription request rides the CLI proxy, never api.x.ai. */
export const XAI_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** Refresh five minutes before the token actually dies. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const AUTH_TIMEOUT_MS = 15_000;
const PROXY_TIMEOUT_MS = 15_000;
/** Reject bodies past this size before parsing; auth and account payloads are tiny. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface XaiOAuthTokens {
  access: string;
  refresh: string;
  /** ms epoch when the access token should be considered spent (skewed). */
  expires: number;
  idToken?: string;
}

export interface XaiDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type XaiDevicePoll =
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds?: number }
  | { status: "complete"; tokens: XaiOAuthTokens }
  | { status: "failed"; message: string; fatal: boolean };

export class XaiOAuthError extends Error {
  constructor(
    message: string,
    /** True when only a fresh sign-in can fix it (revoked refresh token, denied). */
    public readonly reloginRequired = false,
  ) {
    super(message);
    this.name = "XaiOAuthError";
  }
}

function platformLabel(): string {
  const os =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform;
  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : process.arch;
  return `${os}; ${arch}`;
}

/** Identity headers the cli-chat-proxy gates on. `modelId` adds the routing
 * override an inference request needs; account and catalog calls omit it. */
export function xaiProxyHeaders(modelId?: string): Record<string, string> {
  return {
    "User-Agent": `${CLIENT_IDENTIFIER}/${CLIENT_VERSION} (${platformLabel()})`,
    "x-grok-client-identifier": CLIENT_IDENTIFIER,
    "x-grok-client-version": CLIENT_VERSION,
    "x-grok-client-mode": "interactive",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    ...(modelId ? { "x-grok-model-override": modelId } : {}),
  };
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "x-grok-client-version": CLIENT_VERSION,
    "x-grok-client-surface": "cli",
  };
}

async function readBoundedText(res: Response): Promise<string> {
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`xAI response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  return text;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await readBoundedText(res);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("xAI response was not a JSON object");
  }
  // SAFETY: checked to be a non-array object above; field shapes are validated by callers.
  return parsed as Record<string, unknown>;
}

async function readErrorCode(res: Response): Promise<string> {
  const text = await readBoundedText(res).catch(() => "");
  try {
    const parsed: unknown = JSON.parse(text);
    const error =
      parsed && typeof parsed === "object" && "error" in parsed
        ? parsed.error
        : undefined;
    return typeof error === "string" ? error : "";
  } catch {
    return "";
  }
}

/** Short, user-safe label for a failed authenticated call. Upstream bodies
 * can carry trace ids and internal hints, so they never land in a message. */
export function xaiStatusLabel(status: number): {
  label: string;
  fatal: boolean;
} {
  if (status === 401 || status === 403)
    return { label: "authentication rejected", fatal: true };
  if (status === 404) return { label: "endpoint unavailable", fatal: false };
  if (status === 429) return { label: "rate limited", fatal: false };
  if (status >= 500) return { label: "upstream error", fatal: false };
  return { label: `HTTP ${status}`, fatal: false };
}

// ── JWT helpers ─────────────────────────────────────────────────────────────

export function decodeJwtClaims(
  token: string | undefined,
): Record<string, unknown> | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? // SAFETY: checked to be a non-array object.
        (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** ms epoch from a JWT's `exp`, or null for an opaque token. */
export function jwtExpMs(token: string | undefined): number | null {
  const exp = decodeJwtClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

export function jwtEmail(token: string | undefined): string | undefined {
  const email = decodeJwtClaims(token)?.email;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

/** Stored expiry: the shorter of `expires_in` and the access token's own
 * `exp`, both minus the refresh skew, so a clock-drifted issuer never leaves
 * us holding a token past its real death. */
export function computeExpires(access: string, expiresInS: number): number {
  const fromExpiresIn = Date.now() + expiresInS * 1000 - REFRESH_SKEW_MS;
  const exp = jwtExpMs(access);
  return exp === null
    ? fromExpiresIn
    : Math.min(fromExpiresIn, exp - REFRESH_SKEW_MS);
}

export function tokensFromResponse(
  body: Record<string, unknown>,
  previousRefresh?: string,
): XaiOAuthTokens {
  const access = typeof body.access_token === "string" ? body.access_token : "";
  if (!access) throw new XaiOAuthError("xAI did not return an access token");
  const refresh =
    typeof body.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      : previousRefresh || "";
  if (!refresh) throw new XaiOAuthError("xAI did not return a refresh token");
  const expiresIn =
    typeof body.expires_in === "number" && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_TOKEN_LIFETIME_S;
  const idToken = typeof body.id_token === "string" ? body.id_token : undefined;
  return {
    access,
    refresh,
    expires: computeExpires(access, expiresIn),
    ...(idToken ? { idToken } : {}),
  };
}

// ── Device-code login ───────────────────────────────────────────────────────

export async function requestXaiDeviceCode(
  signal?: AbortSignal,
): Promise<XaiDeviceCode> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: "grok-build",
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(AUTH_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!res.ok) {
    const code = await readErrorCode(res);
    throw new XaiOAuthError(
      `xAI device-code request failed: ${code || xaiStatusLabel(res.status).label}`,
    );
  }
  const body = await readJson(res);
  const verificationUri =
    typeof body.verification_uri_complete === "string" &&
    body.verification_uri_complete
      ? body.verification_uri_complete
      : typeof body.verification_uri === "string"
        ? body.verification_uri
        : "";
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    throw new XaiOAuthError("xAI returned an unusable verification URL");
  }
  if (url.protocol !== "https:") {
    throw new XaiOAuthError("xAI returned an unusable verification URL");
  }
  const deviceCode =
    typeof body.device_code === "string" ? body.device_code : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  if (!deviceCode || !userCode) {
    throw new XaiOAuthError("xAI device-code response was incomplete");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: url.href,
    intervalSeconds:
      typeof body.interval === "number" && body.interval > 0
        ? body.interval
        : 5,
    expiresInSeconds:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : 900,
  };
}

/** One poll of the token endpoint for a pending device grant. */
export async function pollXaiDeviceToken(
  deviceCode: string,
  signal?: AbortSignal,
): Promise<XaiDevicePoll> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(AUTH_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]),
  });
  if (res.ok) {
    return {
      status: "complete",
      tokens: tokensFromResponse(await readJson(res)),
    };
  }
  const code = await readErrorCode(res);
  switch (code) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
    case "authorization_denied":
      return { status: "failed", message: "Sign-in was denied.", fatal: true };
    case "expired_token":
      return {
        status: "failed",
        message: "The device code expired. Start again.",
        fatal: true,
      };
    default:
      return {
        status: "failed",
        message: `xAI token exchange failed: ${code || xaiStatusLabel(res.status).label}`,
        fatal: false,
      };
  }
}

// ── Refresh ─────────────────────────────────────────────────────────────────

export async function refreshXaiTokens(
  refresh: string,
  signal?: AbortSignal,
): Promise<XaiOAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh,
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(AUTH_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!res.ok) {
    // The OAuth error code, not the HTTP status, says whether a re-login is
    // needed: invalid_grant/invalid_client are terminal, a 5xx blip is not.
    const code = await readErrorCode(res);
    const fatal = code === "invalid_grant" || code === "invalid_client";
    throw new XaiOAuthError(
      `xAI token refresh failed: ${code || xaiStatusLabel(res.status).label}`,
      fatal,
    );
  }
  return tokensFromResponse(await readJson(res), refresh);
}

// ── Proxy account and usage endpoints ───────────────────────────────────────

export interface XaiUser {
  userId: string;
  email?: string;
  name?: string;
  teamName?: string;
  organizationName?: string;
  hasGrokCodeAccess?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function fetchXaiUser(access: string): Promise<XaiUser> {
  const res = await fetch(`${XAI_CLI_PROXY_BASE_URL}/user`, {
    headers: { Authorization: `Bearer ${access}`, ...xaiProxyHeaders() },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  if (!res.ok) {
    await readBoundedText(res).catch(() => undefined);
    const { label, fatal } = xaiStatusLabel(res.status);
    throw new XaiOAuthError(`xAI account lookup failed: ${label}`, fatal);
  }
  const body = await readJson(res);
  const userId = str(body.userId);
  if (!userId || !/^[\x21-\x7e]{1,256}$/.test(userId)) {
    throw new XaiOAuthError("xAI account lookup returned no user id");
  }
  const name = [str(body.firstName), str(body.lastName)]
    .filter(Boolean)
    .join(" ");
  return {
    userId,
    ...(str(body.email) ? { email: str(body.email) } : {}),
    ...(name ? { name } : {}),
    ...(str(body.teamName) ? { teamName: str(body.teamName) } : {}),
    ...(str(body.organizationName)
      ? { organizationName: str(body.organizationName) }
      : {}),
    ...(typeof body.hasGrokCodeAccess === "boolean"
      ? { hasGrokCodeAccess: body.hasGrokCodeAccess }
      : {}),
  };
}

/** Subscription credit usage, derived from the proxy's unofficial
 * `/billing?format=credits`. Every field is optional because the endpoint's
 * shape varies; the UI renders what came back. Cents are integers. */
export interface XaiUsageSnapshot {
  fetchedAt: string;
  subscriptionTier?: string;
  creditUsagePercent?: number;
  usedCents?: number;
  monthlyLimitCents?: number;
  onDemandEnabled?: boolean;
  onDemandUsedCents?: number;
  onDemandCapCents?: number;
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  productUsage?: Array<{ product: string; usagePercent: number }>;
  error?: string;
}

const MAX_CENTS = 1_000_000_000_000;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? // SAFETY: checked to be a non-array object.
      (value as Record<string, unknown>)
    : undefined;
}

function asCents(value: unknown): number | undefined {
  const cents = asObject(value)?.val;
  return typeof cents === "number" &&
    Number.isSafeInteger(cents) &&
    cents >= 0 &&
    cents <= MAX_CENTS
    ? cents
    : undefined;
}

function asPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : undefined;
}

function asTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function asLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed))
    return undefined;
  return trimmed;
}

/** Pure: parse a billing body into a snapshot. Throws on a shape that cannot
 * be a billing response so the caller records an error instead of rendering
 * an empty, misleading meter. */
export function parseXaiUsageBody(
  body: unknown,
  fetchedAt = new Date().toISOString(),
): XaiUsageSnapshot {
  const root = asObject(body);
  if (!root) throw new Error("xAI usage returned an invalid response");
  if (
    root.config !== undefined &&
    root.config !== null &&
    !asObject(root.config)
  )
    throw new Error("xAI usage returned an invalid response");
  const snapshot: XaiUsageSnapshot = { fetchedAt };
  const tier = asLabel(root.subscriptionTier);
  if (tier) snapshot.subscriptionTier = tier;
  if (typeof root.onDemandEnabled === "boolean")
    snapshot.onDemandEnabled = root.onDemandEnabled;
  const config = asObject(root.config);
  if (!config) return snapshot;
  const percent = asPercent(config.creditUsagePercent);
  const used = asCents(config.used);
  const limit = asCents(config.monthlyLimit);
  const onDemandUsed = asCents(config.onDemandUsed);
  const onDemandCap = asCents(config.onDemandCap);
  if (percent !== undefined) snapshot.creditUsagePercent = percent;
  else if (used !== undefined && limit !== undefined && limit > 0)
    snapshot.creditUsagePercent = Math.min(100, (used / limit) * 100);
  if (used !== undefined) snapshot.usedCents = used;
  if (limit !== undefined) snapshot.monthlyLimitCents = limit;
  if (onDemandUsed !== undefined) snapshot.onDemandUsedCents = onDemandUsed;
  if (onDemandCap !== undefined) snapshot.onDemandCapCents = onDemandCap;
  const period = asObject(config.currentPeriod);
  const periodType = asLabel(period?.type);
  const periodStart =
    asTimestamp(period?.start) ?? asTimestamp(config.billingPeriodStart);
  const periodEnd =
    asTimestamp(period?.end) ?? asTimestamp(config.billingPeriodEnd);
  if (periodType) snapshot.periodType = periodType;
  if (periodStart) snapshot.periodStart = periodStart;
  if (periodEnd) snapshot.periodEnd = periodEnd;
  if (Array.isArray(config.productUsage)) {
    const productUsage = config.productUsage.flatMap((entry: unknown) => {
      const row = asObject(entry);
      const product = asLabel(row?.product);
      const usagePercent = asPercent(row?.usagePercent);
      return product && usagePercent !== undefined
        ? [{ product, usagePercent }]
        : [];
    });
    if (productUsage.length) snapshot.productUsage = productUsage;
  }
  return snapshot;
}

export async function fetchXaiUsage(access: string): Promise<XaiUsageSnapshot> {
  const user = await fetchXaiUser(access);
  const res = await fetch(`${XAI_CLI_PROXY_BASE_URL}/billing?format=credits`, {
    headers: {
      Authorization: `Bearer ${access}`,
      "x-userid": user.userId,
      ...xaiProxyHeaders(),
    },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  if (!res.ok) {
    await readBoundedText(res).catch(() => undefined);
    const { label, fatal } = xaiStatusLabel(res.status);
    throw new XaiOAuthError(`xAI billing lookup failed: ${label}`, fatal);
  }
  return parseXaiUsageBody(await readJson(res));
}

// ── Live model catalog ──────────────────────────────────────────────────────

export interface XaiCatalogEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsReasoningEffort?: boolean;
}

function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.startsWith("grok") &&
    !lower.includes("imagine") &&
    !lower.includes("embedding") &&
    !lower.includes("tts")
  );
}

/** Pure: keep the chat models of a `/models` body, in the proxy's order. */
export function parseXaiCatalogBody(body: unknown): XaiCatalogEntry[] {
  const data = asObject(body)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry: unknown) => {
    const row = asObject(entry);
    const id = str(row?.id);
    if (!id || id.length > 120 || !isChatModelId(id)) return [];
    const contextWindow =
      typeof row?.context_window === "number"
        ? row.context_window
        : typeof row?.context_length === "number"
          ? row.context_length
          : undefined;
    return [
      {
        id,
        ...(asLabel(row?.name) ? { name: asLabel(row?.name) } : {}),
        ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
        ...(typeof row?.max_output_tokens === "number" &&
        row.max_output_tokens > 0
          ? { maxTokens: row.max_output_tokens }
          : {}),
        ...(typeof row?.supports_reasoning_effort === "boolean"
          ? { supportsReasoningEffort: row.supports_reasoning_effort }
          : {}),
      },
    ];
  });
}

export async function fetchXaiCatalog(
  access: string,
): Promise<XaiCatalogEntry[]> {
  const res = await fetch(`${XAI_CLI_PROXY_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${access}`, ...xaiProxyHeaders() },
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  if (!res.ok) {
    await readBoundedText(res).catch(() => undefined);
    const { label, fatal } = xaiStatusLabel(res.status);
    throw new XaiOAuthError(`xAI catalog fetch failed: ${label}`, fatal);
  }
  return parseXaiCatalogBody(await readJson(res));
}
