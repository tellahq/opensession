import { z } from "zod";
import {
  PERSONAL_PRIVACY_PROTOCOL,
  PERSONAL_PRIVACY_HEADER,
  EXPECTED_GITHUB_ACCOUNT_HEADER,
} from "../../shared/access-scope";
/** Verified browser data lifetime. Display names are never private identities. */
export interface ClientDataScope {
  readonly key: string;
  readonly generation: number;
  readonly githubAccountId: number | null;
  readonly privacy: boolean;
}
export interface ClientDataIdentity {
  required: boolean;
  authenticated: boolean;
  githubAccountId?: number;
  login?: string;
}
let current: ClientDataScope | null = null;
let generation = 0;
let legacyLogin: string | undefined;
const listeners = new Set<() => void>();
export function captureClientDataScope(): ClientDataScope | null {
  return current;
}
export function isCurrentClientDataScope(
  scope: ClientDataScope | null,
): boolean {
  return scope !== null && scope === current;
}
export function subscribeClientDataScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishClientDataIdentity(
  identity: ClientDataIdentity | null,
): void {
  const id =
    identity?.required &&
    identity.authenticated &&
    Number.isSafeInteger(identity.githubAccountId) &&
    (identity.githubAccountId ?? 0) > 0
      ? identity.githubAccountId!
      : null;
  const key = !identity
    ? null
    : !identity.required
      ? "shared:local"
      : !identity.authenticated
        ? null
        : id
          ? `github-account:${id}`
          : "shared:legacy";
  const sameLegacy = key === "shared:legacy" && legacyLogin === identity?.login;
  if (
    ((key !== "shared:legacy" || sameLegacy) && key === current?.key) ||
    (!key && !current)
  )
    return;
  legacyLogin = key === "shared:legacy" ? identity?.login : undefined;
  generation++;
  current = key
    ? Object.freeze({
        key,
        generation,
        githubAccountId: id,
        privacy: id !== null,
      })
    : null;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // One broken cache subscriber must not prevent the app gate and the
      // remaining caches from invalidating the former principal.
      console.error("Client data scope subscriber failed", error);
    }
  }
}
export function clientDataScopeHeaders(
  scope: ClientDataScope | null,
): Record<string, string> {
  return scope?.privacy && scope.githubAccountId !== null
    ? {
        [PERSONAL_PRIVACY_HEADER]: PERSONAL_PRIVACY_PROTOCOL,
        "X-OpenSession-Expected-GitHub-Account-Id": String(
          scope.githubAccountId,
        ),
      }
    : {};
}
export function clientDataStorageKey(key: string): string | null {
  const scope = captureClientDataScope();
  if (!scope || scope.key === "shared:legacy") return null;
  // Local-only instances retain their established shared cache. Authenticated
  // identities never adopt ambiguous origin-wide data.
  return scope.key === "shared:local" ? key : `${key}:scope:${scope.key}`;
}
export function assertClientDataScope(
  scope: ClientDataScope | null,
): asserts scope is ClientDataScope {
  if (!isCurrentClientDataScope(scope))
    throw new Error(
      "The signed-in account changed. Retry after sign-in is checked.",
    );
}

/** Server legacy GitHub scopes name logins, not immutable identities. */
export function negotiatedClientCommandScope(
  scope: ClientDataScope | null,
  reported?: string,
): string | null {
  if (scope?.privacy) return reported === scope.key ? scope.key : null;
  if (
    scope?.key === "shared:local" &&
    (!reported || reported.startsWith("local:") || reported === "shared:local")
  )
    return scope.key;
  return null;
}

export const clientAuthStatusSchema = z.object({
  required: z.boolean(),
  authenticated: z.boolean(),
  githubAccountId: z.number().int().positive().optional(),
  admin: z.boolean().optional(),
  name: z.string().optional(),
  login: z.string().optional(),
  organizationName: z.string().optional(),
  organizationIconUrl: z.string().nullable().optional(),
  reconnectRequired: z.boolean().optional(),
});
export type ClientAuthStatus = z.infer<typeof clientAuthStatusSchema>;
