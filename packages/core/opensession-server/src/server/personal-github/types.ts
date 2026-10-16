/**
 * Personal GitHub App types. Everything here is either an internal broker
 * record or a secret-free public DTO. Identity is always the verified numeric
 * GitHub account id; logins and display names are informational and may
 * change under a rename without changing ownership.
 */
import type { ConnectionAcknowledgement } from "./disclosure";
import type { AccessPrincipal } from "../../shared/access-scope";

export type { AccessPrincipal };

/** One App per verified account. The record itself carries no secret: the
 * private key and client secret live only behind the broker. */
export interface PersonalAppRecord {
  connectionAcknowledgement?: ConnectionAcknowledgement;
  /** Opaque, server-generated. Never the GitHub App id, so an overlapping id
   * space between instances or between shared and personal Apps cannot
   * alias a record. */
  recordId: string;
  ownerGithubAccountId: number;
  /** GitHub's numeric App id from the manifest conversion. */
  githubAppId: number;
  /** Public OAuth client id (also the App JWT issuer). */
  clientId: string;
  slug: string;
  /** The owner login GitHub reported at conversion. Informational only. */
  ownerLoginAtCreation: string;
  createdAt: number;
  public: false;
  webhooks: "disabled";
}

export interface PersonalAppSecrets {
  privateKeyPem: string;
  clientSecret: string;
}

/** A user-to-server grant obtained through the personal App's device flow.
 * Stored only behind the broker; never returned by a DTO. */
export interface PersonalUserGrant {
  accessToken: string;
  /** ms epoch, null for a non-expiring token. */
  expiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
  /** The account id GitHub returned for the token. Always equals the owner;
   * kept so a corrupted record fails closed instead of silently matching. */
  grantedGithubAccountId: number;
  /** Informational. */
  grantedLogin: string;
  connectedAt: number;
  refreshFailedAt: number | null;
}

export interface PersonalInstallation {
  installationId: number;
  /** Always equals the App owner; verified, not assumed. */
  accountGithubAccountId: number;
  accountLogin: string;
  accountType: "User";
  repositorySelection: "all" | "selected";
  suspended: boolean;
}

export interface DiscoveredRepository {
  repositoryId: number;
  name: string;
  fullName: string;
  ownerGithubAccountId: number;
  private: boolean;
  defaultBranch: string | null;
}

/** Secret-free public status. */
export interface PersonalAppStatusDto {
  needsDisconnect: boolean;
  runtime: "shared_trusted_host" | "synthetic";
  app: {
    recordId: string;
    githubAppId: number;
    slug: string;
    clientId: string;
    ownerLoginAtCreation: string;
    createdAt: number;
    installUrl: string;
    public: false;
    webhooks: "disabled";
  } | null;
  installation: {
    installationId: number;
    accountLogin: string;
    repositorySelection: "all" | "selected";
    suspended: boolean;
  } | null;
  userGrant: {
    grantedLogin: string;
    connectedAt: number;
    expiresAt: number | null;
    needsReconnect: boolean;
  } | null;
}

export interface PersonalDeviceFlowStartDto {
  flowId: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

/** Registration input for the authoritative catalog, never a browser claim.
 * Names are display metadata; all authorization is on the immutable tuple.
 * Runtime must revalidate accessRevision against the broker before use. */
export interface PersonalRepositoryDescriptor {
  readonly kind: "personal";
  readonly ownerGithubAccountId: number;
  readonly appRecordId: string;
  readonly githubAppId: number;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly repositoryOwnerGithubAccountId: number;
  readonly accessRevision: number;
  readonly fullName: string;
}
