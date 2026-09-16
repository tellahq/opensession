/** Resource ownership, not GitHub repository visibility or UI attribution. */
export type AccessScope =
  | { kind: "shared" }
  | { kind: "personal"; ownerGithubAccountId: number };

/** Server-resolved identity only. Never construct this from request JSON,
 * display names, repository owner strings, or an admin/tool capability. */
export type AccessPrincipal = { githubAccountId: number };

export function isGithubAccountId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Undefined is the legacy shared default. Any explicitly malformed scope is
 * denied, including null or an unknown future scope from a newer client. */
export function parseAccessScope(value: unknown): AccessScope | null {
  if (value === undefined) return { kind: "shared" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = value as Record<string, unknown>;
  if (scope.kind === "shared" && scope.ownerGithubAccountId === undefined)
    return { kind: "shared" };
  if (
    scope.kind === "personal" &&
    isGithubAccountId(scope.ownerGithubAccountId)
  )
    return {
      kind: "personal",
      ownerGithubAccountId: scope.ownerGithubAccountId,
    };
  return null;
}

export function canAccessScope(
  scope: unknown,
  principal?: AccessPrincipal,
): boolean {
  const parsed = parseAccessScope(scope);
  if (!parsed) return false;
  if (parsed.kind === "shared") return true;
  return (
    isGithubAccountId(principal?.githubAccountId) &&
    parsed.ownerGithubAccountId === principal.githubAccountId
  );
}

export function assertAccessPrincipal(
  principal: AccessPrincipal | undefined,
): void {
  if (principal !== undefined && !isGithubAccountId(principal?.githubAccountId))
    throw new Error("Invalid access principal");
}

/** Ownership is immutable, including when an old client omits a personal
 * scope during mutation. Shared resources cannot silently become personal. */
export function sameAccessScope(a: unknown, b: unknown): boolean {
  const left = parseAccessScope(a);
  const right = parseAccessScope(b);
  return (
    !!left &&
    !!right &&
    left.kind === right.kind &&
    (left.kind === "shared" ||
      (right.kind === "personal" &&
        left.ownerGithubAccountId === right.ownerGithubAccountId))
  );
}

/** Compatibility declaration only. Neither marker nor expected id grants access. */
export const PERSONAL_PRIVACY_PROTOCOL = "personal-v1";
export const PERSONAL_PRIVACY_HEADER = "X-OpenSession-Privacy";
export const EXPECTED_GITHUB_ACCOUNT_HEADER =
  "X-OpenSession-Expected-GitHub-Account-Id";
