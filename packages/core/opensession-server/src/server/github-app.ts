/**
 * GitHub App installation tokens (server-to-server).
 *
 * The org's GitHub App (the same one behind per-user sign-in,
 * github-auth.ts) mints short-lived installation access tokens from its
 * private key. Separate read, write, and repository-scoped permission sets
 * come from shared/github-app-permissions.ts.
 *
 * Key file: ~/.opensession/github-app.pem (0600), override with
 * OPENSESSION_GITHUB_APP_KEY (a file path). The JWT issuer is the App client
 * id from github-auth.ts. Token + installation id are cached on globalThis;
 * tokens live 1h and refresh 5 min early. GitHub App authority fails closed when
 * identity, key, installation selection, or permissions are invalid. It never
 * falls back to ambient gh, SSH credentials, or a connected human.
 */
import { createSign } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { githubAppIdentity, githubUserAuthSettings } from "./github-auth";
import { stateDir } from "./paths";
import { configuredIntegration } from "./config";
import { githubGitCredentialEnv } from "./github-git-credential";
import { writeFileAtomic } from "./shared/atomic-write";
import {
  GITHUB_APP_CODE_PERMISSIONS as CODE_PERMISSIONS,
  GITHUB_APP_READ_PERMISSIONS as READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS as WRITE_PERMISSIONS,
} from "../shared/github-app-permissions";

let keyPathOverride: string | undefined;

function keyPath(): string {
  return (
    keyPathOverride ||
    process.env.OPENSESSION_GITHUB_APP_KEY ||
    stateDir("github-app.pem")
  );
}

/** Test seam: isolate key mutations from the operator's real key file. */
export function __setGithubAppKeyPathForTest(path: string | undefined): void {
  keyPathOverride = path;
}

type AppTokenCache = {
  token: string;
  expiresAt: number; // ms epoch
  installationId: number;
  installationOwner: string;
  credentialIdentity: string;
};

const g = globalThis as {
  // Cached per scope: a read-only token and a write token carry different
  // permission sets, so they cannot share a slot.
  __ghAppTokenCacheRead?: AppTokenCache | null;
  __ghAppTokenCacheWrite?: AppTokenCache | null;
  __ghAppTokenWarned?: boolean;
  __ghAppLastMintOk?: boolean;
  __ghAppLastMintIdentity?: string;
};

// READ_PERMISSIONS / WRITE_PERMISSIONS are the canonical sets imported at the
// top of the file (shared/github-app-permissions) — the same definition the
// create-app URL grants, so a mint never asks for a scope the App was not
// granted. Still installation-scoped, so an out-of-org write fails at GitHub's
// side as well (security-model.md, GitHub credential scoping). If the App does
// not hold a set, minting fails closed.

function appJwt(clientId: string, key: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  const sig = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(key)
    .toString("base64url");
  return `${unsigned}.${sig}`;
}

/**
 * Installation access token for the app's (sole) installation, or null when
 * the App identity, key, installation selection, or permissions are invalid.
 * Callers treat null as a closed credential boundary.
 */
export async function githubAppInstallationToken(
  opts: { write?: boolean } = {},
): Promise<string | null> {
  const slot = opts.write ? "__ghAppTokenCacheWrite" : "__ghAppTokenCacheRead";
  const { clientId } = githubUserAuthSettings();
  const githubConfig = configuredIntegration("github");
  const configuredInstallationId =
    typeof githubConfig.installationId === "number"
      ? githubConfig.installationId
      : undefined;
  const configuredOwner = (
    [githubConfig.installationOwner, githubConfig.appOrg].find(
      (value): value is string => typeof value === "string" && !!value.trim(),
    ) ?? ""
  ).toLowerCase();
  const credentialIdentity = `${clientId || ""}:${configuredInstallationId || ""}:${configuredOwner}`;
  const cached = g[slot];
  if (
    cached &&
    cached.credentialIdentity === credentialIdentity &&
    cached.expiresAt - Date.now() > 5 * 60_000
  ) {
    g.__ghAppLastMintOk = true;
    g.__ghAppLastMintIdentity = credentialIdentity;
    return cached.token;
  }

  if (!clientId || !existsSync(keyPath())) {
    g.__ghAppLastMintOk = false;
    g.__ghAppLastMintIdentity = credentialIdentity;
    return null;
  }
  try {
    const key = await Bun.file(keyPath()).text();
    const jwt = appJwt(clientId, key);
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    };
    // Either cache slot can supply the installation id — it does not vary by scope.
    let installationId =
      configuredInstallationId ||
      (g.__ghAppTokenCacheRead?.credentialIdentity === credentialIdentity
        ? g.__ghAppTokenCacheRead.installationId
        : undefined) ||
      (g.__ghAppTokenCacheWrite?.credentialIdentity === credentialIdentity
        ? g.__ghAppTokenCacheWrite.installationId
        : undefined);
    const matchingRead =
      g.__ghAppTokenCacheRead?.credentialIdentity === credentialIdentity
        ? g.__ghAppTokenCacheRead
        : undefined;
    const matchingWrite =
      g.__ghAppTokenCacheWrite?.credentialIdentity === credentialIdentity
        ? g.__ghAppTokenCacheWrite
        : undefined;
    let installationOwner =
      matchingRead && matchingRead.installationId === installationId
        ? matchingRead.installationOwner
        : matchingWrite && matchingWrite.installationId === installationId
          ? matchingWrite.installationOwner
          : undefined;
    if (!installationId) {
      const res = await fetch("https://api.github.com/app/installations", {
        headers,
      });
      const installs = (await res.json()) as Array<{
        id: number;
        account?: { login?: string };
      }>;
      if (!Array.isArray(installs) || !installs.length)
        throw new Error("no installations");
      // Prefer an explicit installation owner, then the org captured at setup
      // (appOrg) — the same precedence setup-team.ts uses. An org App installed
      // on more than one account must be selected explicitly.
      const selected = configuredOwner
        ? installs.find(
            (installation) =>
              installation.account?.login?.toLowerCase() === configuredOwner,
          )
        : installs.length === 1
          ? installs[0]
          : undefined;
      if (!selected) {
        throw new Error(
          configuredOwner
            ? `no GitHub App installation for ${configuredOwner}`
            : "multiple GitHub App installations; configure integrations.github.installationOwner",
        );
      }
      installationId = selected.id;
      installationOwner = selected.account?.login;
    }
    if (!installationOwner) {
      const installationRes = await fetch(
        `https://api.github.com/app/installations/${installationId}`,
        { headers },
      );
      const installation = (await installationRes.json()) as {
        account?: { login?: string };
      };
      installationOwner = installation.account?.login;
      if (!installationRes.ok || !installationOwner) {
        throw new Error(
          `cannot resolve installation owner (${installationRes.status})`,
        );
      }
    }

    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          permissions: opts.write ? WRITE_PERMISSIONS : READ_PERMISSIONS,
        }),
      },
    );
    const tok = (await res.json()) as { token?: string; expires_at?: string };
    if (!tok.token)
      throw new Error(`mint failed: ${JSON.stringify(tok).slice(0, 120)}`);
    g[slot] = {
      token: tok.token,
      expiresAt: tok.expires_at
        ? Date.parse(tok.expires_at)
        : Date.now() + 55 * 60_000,
      installationId,
      installationOwner,
      credentialIdentity,
    };
    g.__ghAppTokenWarned = false;
    g.__ghAppLastMintOk = true;
    g.__ghAppLastMintIdentity = credentialIdentity;
    return tok.token;
  } catch (e) {
    g.__ghAppLastMintOk = false;
    g.__ghAppLastMintIdentity = credentialIdentity;
    if (!g.__ghAppTokenWarned) {
      g.__ghAppTokenWarned = true;
      console.warn(
        `[github-app] installation token unavailable: ${String(e).slice(0, 200)}`,
      );
    }
    return null;
  }
}

/** The selected GitHub credential for REST/GraphQL calls. GitHub App
 * installation tokens are the only service credential. */
export async function githubToken(
  opts: { write?: boolean } = {},
): Promise<string | null> {
  if (!githubConfiguredCredential()) return null;
  return githubAppInstallationToken(opts);
}

/** Whether the App has the complete identity needed for service work. */
export function githubConfiguredCredential(): boolean {
  const github = configuredIntegration("github");
  const owner = github.installationOwner || github.appOrg;
  return githubAppConfigured() && !!githubAppIdentity().slug && !!owner;
}

/** Last observed App availability for synchronous health snapshots. Startup and
 * every GitHub request update this state through installation-token minting. */
export function githubAppCredentialHealth():
  | "operational"
  | "unavailable"
  | "unchecked" {
  if (!githubConfiguredCredential()) return "unavailable";
  const github = configuredIntegration("github");
  const owner = String(
    github.installationOwner || github.appOrg || "",
  ).toLowerCase();
  const installationId =
    typeof github.installationId === "number" ? github.installationId : "";
  const identity = `${githubUserAuthSettings().clientId || ""}:${installationId}:${owner}`;
  if (
    g.__ghAppLastMintIdentity !== identity ||
    g.__ghAppLastMintOk === undefined
  )
    return "unchecked";
  return g.__ghAppLastMintOk ? "operational" : "unavailable";
}

/** Whether a private key is stored for the GitHub App. */
export function githubAppPrivateKeyConfigured(): boolean {
  return existsSync(keyPath());
}

/** Whether a GitHub App can mint installation tokens (client id + private key). */
export function githubAppConfigured(): boolean {
  return !!githubUserAuthSettings().clientId && githubAppPrivateKeyConfigured();
}

/** Point the App-level webhook at the public callback gateway after ingress is
 * configured. The manifest already granted the event subscriptions and stored
 * this shared secret; authenticating as the App lets Domains connect the URL
 * later without sending the operator back through GitHub's settings UI. */
export async function updateGithubAppWebhook(
  publicOrigin: string,
  secret: string,
): Promise<void> {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("GitHub webhooks require a public HTTPS origin");
  }
  if (!secret || /[\r\n\0]/.test(secret)) {
    throw new Error("GitHub webhook secret is missing or invalid");
  }
  const { clientId } = githubUserAuthSettings();
  if (!clientId || !existsSync(keyPath())) {
    throw new Error("GitHub App credentials are not configured");
  }
  const key = await Bun.file(keyPath()).text();
  const response = await fetch("https://api.github.com/app/hook/config", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${appJwt(clientId, key)}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opensession",
    },
    body: JSON.stringify({
      url: `${origin.origin}/github/webhook`,
      content_type: "json",
      secret,
      insecure_ssl: "0",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub rejected the webhook update (${response.status})`);
  }
}

/** Persist the App's private key (0600) at the key path — the piece the device-flow
 *  setup never captured, so installation tokens (bot/agent, checks-read) could
 *  never mint. The App-manifest flow returns this PEM at creation. Drops any
 *  cached installation token, which belonged to a previous key. Honors the
 *  OPENSESSION_GITHUB_APP_KEY override so an ops-managed key is never clobbered. */
export function writeGithubAppKey(pem: string): void {
  if (process.env.OPENSESSION_GITHUB_APP_KEY)
    throw new Error(
      "OPENSESSION_GITHUB_APP_KEY is set; not overwriting an ops-managed key",
    );
  writeFileAtomic(keyPath(), pem.endsWith("\n") ? pem : `${pem}\n`, 0o600);
  g.__ghAppTokenCacheRead = null;
  g.__ghAppTokenCacheWrite = null;
}

/** Remove only a UI-managed key. An ops-managed path is external authority and
 * must never be mutated by the Settings removal flow. */
export function removeGithubAppKey(): void {
  // The App config may be UI-managed while its key path is ops-managed. In
  // that mixed mode, preserve the external file but still invalidate tokens.
  if (!process.env.OPENSESSION_GITHUB_APP_KEY)
    rmSync(keyPath(), { force: true });
  g.__ghAppTokenCacheRead = null;
  g.__ghAppTokenCacheWrite = null;
}

/** Keep the key and matching config mutation in one recoverable transaction.
 * `undefined` leaves the key alone, `null` removes it, and a string replaces
 * it. If the config commit fails, restore the exact prior key atomically. */
export async function commitGithubAppKeyMutation<T>(
  key: string | null | undefined,
  commitConfig: () => T | Promise<T>,
): Promise<T> {
  if (
    key === undefined ||
    (key === null && process.env.OPENSESSION_GITHUB_APP_KEY)
  ) {
    if (key === null) {
      g.__ghAppTokenCacheRead = null;
      g.__ghAppTokenCacheWrite = null;
    }
    return commitConfig();
  }
  if (key !== null && process.env.OPENSESSION_GITHUB_APP_KEY)
    throw new Error(
      "OPENSESSION_GITHUB_APP_KEY is set; not overwriting an ops-managed key",
    );

  const path = keyPath();
  const previous = existsSync(path) ? await Bun.file(path).text() : null;
  if (key === null) removeGithubAppKey();
  else writeGithubAppKey(key);
  try {
    return await commitConfig();
  } catch (error) {
    if (previous === null) rmSync(path, { force: true });
    else writeFileAtomic(path, previous, 0o600);
    g.__ghAppTokenCacheRead = null;
    g.__ghAppTokenCacheWrite = null;
    throw error;
  }
}

/**
 * A one-repository installation token for Runner workspace materialization.
 * It is intentionally separate from the read-only check token above: the
 * Runner receives it only in its one workspace_prepare frame and discards its
 * askpass helper immediately after git finishes. It is never persisted in a
 * session file, host spec, URL, transcript, or Runner registry.
 */
export function githubRepositoryMatchesInstallation(
  ghRepo: string,
  installationOwner: string | undefined,
): boolean {
  const [owner, repo, extra] = ghRepo.split("/");
  return (
    !!owner &&
    !!repo &&
    !extra &&
    !!installationOwner &&
    owner.toLowerCase() === installationOwner.toLowerCase()
  );
}

export async function githubAppRepositoryToken(
  ghRepo: string,
): Promise<string | null> {
  if (!githubConfiguredCredential()) return null;
  const [owner, repo] = ghRepo.split("/");
  if (!owner || !repo || ghRepo.split("/").length !== 2) return null;
  // Resolve the installation id through the existing credential path. It keeps
  // installation selection in one place and may populate the shared cache.
  await githubAppInstallationToken();
  const installation = g.__ghAppTokenCacheRead || g.__ghAppTokenCacheWrite;
  const installationId = installation?.installationId;
  if (
    !githubRepositoryMatchesInstallation(
      ghRepo,
      installation?.installationOwner,
    )
  ) {
    console.warn(
      `[github-app] refusing repository token for ${ghRepo}: selected installation belongs to ${installation?.installationOwner || "unknown"}`,
    );
    return null;
  }
  const { clientId } = githubUserAuthSettings();
  if (!installationId || !clientId || !existsSync(keyPath())) return null;
  try {
    const key = await Bun.file(keyPath()).text();
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appJwt(clientId, key)}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          repositories: [repo],
          // Trusted repository code runs can push/reply and inspect the
          // failing checks and Actions logs they are expected to repair.
          permissions: CODE_PERMISSIONS,
        }),
      },
    );
    const token = (await res.json()) as { token?: string; expires_at?: string };
    if (!res.ok || !token.token) throw new Error(`mint failed (${res.status})`);
    return token.token;
  } catch (error) {
    console.warn(
      `[github-app] repository token unavailable for ${owner}/${repo}: ${String(error).slice(0, 160)}`,
    );
    return null;
  }
}

/**
 * Env overlay that makes `gh` authenticate with the installation token
 * (GH_TOKEN beats hosts.yml), or null when unavailable.
 */
export async function githubAppEnv(): Promise<Record<string, string> | null> {
  const token = await githubToken();
  return token ? { GH_TOKEN: token } : null;
}

/** Ephemeral Git + gh capability for one trusted GitHub code run. The token is
 * process-local and never written into Git config, URLs, session files, or the
 * run journal. */
export async function githubServiceCredentialEnv(
  ghRepo?: string,
): Promise<Record<string, string>> {
  const token = ghRepo
    ? await githubAppRepositoryToken(ghRepo)
    : await githubToken({ write: true });
  // Even a failed mint carries the process-local SSH-to-HTTPS rewrite. That
  // turns an existing git@github.com origin into a non-interactive HTTPS
  // failure instead of escaping through a host SSH key.
  return githubGitCredentialEnv(token || "");
}
