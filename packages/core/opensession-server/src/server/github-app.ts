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
 * id from github-auth.ts.
 *
 * One App may be installed on several accounts. The installation that serves
 * a call is selected from the repository owner (`acme/app` mints against the
 * acme installation); `integrations.github.installationOwner` is only the
 * default for calls that name no repository. Tokens are cached on globalThis
 * per installation and permission scope; they live 1h and refresh 5 min
 * early. GitHub App authority fails closed when identity, key, installation
 * selection, or permissions are invalid. It never falls back to ambient gh,
 * SSH credentials, or a connected human.
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
  withReadOnlyContents,
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
};

const g = globalThis as {
  /** Installation tokens keyed by client id, installation id, and permission
   * scope. A read-only token and a write token carry different permission
   * sets, and each installation mints its own, so none share a slot. */
  __ghAppTokenCache?: Map<string, AppTokenCache>;
  /** Selectors already warned about, so a broken installation logs once. */
  __ghAppTokenWarned?: Set<string>;
  __ghAppLastMintOk?: boolean;
  __ghAppLastMintIdentity?: string;
  __ghBotIdentity?: {
    login: string;
    identity: { name: string; email: string };
  };
  __ghAppInstallationsCache?: {
    clientId: string;
    at: number;
    installations: GithubAppInstallationAccount[];
  } | null;
};

function tokenCache(): Map<string, AppTokenCache> {
  return (g.__ghAppTokenCache ??= new Map());
}

/** Drop every cached token and the installation directory: they belonged to
 * a previous key or App identity. */
function clearAppCaches(): void {
  g.__ghAppTokenCache = new Map();
  g.__ghAppInstallationsCache = null;
}

/** The owner half of `owner/name`, or null when the value is not exactly one
 * owner and one repository. */
export function githubRepoOwner(ghRepo: string | undefined): string | null {
  if (!ghRepo) return null;
  const [owner, repo, extra] = ghRepo.split("/");
  return owner && repo && extra === undefined ? owner : null;
}

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

export interface GithubAppInstallationAccount {
  /** GitHub's numeric installation id, the token-mint selector. */
  id: number;
  /** Account login, e.g. "my-organization". */
  login: string;
  /** GitHub account type: "User" or "Organization". */
  type: string;
}

/** App-JWT headers, or null when the App identity or key is missing. */
async function appAuthHeaders(): Promise<Record<string, string> | null> {
  const { clientId } = githubUserAuthSettings();
  if (!clientId || !existsSync(keyPath())) return null;
  const key = await Bun.file(keyPath()).text();
  return {
    Authorization: `Bearer ${appJwt(clientId, key)}`,
    Accept: "application/vnd.github+json",
  };
}

/** Every account the App is installed on, listed with the App JWT alone (no
 * installation token involved, so this answers even when the default owner
 * matches no installation). Null when the App identity or key is missing or
 * GitHub cannot answer: "unknown", never "none". Briefly cached because the
 * setup picker refetches each time it opens; `fresh` bypasses the cache when a
 * just-installed account is expected. */
export async function listGithubAppInstallations(
  opts: { fresh?: boolean } = {},
): Promise<GithubAppInstallationAccount[] | null> {
  const { clientId } = githubUserAuthSettings();
  if (!clientId || !existsSync(keyPath())) return null;
  const cached = g.__ghAppInstallationsCache;
  if (
    !opts.fresh &&
    cached &&
    cached.clientId === clientId &&
    Date.now() - cached.at < 60_000
  ) {
    return cached.installations;
  }
  try {
    const headers = await appAuthHeaders();
    if (!headers) return null;
    const installations: GithubAppInstallationAccount[] = [];
    for (let page = 1; ; page++) {
      const res = await fetch(
        `https://api.github.com/app/installations?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body)) return null;
      for (const installation of body) {
        if (!installation || typeof installation !== "object") continue;
        const id = "id" in installation ? installation.id : undefined;
        const account =
          "account" in installation &&
          installation.account &&
          typeof installation.account === "object"
            ? installation.account
            : null;
        const login = account && "login" in account ? account.login : undefined;
        const type = account && "type" in account ? account.type : undefined;
        if (typeof id !== "number" || typeof login !== "string" || !login)
          continue;
        installations.push({
          id,
          login,
          type: typeof type === "string" ? type : "",
        });
      }
      if (body.length < 100) break;
    }
    // An empty directory is not cached: a just-installed App can take a moment
    // to appear, and callers retry that edge.
    if (installations.length)
      g.__ghAppInstallationsCache = { clientId, at: Date.now(), installations };
    return installations;
  } catch {
    return null;
  }
}

/** The account pinned as the App's default installation, from config
 * (installationOwner, with the setup-era appOrg as fallback). Empty when
 * nothing is pinned yet. Only calls that name no repository use it. */
export function configuredGithubInstallationOwner(): string {
  const github = configuredIntegration("github");
  return String(github.installationOwner || github.appOrg || "").trim();
}

/** Which installation a call is for: an explicit repository owner, or the
 * configured default (numeric installationId, then installationOwner). Part
 * of every cache key so a changed default never reuses another
 * installation's token. */
function installationSelector(owner?: string): string {
  if (owner) return `owner:${owner.toLowerCase()}`;
  const github = configuredIntegration("github");
  const configuredId =
    typeof github.installationId === "number" ? github.installationId : "";
  return `default:${configuredId}:${configuredGithubInstallationOwner().toLowerCase()}`;
}

type SelectedInstallation = { id: number; owner: string };

/** Resolve the installation for an owner (or the default). An owner the App is
 * not installed on fails closed; so does a missing default when the App is
 * installed on several accounts. */
async function selectInstallation(
  owner: string | undefined,
  headers: Record<string, string>,
): Promise<SelectedInstallation> {
  const github = configuredIntegration("github");
  const configuredId =
    typeof github.installationId === "number"
      ? github.installationId
      : undefined;
  if (!owner && configuredId) {
    const res = await fetch(
      `https://api.github.com/app/installations/${configuredId}`,
      { headers },
    );
    const installation = (await res.json().catch(() => null)) as {
      account?: { login?: string };
    } | null;
    const login = installation?.account?.login;
    if (!res.ok || !login)
      throw new Error(`cannot resolve installation owner (${res.status})`);
    return { id: configuredId, owner: login };
  }
  const wanted = (owner || configuredGithubInstallationOwner()).toLowerCase();
  const pick = (installs: GithubAppInstallationAccount[]) =>
    wanted
      ? installs.find((i) => i.login.toLowerCase() === wanted)
      : installs.length === 1
        ? installs[0]
        : undefined;
  let installs = await listGithubAppInstallations();
  let selected = installs ? pick(installs) : undefined;
  // A miss may be a stale directory (the App was just installed on this
  // account). Look once more before refusing.
  if (!selected && g.__ghAppInstallationsCache) {
    installs = await listGithubAppInstallations({ fresh: true });
    selected = installs ? pick(installs) : undefined;
  }
  if (!installs) throw new Error("cannot list GitHub App installations");
  if (!installs.length) throw new Error("no installations");
  if (!selected) {
    throw new Error(
      wanted
        ? `no GitHub App installation for ${wanted}`
        : "multiple GitHub App installations; configure integrations.github.installationOwner",
    );
  }
  return { id: selected.id, owner: selected.login };
}

/**
 * Installation access token, or null when the App identity, key, installation
 * selection, or permissions are invalid. `owner` selects the installation for
 * that repository owner; without it the configured default installation
 * serves. Callers treat null as a closed credential boundary.
 */
export async function githubAppInstallationToken(
  opts: { write?: boolean; owner?: string } = {},
): Promise<string | null> {
  const { clientId } = githubUserAuthSettings();
  const selector = installationSelector(opts.owner);
  const identity = `${clientId || ""}:${selector}`;
  // Health snapshots follow the default installation only: one organization
  // the App is not installed on must not report the whole credential dead.
  const noteHealth = (ok: boolean) => {
    if (opts.owner) return;
    g.__ghAppLastMintOk = ok;
    g.__ghAppLastMintIdentity = identity;
  };
  const headers = await appAuthHeaders().catch(() => null);
  if (!headers) {
    noteHealth(false);
    return null;
  }
  try {
    const installation = await selectInstallation(opts.owner, headers);
    const cacheKey = `${clientId}:${installation.id}:${opts.write ? "write" : "read"}`;
    const cached = tokenCache().get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) {
      noteHealth(true);
      return cached.token;
    }
    const tok = await mintInstallationToken(installation.id, headers, {
      permissions: opts.write ? WRITE_PERMISSIONS : READ_PERMISSIONS,
    });
    tokenCache().set(cacheKey, {
      token: tok.token,
      expiresAt: tok.expires_at
        ? Date.parse(tok.expires_at)
        : Date.now() + 55 * 60_000,
    });
    g.__ghAppTokenWarned?.delete(selector);
    noteHealth(true);
    return tok.token;
  } catch (e) {
    noteHealth(false);
    const warned = (g.__ghAppTokenWarned ??= new Set());
    if (!warned.has(selector)) {
      warned.add(selector);
      console.warn(
        `[github-app] installation token unavailable (${selector}): ${String(e).slice(0, 200)}`,
      );
    }
    return null;
  }
}

/**
 * One installation-token mint. A set that asks for contents:write against an
 * installation that only holds contents:read is refused as a whole (mints are
 * all-or-nothing), which would take reviews and comments down with pushes.
 * Retry once with contents narrowed to read and warn: the token still
 * comments and reviews, and a push fails with a clear 403 instead of every
 * App operation failing at once.
 */
async function mintInstallationToken(
  installationId: number,
  headers: Record<string, string>,
  body: { repositories?: string[]; permissions: Record<string, string> },
): Promise<{ token: string; expires_at?: string }> {
  const mint = async (permissions: Record<string, string>) => {
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, permissions }),
      },
    );
    const tok = (await res.json()) as { token?: string; expires_at?: string };
    return { ok: res.ok && !!tok.token, status: res.status, tok };
  };
  const first = await mint(body.permissions);
  if (first.ok) return first.tok as { token: string; expires_at?: string };
  const narrowed = withReadOnlyContents(body.permissions);
  if (narrowed !== body.permissions) {
    const retry = await mint(narrowed);
    if (retry.ok) {
      const warned = (g.__ghAppTokenWarned ??= new Set());
      const key = `contents-write:${installationId}`;
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(
          `[github-app] installation ${installationId} refused contents:write (${first.status}); minted with contents:read. Branch pushes fail until the App's Contents permission is restored to read and write.`,
        );
      }
      return retry.tok as { token: string; expires_at?: string };
    }
  }
  throw new Error(
    `mint failed (${first.status}): ${JSON.stringify(first.tok).slice(0, 120)}`,
  );
}

/** The selected GitHub credential for REST/GraphQL calls. GitHub App
 * installation tokens are the only service credential. `repo` (`owner/name`)
 * or `owner` selects the installation for that owner; a malformed repo fails
 * closed. Without either, the configured default installation serves. */
export async function githubToken(
  opts: { write?: boolean; repo?: string; owner?: string } = {},
): Promise<string | null> {
  if (!githubConfiguredCredential()) return null;
  const owner = opts.repo ? githubRepoOwner(opts.repo) : opts.owner || null;
  if (opts.repo && !owner) return null;
  return githubAppInstallationToken({
    ...(opts.write ? { write: true } : {}),
    ...(owner ? { owner } : {}),
  });
}

/** The `owner/name` a GitHub REST path addresses (`/repos/{owner}/{name}/…`),
 * so a call built from a path still mints against that owner's installation.
 * Null for paths outside `/repos/`. */
export function githubRepoFromApiPath(path: string): string | null {
  const match = path.match(/^\/repos\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Whether the App has the complete identity needed for service work.
 * Installation owner is optional: repository calls select by repository owner,
 * while repo-less calls use the default owner when one is configured. */
export function githubConfiguredCredential(): boolean {
  return githubAppConfigured() && !!githubAppIdentity().slug;
}

/** Last observed App availability for synchronous health snapshots. Startup and
 * every default-installation GitHub request update this state through
 * installation-token minting. */
export function githubAppCredentialHealth():
  | "operational"
  | "unavailable"
  | "unchecked" {
  if (!githubConfiguredCredential()) return "unavailable";
  const identity = `${githubUserAuthSettings().clientId || ""}:${installationSelector()}`;
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
  clearAppCaches();
}

/** Remove only a UI-managed key. An ops-managed path is external authority and
 * must never be mutated by the Settings removal flow. */
export function removeGithubAppKey(): void {
  // The App config may be UI-managed while its key path is ops-managed. In
  // that mixed mode, preserve the external file but still invalidate tokens.
  if (!process.env.OPENSESSION_GITHUB_APP_KEY)
    rmSync(keyPath(), { force: true });
  clearAppCaches();
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
    if (key === null) clearAppCaches();
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
    clearAppCaches();
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
  const owner = githubRepoOwner(ghRepo);
  return (
    !!owner &&
    !!installationOwner &&
    owner.toLowerCase() === installationOwner.toLowerCase()
  );
}

export async function githubAppRepositoryToken(
  ghRepo: string,
  opts: { readOnly?: boolean } = {},
): Promise<string | null> {
  if (!githubConfiguredCredential()) return null;
  const owner = githubRepoOwner(ghRepo);
  const repo = ghRepo.split("/")[1];
  if (!owner || !repo) return null;
  const headers = await appAuthHeaders().catch(() => null);
  if (!headers) return null;
  try {
    // The installation is the one for this repository's owner. An owner the
    // App is not installed on fails closed here, and GitHub refuses the mint
    // anyway when the installation cannot see the repository.
    const installation = await selectInstallation(owner, headers);
    if (!githubRepositoryMatchesInstallation(ghRepo, installation.owner)) {
      throw new Error(`installation belongs to ${installation.owner}`);
    }
    // Code runs can push their branch, reply, and inspect the failing checks
    // and Actions logs they are expected to repair. Read-only callers
    // (ask-mode runs) get the read set: the same visibility with no write
    // capability behind it.
    const token = await mintInstallationToken(installation.id, headers, {
      repositories: [repo],
      permissions: opts.readOnly ? READ_PERMISSIONS : CODE_PERMISSIONS,
    });
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
export async function githubAppEnv(
  repo?: string,
): Promise<Record<string, string> | null> {
  const token = await githubToken(repo ? { repo } : {});
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

/** Read-only sibling of githubServiceCredentialEnv for runs that inspect
 * GitHub state through `gh` while processing untrusted repository content:
 * same fail-closed env shape (including the SSH-to-HTTPS rewrite), minting
 * the repository-scoped read permission set so nothing behind the token can
 * write. */
export async function githubServiceReadOnlyEnv(
  ghRepo?: string,
): Promise<Record<string, string>> {
  const token = ghRepo
    ? await githubAppRepositoryToken(ghRepo, { readOnly: true })
    : await githubToken();
  return githubGitCredentialEnv(token || "");
}

/**
 * The git author/committer identity for commits an agent run makes: the App's
 * bot user, with GitHub's noreply address so the commits link to the bot
 * account. Null when no App is configured. The human behind the run rides
 * along as a `Co-authored-by` trailer (docs/github-authority.md,
 * "Attribution"); no run carries a person's git identity.
 */
export async function githubBotGitIdentity(): Promise<{
  name: string;
  email: string;
} | null> {
  const slug = githubAppIdentity().slug;
  if (!slug) return null;
  const login = `${slug}[bot]`;
  const cached = g.__ghBotIdentity;
  if (cached?.login === login) return cached.identity;
  let id: number | undefined;
  try {
    const token = await githubToken();
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (res.ok) id = ((await res.json()) as { id?: number }).id;
  } catch {}
  const identity = {
    name: login,
    email: `${id ? `${id}+` : ""}${login}@users.noreply.github.com`,
  };
  // Only a resolved id is worth remembering; a transient lookup failure
  // should not pin the id-less address for the process lifetime.
  if (id) g.__ghBotIdentity = { login, identity };
  return identity;
}
