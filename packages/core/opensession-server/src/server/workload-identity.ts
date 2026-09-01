/**
 * OIDC workload identity for sandbox processes.
 *
 * A sandbox receives an opaque, server-registered exchange lease. The lease is
 * not an identity token and is useful only at this server's token endpoint.
 * The endpoint derives all claims from the lease, signs a short-lived RS256
 * ID token, and exposes ordinary OIDC discovery + JWKS documents so a relying
 * service can verify it without an OpenSession-specific SDK.
 *
 * The lease is injected only into OpenSession-managed sandbox commands. It is
 * deliberately memory-only: an OpenSession restart, sandbox destruction, or
 * lease expiry revokes it. Repositories may retain a minted ID token, so keep
 * token TTLs short and make trust policies restrict immutable claims.
 */

import { randomUUID, timingSafeEqual } from "crypto";
import { existsSync, readFileSync } from "fs";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { remoteSandboxCallbackBaseUrl } from "./sandbox/config";

const IDENTITY_PATH = "/workload-identity";
const KEY_PATH = stateDir("workload-identity-key.json");
const DEFAULT_TOKEN_TTL_SECONDS = 10 * 60;
const MIN_TOKEN_TTL_SECONDS = 60;
const MAX_TOKEN_TTL_SECONDS = 60 * 60;
const LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_LEASES = 10_000;

export type WorkloadLifecycle =
  | "setup"
  | "resume"
  | "preview"
  | "run"
  | "prewarm";

export interface WorkloadIdentityContext {
  sandboxId: string;
  provider: string;
  lifecycle: WorkloadLifecycle;
  sessionId?: string;
  repoId?: string;
  userId?: string;
  trustProfile?: "interactive" | "automation";
}

interface Lease extends WorkloadIdentityContext {
  expiresAt: number;
  audiences: string[];
}

interface AudienceGrant {
  repoId?: string;
  lifecycle?: WorkloadLifecycle;
  trustProfile?: "interactive" | "automation";
  audiences: string[];
}

interface StoredKey {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
  kid: string;
}

const g = globalThis as typeof globalThis & {
  __opensessionWorkloadIdentityLeases?: Map<string, Lease>;
  __opensessionWorkloadIdentityKey?: Promise<StoredKey>;
};

function leases(): Map<string, Lease> {
  return (g.__opensessionWorkloadIdentityLeases ??= new Map());
}

function base64Url(bytes: ArrayBuffer | Uint8Array | string): string {
  const value =
    typeof bytes === "string"
      ? Buffer.from(bytes)
      : bytes instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(bytes))
        : Buffer.from(bytes);
  return value.toString("base64url");
}

function identityBaseUrl(): string {
  return remoteSandboxCallbackBaseUrl()
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/+$/, "");
}

/** The exact OIDC issuer external relying parties configure. */
export function workloadIdentityIssuer(): string {
  return `${identityBaseUrl()}${IDENTITY_PATH}`;
}

function keyId(publicKey: JsonWebKey): string {
  return base64Url(
    new TextEncoder().encode(
      JSON.stringify({ e: publicKey.e, kty: publicKey.kty, n: publicKey.n }),
    ),
  ).slice(0, 32);
}

async function loadKey(): Promise<StoredKey> {
  if (existsSync(KEY_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(KEY_PATH, "utf8")) as StoredKey;
      if (
        parsed.privateKey?.kty === "RSA" &&
        parsed.publicKey?.kty === "RSA" &&
        parsed.kid
      ) {
        return parsed;
      }
    } catch {
      // A corrupt key must not be silently replaced: that would invalidate a
      // published issuer without an operator noticing.
      throw new Error(
        `Cannot read workload identity signing key at ${KEY_PATH}`,
      );
    }
    throw new Error(`Invalid workload identity signing key at ${KEY_PATH}`);
  }
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const stored = { privateKey, publicKey, kid: keyId(publicKey) };
  writeJsonAtomic(KEY_PATH, stored, true, 0o600);
  return stored;
}

async function signingKey(): Promise<StoredKey> {
  return (g.__opensessionWorkloadIdentityKey ??= loadKey());
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validAudience(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f\s]/.test(value)
  );
}

function configuredAudiences(context: WorkloadIdentityContext): string[] {
  const raw = process.env.OPENSESSION_WORKLOAD_IDENTITY_GRANTS;
  if (!raw) return [];
  let grants: unknown;
  try {
    grants = JSON.parse(raw);
  } catch {
    console.warn(
      "[workload-identity] OPENSESSION_WORKLOAD_IDENTITY_GRANTS is not valid JSON",
    );
    return [];
  }
  if (!Array.isArray(grants)) {
    console.warn(
      "[workload-identity] OPENSESSION_WORKLOAD_IDENTITY_GRANTS must be a JSON array",
    );
    return [];
  }
  const allowed = new Set<string>();
  for (const candidate of grants) {
    if (!candidate || typeof candidate !== "object") continue;
    const grant = candidate as Partial<AudienceGrant>;
    if (
      (grant.repoId && grant.repoId !== context.repoId) ||
      (grant.lifecycle && grant.lifecycle !== context.lifecycle) ||
      (grant.trustProfile && grant.trustProfile !== context.trustProfile) ||
      !Array.isArray(grant.audiences)
    ) {
      continue;
    }
    for (const audience of grant.audiences)
      if (validAudience(audience)) allowed.add(audience);
  }
  return [...allowed];
}

function validTtl(value: unknown): number | null {
  if (value === undefined) return DEFAULT_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(value)) return null;
  const ttl = Number(value);
  return ttl >= MIN_TOKEN_TTL_SECONDS && ttl <= MAX_TOKEN_TTL_SECONDS
    ? ttl
    : null;
}

function subject(context: WorkloadIdentityContext): string {
  const pieces = [
    `sandbox:${context.sandboxId}`,
    `provider:${context.provider}`,
    context.repoId ? `repo:${context.repoId}` : null,
    context.userId ? `user:${context.userId}` : null,
    context.sessionId ? `session:${context.sessionId}` : null,
  ].filter((value): value is string => Boolean(value));
  return pieces.join(":");
}

async function signToken(
  context: WorkloadIdentityContext,
  audience: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const key = await signingKey();
  const header = base64Url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid }),
  );
  const claims: Record<string, string | number> = {
    iss: workloadIdentityIssuer(),
    aud: audience,
    sub: subject(context),
    iat: now,
    exp: now + ttlSeconds,
    jti: randomUUID(),
    sandbox_id: context.sandboxId,
    sandbox_provider: context.provider,
    lifecycle: context.lifecycle,
    token_use: "exchanged",
  };
  if (context.sessionId) claims.session_id = context.sessionId;
  if (context.repoId) claims.repo_id = context.repoId;
  if (context.userId) claims.user_id = context.userId;
  if (context.trustProfile) claims.trust_profile = context.trustProfile;
  const payload = base64Url(JSON.stringify(claims));
  const signed = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    key.privateKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${base64Url(signature)}`;
}

/**
 * Create an opaque exchange lease and the env a sandbox command needs to use
 * the bundled `opensession sandbox id-token` helper. The lease is never a
 * cloud credential and is deliberately not persisted into snapshots.
 */
export function createWorkloadIdentityEnv(
  context: WorkloadIdentityContext,
): Record<string, string> {
  const audiences = configuredAudiences(context);
  // Identity is opt-in per workload grant. A sandbox cannot choose an
  // arbitrary external audience merely because it is running OpenSession.
  if (audiences.length === 0) return {};
  const token = randomUUID();
  const now = Date.now();
  const table = leases();
  for (const [key, lease] of table) {
    if (lease.expiresAt <= now) table.delete(key);
  }
  while (table.size >= MAX_LEASES) {
    const oldest = table.keys().next().value;
    if (!oldest) break;
    table.delete(oldest);
  }
  table.set(token, { ...context, audiences, expiresAt: now + LEASE_TTL_MS });
  return {
    OPENSESSION_WORKLOAD_IDENTITY_URL: `${workloadIdentityIssuer()}/token`,
    OPENSESSION_WORKLOAD_IDENTITY_TOKEN: token,
  };
}

export function revokeWorkloadIdentityForSandbox(sandboxId: string): void {
  for (const [token, lease] of leases()) {
    if (lease.sandboxId === sandboxId) leases().delete(token);
  }
}

async function discovery(): Promise<Response> {
  const issuer = workloadIdentityIssuer();
  return Response.json({
    issuer,
    jwks_uri: `${issuer}/jwks.json`,
    token_endpoint: `${issuer}/token`,
    claims_supported: ["aud", "exp", "iat", "iss", "sub"],
    id_token_signing_alg_values_supported: ["RS256"],
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
  });
}

async function jwks(): Promise<Response> {
  const key = await signingKey();
  return Response.json({
    keys: [
      {
        kty: key.publicKey.kty,
        alg: "RS256",
        use: "sig",
        kid: key.kid,
        n: key.publicKey.n,
        e: key.publicKey.e,
      },
    ],
  });
}

async function token(req: Request): Promise<Response> {
  const authorization = req.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) return new Response("Unauthorized", { status: 401 });
  let lease: Lease | undefined;
  for (const [candidate, value] of leases()) {
    if (constantTimeEqual(candidate, bearer)) {
      lease = value;
      break;
    }
  }
  if (!lease || lease.expiresAt <= Date.now())
    return new Response("Unauthorized", { status: 401 });
  let body: { audience?: unknown; ttl_seconds?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!validAudience(body.audience))
    return new Response("Invalid audience", { status: 400 });
  if (!lease.audiences.includes(body.audience))
    return new Response("Forbidden audience", { status: 403 });
  const ttl = validTtl(body.ttl_seconds);
  if (ttl === null) {
    return new Response(
      `ttl_seconds must be an integer between ${MIN_TOKEN_TTL_SECONDS} and ${MAX_TOKEN_TTL_SECONDS}`,
      { status: 400 },
    );
  }
  return new Response(await signToken(lease, body.audience, ttl), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Handle the complete public OIDC surface, or return undefined for other paths. */
export async function handleWorkloadIdentityRequest(
  req: Request,
): Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  if (
    req.method === "GET" &&
    path === `${IDENTITY_PATH}/.well-known/openid-configuration`
  ) {
    return await discovery();
  }
  if (req.method === "GET" && path === `${IDENTITY_PATH}/jwks.json`)
    return await jwks();
  if (req.method === "POST" && path === `${IDENTITY_PATH}/token`)
    return await token(req);
  return undefined;
}

export const workloadIdentityPaths = {
  discovery: `${IDENTITY_PATH}/.well-known/openid-configuration`,
  jwks: `${IDENTITY_PATH}/jwks.json`,
  token: `${IDENTITY_PATH}/token`,
};
