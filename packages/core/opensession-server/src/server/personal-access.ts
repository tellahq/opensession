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

/** A connection acknowledgement is not admission. Routes consult the installed
 * coordinator capability; this is their fail-closed response when it is absent. */
export function personalAdmission(): {
  available: false;
  code: "personal_repository_admission_unavailable";
  error: string;
} {
  return {
    available: false,
    code: "personal_repository_admission_unavailable",
    error:
      "Personal repository access is unavailable until catalog and runtime coordination are ready.",
  };
}
