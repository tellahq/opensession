/**
 * Pure GitHub App JWT construction. No ambient key path, config, or clock:
 * the caller (normally a broker implementation) supplies the PEM, issuer and
 * time. This is deliberately separate from github-app.ts, whose signer reads
 * the shared App's key from the instance state directory.
 */
import { createPrivateKey, createSign } from "node:crypto";

/** GitHub accepts at most 10 minutes of validity; keep 60s of clock skew. */
const JWT_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function validatePrivateKeyPem(pem: unknown): string | null {
  if (typeof pem !== "string") return null;
  const trimmed = pem.trim();
  if (!trimmed || trimmed.length > 16_384) return null;
  try {
    const key = createPrivateKey(trimmed);
    if (key.asymmetricKeyType !== "rsa") return null;
  } catch {
    return null;
  }
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

export function buildGithubAppJwt(input: {
  issuer: string;
  privateKeyPem: string;
  nowSeconds: number;
}): string {
  if (!input.issuer || /\s/.test(input.issuer))
    throw new Error("Invalid App JWT issuer");
  if (!Number.isFinite(input.nowSeconds))
    throw new Error("Invalid App JWT clock");
  const now = Math.floor(input.nowSeconds);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({
    iat: now - JWT_SKEW_SECONDS,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: input.issuer,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(input.privateKeyPem)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

/** Test/verification helper: the decoded payload of a JWT built above. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
