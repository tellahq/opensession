import type { WebIdentity } from "./web-auth";

/** Only a GitHub GET /user result may populate this value. Never derive it
 * from a login, roster row, request body, or a legacy cookie. */
export function githubAccountId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export type PersonalPrincipal = `github:${number}`;

/** Caller supplies the server-resolved cookie identity, not request JSON.
 * Old sessions retain shared access but must sign in again for a stable id. */
export function personalPrincipal(
  identity: WebIdentity | null | undefined,
): PersonalPrincipal | null {
  if (!identity || identity.automation) return null;
  const id = githubAccountId(identity.githubAccountId);
  return id === undefined ? null : `github:${id}`;
}

/** No deployed backend currently qualifies. This is deliberately not a config
 * toggle or the existing per-run sandbox qualification: other host runs share
 * the gateway uid and can read its credentials and private projections.
 * Replace this denial only with broker/storage/execution attestation AND the
 * catalog/delivery authorization gates. Do not add an environment override. */
export function personalAdmission(): {
  available: false;
  code: "personal_isolation_unavailable";
  error: string;
} {
  return {
    available: false,
    code: "personal_isolation_unavailable",
    error:
      "Personal repositories are unavailable until private storage, credentials, and execution are isolated from all host runs and owner-only access is enforced.",
  };
}
