import { z } from "zod";
import { API_BASE, ApiError } from "./api/request";
import { githubManifestAction } from "./github-app-setup";

/**
 * Personal GitHub App API (issue #390): one private App per verified GitHub
 * account, created through GitHub's manifest flow after the person has read
 * and accepted the shared-server disclosure.
 *
 * Every response is parsed at this boundary. Nothing here ever sees a secret:
 * the server keeps private keys, client secrets, device codes and tokens
 * behind its broker, and the browser only carries a short-lived disclosure
 * receipt and an opaque device-flow id, both in memory.
 */

const DISCLOSURE_SCHEMA = z.object({
  version: z.string().min(1),
  text: z.string().min(1),
});

const APP_SCHEMA = z.object({
  recordId: z.string(),
  githubAppId: z.number(),
  slug: z.string(),
  clientId: z.string(),
  ownerLoginAtCreation: z.string(),
  createdAt: z.number(),
  installUrl: z.string(),
});

const INSTALLATION_SCHEMA = z.object({
  installationId: z.number(),
  accountLogin: z.string(),
  repositorySelection: z.enum(["all", "selected"]),
  suspended: z.boolean(),
});

const USER_GRANT_SCHEMA = z.object({
  grantedLogin: z.string(),
  connectedAt: z.number(),
  expiresAt: z.number().nullable(),
  needsReconnect: z.boolean(),
});

const CONNECTION_SCHEMA = z.object({
  needsDisconnect: z.boolean().optional(),
  app: APP_SCHEMA.nullable(),
  installation: INSTALLATION_SCHEMA.nullable(),
  userGrant: USER_GRANT_SCHEMA.nullable(),
});

const STATUS_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
  disclosure: DISCLOSURE_SCHEMA,
  repositoryAdmission: z.boolean(),
  status: CONNECTION_SCHEMA,
});

const DISCLOSURE_RECEIPT_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
  disclosureReceipt: z.string().min(1),
  expiresAt: z.number(),
});

const MANIFEST_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
  action: z.string(),
  manifest: z.string().min(1),
  state: z.string().min(1),
});

const GRANT_START_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
  flowId: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
  interval: z.number(),
  expiresIn: z.number(),
});

const GRANT_POLL_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
  status: z.enum(["pending", "connected"]),
});

const REFRESH_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
  repositories: z.array(
    z.object({
      repositoryId: z.number(),
      fullName: z.string(),
      private: z.boolean(),
    }),
  ),
});

const OK_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
});

const FAILURE_SCHEMA = z.object({
  code: z.string().min(1),
  error: z.string().min(1),
});

export type PersonalGithubDisclosure = z.infer<typeof DISCLOSURE_SCHEMA>;
export type PersonalGithubConnection = z.infer<typeof CONNECTION_SCHEMA>;
export type PersonalGithubStatus = z.infer<typeof STATUS_SCHEMA>;
export type PersonalGithubDisclosureReceipt = z.infer<
  typeof DISCLOSURE_RECEIPT_SCHEMA
>;
export type PersonalGithubManifest = z.infer<typeof MANIFEST_SCHEMA>;
export type PersonalGithubGrantFlow = z.infer<typeof GRANT_START_SCHEMA>;
export type PersonalGithubGrantPoll = z.infer<typeof GRANT_POLL_SCHEMA>;
export type PersonalGithubRefresh = z.infer<typeof REFRESH_SCHEMA>;

/** The server's `{ok:false, code, error}` envelope, kept as a typed error so
 * the UI can branch on `code` (a stale receipt, an expired device flow) rather
 * than on prose. */
export class PersonalGithubApiError extends ApiError {
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message, status);
    this.name = "PersonalGithubApiError";
    this.code = code;
  }
}

/** The account behind the browser session has no verified numeric GitHub
 * id: an old cookie from before ids were recorded. Signing in again fixes it. */
export const VERIFIED_SIGNIN_REQUIRED = "verified_signin_required";

export function isVerifiedSignInRequired<Rejected>(error: Rejected): boolean {
  return (
    error instanceof PersonalGithubApiError &&
    error.code === VERIFIED_SIGNIN_REQUIRED
  );
}

async function call<Parsed>(
  path: string,
  schema: z.ZodType<Parsed>,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown; label: string },
): Promise<Parsed> {
  const request: RequestInit = {
    method: init.method,
    cache: "no-store",
    credentials: "same-origin",
  };
  if (init.body !== undefined) {
    request.headers = { "Content-Type": "application/json" };
    request.body = JSON.stringify(init.body);
  }
  const res = await fetch(`${API_BASE}${path}`, request);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const failure = FAILURE_SCHEMA.safeParse(body);
    if (failure.success) {
      throw new PersonalGithubApiError(
        failure.data.error,
        res.status,
        failure.data.code,
      );
    }
    throw new ApiError(`${init.label}: ${res.status}`, res.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      `${init.label}: the server sent an unexpected response`,
      res.status,
    );
  }
  return parsed.data;
}

export function fetchPersonalGithubStatus(): Promise<PersonalGithubStatus> {
  return call("/personal/github/status", STATUS_SCHEMA, {
    method: "GET",
    label: "Could not load your GitHub App status",
  });
}

/** Records that this person accepted the disclosure they were shown. The
 * receipt is bound server-side to the account, browser session and origin, and
 * expires; it is the only thing that lets a manifest start. */
export function acceptPersonalGithubDisclosure(
  version: string,
): Promise<PersonalGithubDisclosureReceipt> {
  return call("/personal/github/disclosure", DISCLOSURE_RECEIPT_SCHEMA, {
    method: "POST",
    body: { version, accepted: true },
    label: "Could not record the disclosure",
  });
}

export function beginPersonalGithubManifest(
  disclosureReceipt: string,
): Promise<PersonalGithubManifest> {
  return call("/personal/github/manifest", MANIFEST_SCHEMA, {
    method: "POST",
    body: { disclosureReceipt },
    label: "Could not prepare the GitHub App",
  });
}

export function startPersonalGithubGrant(): Promise<PersonalGithubGrantFlow> {
  return call("/personal/github/grant", GRANT_START_SCHEMA, {
    method: "POST",
    label: "Could not start GitHub authorization",
  });
}

export function pollPersonalGithubGrant(
  flowId: string,
): Promise<PersonalGithubGrantPoll> {
  return call("/personal/github/grant/poll", GRANT_POLL_SCHEMA, {
    method: "POST",
    body: { flowId },
    label: "Could not check GitHub authorization",
  });
}

export function refreshPersonalGithub(): Promise<PersonalGithubRefresh> {
  return call("/personal/github/refresh", REFRESH_SCHEMA, {
    method: "POST",
    label: "Could not refresh repositories",
  });
}

export function disconnectPersonalGithub(): Promise<z.infer<typeof OK_SCHEMA>> {
  return call("/personal/github/connection", OK_SCHEMA, {
    method: "DELETE",
    label: "Could not disconnect the GitHub App",
  });
}

/**
 * The manifest is submitted as a top-level HTML form POST to GitHub's own
 * registration page, which is the only way GitHub accepts one; the browser
 * carries the manifest JSON and a state nonce, never an App credential. Only
 * GitHub's HTTPS origin may receive it, and the action must already carry the
 * state the server bound to this account, browser session and origin.
 */
export interface ManifestSubmission {
  action: string;
  manifest: string;
}

export function manifestSubmission(
  response: PersonalGithubManifest,
): ManifestSubmission | null {
  const action = githubManifestAction(response.action);
  if (!action) return null;
  const stateInAction = new URL(action).searchParams.get("state");
  if (stateInAction !== response.state) return null;
  return { action, manifest: response.manifest };
}

/** What the card is showing, derived from the secret-free status. */
export type PersonalGithubPhase =
  | "none"
  | "disconnect_required"
  | "app_created"
  | "connected"
  | "reconnect"
  | "suspended";

export function personalGithubPhase(
  connection: PersonalGithubConnection,
): PersonalGithubPhase {
  if (connection.needsDisconnect) return "disconnect_required";
  if (!connection.app) return "none";
  if (!connection.userGrant) return "app_created";
  if (connection.userGrant.needsReconnect) return "reconnect";
  if (connection.installation?.suspended) return "suspended";
  return "connected";
}

export const PHASE_LABEL: Record<PersonalGithubPhase, string> = {
  none: "Not connected",
  disconnect_required: "Disconnect needed",
  app_created: "Authorize needed",
  connected: "Connected",
  reconnect: "Reconnect needed",
  suspended: "Suspended on GitHub",
};

/** Same dot colors the GitHub account row above this card uses. */
export const PHASE_DOT: Record<PersonalGithubPhase, string> = {
  none: "var(--line-strong, var(--text-faint))",
  disconnect_required: "var(--red)",
  app_created: "var(--yellow)",
  connected: "var(--green)",
  reconnect: "var(--red)",
  suspended: "var(--red)",
};

export function personalGithubDescription(
  connection: PersonalGithubConnection,
  repositoryAdmission: boolean,
): string {
  const phase = personalGithubPhase(connection);
  switch (phase) {
    case "disconnect_required":
      return "Disconnect this connection and set it up again.";
    case "none":
      return "Create a private GitHub App that only you own, installed on the repositories you choose.";
    case "app_created":
      return `App ${connection.app!.slug} is created. Authorize it so this server can act as you.`;
    case "reconnect":
      return "GitHub no longer accepts this authorization. Authorize again to keep using it.";
    case "suspended":
      return "GitHub suspended this installation. Unsuspend it on GitHub, then check again.";
    case "connected":
      return repositoryAdmission
        ? `Authorized as @${connection.userGrant!.grantedLogin}.`
        : `Authorized as @${connection.userGrant!.grantedLogin}. Repository sessions are not available yet.`;
  }
}

/** Personal Apps use GitHub's personal settings, never an installation URL. */
export function personalGithubAppSettingsUrl(slug: string): string | null {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)
    ? `https://github.com/settings/apps/${slug}`
    : null;
}

export interface PersonalRepositorySelection {
  appRecordId: string;
  githubAppId: number;
  installationId: number;
  repositoryId: number;
}

const REGISTRATION_SCHEMA = z.object({
  ok: z.literal(true),
  ownerGithubAccountId: z.number().int().positive(),
  registryId: z.string().min(1),
  descriptor: z.object({
    kind: z.literal("personal"),
    ownerGithubAccountId: z.number().int().positive(),
    appRecordId: z.string().min(1),
    githubAppId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    repositoryId: z.number().int().positive(),
    repositoryOwnerGithubAccountId: z.number().int().positive(),
    accessRevision: z.number().int().nonnegative(),
    fullName: z.string().min(1),
  }),
});
export type PersonalRepositoryRegistration = z.infer<
  typeof REGISTRATION_SCHEMA
>;

/** Send only the immutable selection. The server constructs the descriptor;
 * neither discovery nor an echoed browser descriptor grants access. */
export async function registerPersonalRepository(
  selection: PersonalRepositorySelection,
  ownerGithubAccountId: number,
): Promise<PersonalRepositoryRegistration> {
  const result = await call("/personal/repos", REGISTRATION_SCHEMA, {
    method: "POST",
    body: {
      appRecordId: selection.appRecordId,
      githubAppId: selection.githubAppId,
      installationId: selection.installationId,
      repositoryId: selection.repositoryId,
    },
    label: "Could not add repository",
  });
  const descriptor = result.descriptor;
  if (
    result.ownerGithubAccountId !== ownerGithubAccountId ||
    descriptor.ownerGithubAccountId !== ownerGithubAccountId ||
    descriptor.repositoryOwnerGithubAccountId !== ownerGithubAccountId ||
    descriptor.appRecordId !== selection.appRecordId ||
    descriptor.githubAppId !== selection.githubAppId ||
    descriptor.installationId !== selection.installationId ||
    descriptor.repositoryId !== selection.repositoryId
  )
    throw new ApiError(
      "The repository connection changed. Check repositories again.",
      409,
    );
  return result;
}

/** A fresh owner-filtered catalog read, without the shared picker cache. */
export async function personalRepositoryIsListed(
  registryId: string,
): Promise<boolean> {
  const result = await call(
    "/repos",
    z.object({ repos: z.array(z.object({ id: z.string() })) }),
    {
      method: "GET",
      label: "Could not check registered repositories",
    },
  );
  return result.repos.some((repo) => repo.id === registryId);
}
