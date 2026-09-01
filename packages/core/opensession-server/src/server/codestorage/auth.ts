/**
 * code.storage JWT minting (https://code.storage/docs/getting-started/authentication.md).
 *
 * Tokens are customer-signed: we hold a PKCS8 PEM private key
 * (`integrations.codeStorage.privateKeyPath`) whose public half is registered
 * with code.storage, and sign short-lived JWTs locally — there is no token
 * endpoint to call. ES256 (P-256) and RS256 keys are supported; the algorithm
 * is detected from whichever WebCrypto import succeeds.
 *
 * Everything here is inert until `integrations.codeStorage` is configured
 * (codeStorageConfig() returns non-null).
 */

import { readFileSync, statSync } from "fs";
import { codeStorageConfig } from "../config";

export type CsScope = "git:read" | "git:write" | "repo:write" | "org:read";

export interface MintCsJwtOptions {
  /** JWT `iss` — the code.storage organization identifier. */
  org: string;
  /** JWT `repo` claim — the repo id/path. Omit for org-wide tokens (org:read). */
  repo?: string;
  scopes: CsScope[];
  /** Token lifetime; default 1 hour. */
  ttlSeconds?: number;
  /** JWT `sub` — agent identity, for the host's logs. Default "opensession". */
  sub?: string;
}

export type ImportedKey = { key: CryptoKey; alg: "ES256" | "RS256" };

// Key import is not free (PEM decode + WebCrypto import per mint otherwise);
// cache by path+mtime like the config cache so key rotation is picked up.
let keyCache: { path: string; mtimeMs: number; imported: ImportedKey } | null =
  null;

function pemToDer(pem: string): ArrayBuffer {
  const bin = atob(
    pem.replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, ""),
  );
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Import a PKCS8 PEM private key via WebCrypto — ES256 (P-256) first, RS256
 * fallback, matching mintCsJwt's algorithm detection. Exported so the setup
 * flow (routes/setup-codestorage.ts) can validate a pasted key with the exact
 * logic that will later sign JWTs with it. Throws when the PEM is neither.
 */
export async function importPkcs8Pem(pem: string): Promise<ImportedKey> {
  const der = pemToDer(pem);
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return { key, alg: "ES256" };
  } catch {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return { key, alg: "RS256" };
  }
}

async function importPrivateKey(path: string): Promise<ImportedKey> {
  const st = statSync(path);
  if (keyCache && keyCache.path === path && keyCache.mtimeMs === st.mtimeMs) {
    return keyCache.imported;
  }
  const imported = await importPkcs8Pem(readFileSync(path, "utf-8"));
  keyCache = { path, mtimeMs: st.mtimeMs, imported };
  return imported;
}

const b64urlJson = (v: unknown): string =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

/** Sign a code.storage JWT with the configured private key. */
export async function mintCsJwt(opts: MintCsJwtOptions): Promise<string> {
  const cfg = codeStorageConfig();
  if (!cfg)
    throw new Error(
      "code.storage is not configured (integrations.codeStorage)",
    );
  const { key, alg } = await importPrivateKey(cfg.privateKeyPath);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: opts.org,
    sub: opts.sub || "opensession",
    ...(opts.repo ? { repo: opts.repo } : {}),
    scopes: opts.scopes,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 3600),
  };
  const signingInput = `${b64urlJson({ alg, typ: "JWT" })}.${b64urlJson(payload)}`;
  // For ES256, WebCrypto returns the raw r||s concatenation — already the JOSE
  // signature format, so no DER re-encoding here.
  const sig = await crypto.subtle.sign(
    alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}

/**
 * Credential-free HTTPS remote for a code.storage repo. `ephemeral: true`
 * targets the repo's disposable ref namespace (`…/<repoId>+ephemeral.git` —
 * https://code.storage/docs/guides/ephemeral-branches.md).
 */
export function remoteUrl(
  org: string,
  repoId: string,
  opts?: { ephemeral?: boolean },
): string {
  return `https://${org}.code.storage/${repoId}${opts?.ephemeral ? "+ephemeral" : ""}.git`;
}

/**
 * HTTPS remote with embedded credentials (username literally "t", password a
 * freshly minted JWT). Prefer the credential helper (remote.ts) for anything
 * long-lived — this URL carries a token that expires. `ephemeral: true`
 * appends `+ephemeral` before `.git`; the JWT `repo` claim stays the bare
 * repoId either way — an ephemeral remote is the same repository behind a
 * different ref namespace (the auth docs scope tokens per repository and say
 * nothing about a namespace suffix in the claim, so bare is the assumption).
 */
export async function authedRemoteUrl(
  repoId: string,
  opts?: {
    org?: string;
    scopes?: CsScope[];
    ttlSeconds?: number;
    ephemeral?: boolean;
  },
): Promise<string> {
  const cfg = codeStorageConfig();
  if (!cfg)
    throw new Error(
      "code.storage is not configured (integrations.codeStorage)",
    );
  const org = opts?.org || cfg.org;
  const jwt = await mintCsJwt({
    org,
    repo: repoId,
    scopes: opts?.scopes ?? ["git:read", "git:write"],
    ttlSeconds: opts?.ttlSeconds,
  });
  return `https://t:${jwt}@${org}.code.storage/${repoId}${opts?.ephemeral ? "+ephemeral" : ""}.git`;
}
