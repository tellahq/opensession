import type {
  PersonalGithubGrantFlow,
  PersonalGithubStatus,
} from "./personal-github";

/**
 * The personal GitHub card's state, as a reducer so the rules that keep it
 * honest are testable without a DOM:
 *
 * - Everything is bound to one signed-in account. When the browser's identity
 *   changes (sign-out, a different person signs in) the whole state resets:
 *   disclosure consent, the pending device flow, the cached status. Nothing
 *   is keyed on a display name; the client-side scope comes from the
 *   verified sign-in and the server's numeric account id is checked on top.
 * - Every async result carries the `generation` it was started under. A
 *   response that arrives after a reset is dropped, so a slow request from
 *   the previous account can never paint into the next one.
 * - A status whose owner differs from the one already held is treated as a
 *   changed account, not as data.
 *
 * Nothing here is persisted. Receipts, device-flow ids and consent live only
 * for the life of this component under this account.
 */

export type PersonalGithubStatusState =
  | { kind: "idle" }
  | { kind: "loading"; previous: PersonalGithubStatus | null }
  | { kind: "ready"; data: PersonalGithubStatus }
  | { kind: "signin_required"; message: string }
  | { kind: "error"; message: string; previous: PersonalGithubStatus | null };

export type PersonalGithubOperation =
  | { kind: "none" }
  /** Sending the disclosure acknowledgement. */
  | { kind: "acknowledging" }
  /** Asking the server for the manifest. */
  | { kind: "preparing" }
  /** The form is on its way to GitHub; the page is about to leave. */
  | { kind: "redirecting" }
  | { kind: "grant"; flow: PersonalGithubGrantFlow }
  | { kind: "refreshing" }
  | { kind: "disconnecting" };

export interface PersonalGithubState {
  /** Client-side identity scope, from the verified sign-in. */
  scope: string | null;
  /** Bumped on every reset; async results must match it to land. */
  generation: number;
  /** The server-verified numeric account id the status belongs to. */
  owner: number | null;
  status: PersonalGithubStatusState;
  /** "I understand and trust this server." Never persisted. */
  consent: boolean;
  operation: PersonalGithubOperation;
  /** The last failed operation, in words. */
  error: string | null;
}

export type PersonalGithubAction =
  | { type: "scope"; scope: string | null }
  | { type: "status.start" }
  | { type: "status.ok"; generation: number; data: PersonalGithubStatus }
  | {
      type: "status.failed";
      generation: number;
      message: string;
      signInRequired: boolean;
    }
  | { type: "consent"; accepted: boolean }
  | { type: "operation.start"; operation: PersonalGithubOperation }
  | { type: "operation.done"; generation: number }
  | { type: "operation.failed"; generation: number; message: string }
  | { type: "grant.started"; generation: number; flow: PersonalGithubGrantFlow }
  | { type: "grant.cancel" }
  | { type: "error.dismiss" };

export const INITIAL_PERSONAL_GITHUB_STATE: PersonalGithubState = {
  scope: null,
  generation: 0,
  owner: null,
  status: { kind: "idle" },
  consent: false,
  operation: { kind: "none" },
  error: null,
};

export const ACCOUNT_CHANGED_MESSAGE =
  "The signed-in GitHub account changed. Reload the page to continue.";

function resetFor(
  scope: string | null,
  generation: number,
): PersonalGithubState {
  return { ...INITIAL_PERSONAL_GITHUB_STATE, scope, generation };
}

function currentStatus(
  status: PersonalGithubStatusState,
): PersonalGithubStatus | null {
  switch (status.kind) {
    case "ready":
      return status.data;
    case "loading":
    case "error":
      return status.previous;
    default:
      return null;
  }
}

export function personalGithubReducer(
  state: PersonalGithubState,
  action: PersonalGithubAction,
): PersonalGithubState {
  switch (action.type) {
    case "scope":
      if (state.scope === action.scope) return state;
      return resetFor(action.scope, state.generation + 1);
    case "status.start":
      return {
        ...state,
        status: { kind: "loading", previous: currentStatus(state.status) },
      };
    case "status.ok": {
      if (action.generation !== state.generation) return state;
      if (state.scope !== `github:${action.data.ownerGithubAccountId}`) {
        return {
          ...resetFor(null, state.generation + 1),
          status: {
            kind: "error",
            message: ACCOUNT_CHANGED_MESSAGE,
            previous: null,
          },
        };
      }
      return {
        ...state,
        owner: action.data.ownerGithubAccountId,
        consent:
          state.consent &&
          currentStatus(state.status)?.disclosure.version ===
            action.data.disclosure.version,
        status: { kind: "ready", data: action.data },
        // A fresh status means the hand-off to GitHub is over, whichever way
        // it went (a back-navigation can revive the page mid-redirect).
        operation:
          state.operation.kind === "redirecting" ||
          (action.data.status.needsDisconnect &&
            (state.operation.kind === "grant" ||
              state.operation.kind === "preparing"))
            ? { kind: "none" }
            : state.operation,
      };
    }
    case "status.failed":
      if (action.generation !== state.generation) return state;
      return {
        ...(action.signInRequired
          ? resetFor(null, state.generation + 1)
          : state),
        status: action.signInRequired
          ? { kind: "signin_required", message: action.message }
          : {
              kind: "error",
              message: action.message,
              previous: currentStatus(state.status),
            },
      };
    case "consent":
      return { ...state, consent: action.accepted };
    case "operation.start":
      return { ...state, operation: action.operation, error: null };
    case "operation.done":
      if (action.generation !== state.generation) return state;
      return { ...state, operation: { kind: "none" } };
    case "operation.failed":
      if (action.generation !== state.generation) return state;
      return { ...state, operation: { kind: "none" }, error: action.message };
    case "grant.started":
      if (
        action.generation !== state.generation ||
        currentStatus(state.status)?.status.needsDisconnect
      )
        return state;
      return { ...state, operation: { kind: "grant", flow: action.flow } };
    case "grant.cancel":
      return state.operation.kind === "grant"
        ? { ...state, operation: { kind: "none" } }
        : state;
    case "error.dismiss":
      return { ...state, error: null };
  }
}

/** Fail closed until auth supplies a verified numeric account id. No login or
 * display name is an identity key, and unresolved/logout unmounts all state. */
export function personalGithubScope(
  auth: {
    required: boolean;
    authenticated: boolean;
    githubAccountId?: number;
  } | null,
): string | null {
  if (
    !auth?.required ||
    !auth.authenticated ||
    !Number.isSafeInteger(auth.githubAccountId) ||
    (auth.githubAccountId ?? 0) <= 0
  )
    return null;
  return `github:${auth.githubAccountId}`;
}

/** The disclosure must be shown before any network creation. The button that
 * starts a manifest is only live once the status (which carries the versioned
 * disclosure) is loaded, the checkbox is ticked and nothing is in flight. */
export function canStartConnection(state: PersonalGithubState): boolean {
  return (
    state.status.kind === "ready" &&
    !state.status.data.status.app &&
    !state.status.data.status.needsDisconnect &&
    state.consent &&
    state.operation.kind === "none"
  );
}

/** Child lifetime is the owner/App/installation tuple. Admission loss,
 * revocation, failed status loads and identity switches unmount it. */
export function personalRepositoryScope(
  data: PersonalGithubStatus,
): string | null {
  const { app, installation, userGrant, needsDisconnect } = data.status;
  if (
    !data.repositoryAdmission ||
    needsDisconnect ||
    !app ||
    !installation ||
    installation.suspended ||
    !userGrant ||
    userGrant.needsReconnect
  )
    return null;
  return JSON.stringify([
    data.ownerGithubAccountId,
    app.recordId,
    app.githubAppId,
    installation.installationId,
  ]);
}
