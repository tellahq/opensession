/** Stable denial codes. Every failure is a value, never a thrown secret. */
export type PersonalGithubDenialCode =
  | "disclosure_required"
  | "invalid_principal"
  | "runtime_unavailable"
  | "manifest_missing"
  | "manifest_expired"
  | "manifest_replayed"
  | "manifest_owner_mismatch"
  | "manifest_origin_mismatch"
  | "manifest_session_mismatch"
  | "manifest_operation_mismatch"
  | "manifest_limit"
  | "exchange_denied"
  | "conversion_invalid"
  | "conversion_owner_mismatch"
  | "conversion_not_user_account"
  | "app_exists"
  | "app_missing"
  | "storage_failed"
  | "installation_missing"
  | "installation_wrong_owner"
  | "installation_ambiguous"
  | "installation_suspended"
  | "repository_not_accessible"
  | "repository_owner_mismatch"
  | "registration_app_mismatch"
  | "registration_invalid"
  | "credential_denied"
  | "grant_missing"
  | "grant_owner_mismatch"
  | "grant_needs_reconnect"
  | "revoked_during_operation"
  | "github_unavailable"
  | "response_too_large"
  | "request_invalid";

export interface PersonalGithubDenial {
  ok: false;
  code: PersonalGithubDenialCode;
  /** Short, secret-free, safe to show to the owner. */
  error: string;
}

export type PersonalGithubResult<T> = ({ ok: true } & T) | PersonalGithubDenial;

export function deny(
  code: PersonalGithubDenialCode,
  error: string,
): PersonalGithubDenial {
  return { ok: false, code, error };
}

/** Thrown only for programming errors at wiring time (a forged authority, a
 * transport that targets a non-GitHub host). Never for a person's request. */
export class PersonalGithubWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalGithubWiringError";
  }
}
