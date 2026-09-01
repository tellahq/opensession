/**
 * Server-side repository setup, part of the /api/setup family dispatched from
 * setup.ts:
 *
 *   GET  /api/setup/github/repos: repos the instance's GitHub credential can
 *                                  see, for the registration picker.
 *   POST /api/setup/repos: clone a remote or register an existing local checkout.
 *   PATCH /api/setup/repos/:id: change its default branch or worktree policy.
 */

import { $ } from "bun";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, isAbsolute, join } from "path";
import { audit } from "../audit";
import {
  codeStorageConfig,
  configuredRepos,
  configuredSelfDev,
  type Repo,
  type RepoSection,
} from "../config";
import { remoteUrl as csRemoteUrl } from "../codestorage/auth";
import {
  getRepo as getCsRepo,
  listRepos as listCsRepos,
} from "../codestorage/client";
import {
  cloneCsCheckout,
  ensureCsCredentialHelper,
} from "../codestorage/remote";
import {
  persistRawConfig,
  rawConfig,
  reposForMutation,
  repoSectionForMutation,
  withConfigMutationLock,
} from "../config-mutation";
import {
  githubAppInstallUrl,
  githubCredentialForLogin,
  resolveGithubCredential,
  serviceGithubCredential,
  type GithubCredential,
} from "../github-auth";
import { githubCredentialHelperCommand } from "../github-git-credential";
import { homeDir } from "../paths";
import { fetchWithTimeout } from "../shared/fetch-with-timeout";
import { shellSafeDefaultBranch } from "../repo-branch";
import type { RouteContext } from "./context";
import {
  inspectRepo,
  normalizeRepoOrigin,
  repoCurrentBranch,
  repoHasBranch,
  repoIdFromName,
  repoOriginIdentity,
} from "./repo-inspection";

/** Strict: this value reaches a spawn argv (always array-spawned, never a
 *  shell string — the regex is belt AND suspenders). */
export const GITHUB_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

export { githubCredentialHelperCommand };

export function validGithubFullName(value: unknown): value is string {
  return typeof value === "string" && GITHUB_FULL_NAME_RE.test(value);
}

/** After the shared shell/Markdown boundary check, let Git enforce the
 * remaining ref grammar. */
export async function normalizeDefaultBranch(
  value: unknown,
): Promise<string | null> {
  const branch = shellSafeDefaultBranch(value);
  if (!branch) return null;
  const checked = Bun.spawn(["git", "check-ref-format", "--branch", branch], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await checked.exited) === 0 ? branch : null;
}

async function normalizeInspectedDefaultBranch(
  value: unknown,
): Promise<string> {
  const branch = await normalizeDefaultBranch(value);
  if (branch) return branch;
  throw new Error(
    "Repository default branch may use only letters, numbers, '.', '_', '@', '%', '+', '=', ':', ',', '/', and '-'",
  );
}

/**
 * The GitHub credential to act with for listing and cloning: the signed-in
 * user's stored App token when GitHub authentication is active. With no
 * authenticated teammate, repository setup uses the workspace App.
 */
function actingGithubCredential(ctx: RouteContext): GithubCredential | null {
  return ctx.authUser?.login
    ? githubCredentialForLogin(ctx.authUser.login)
    : null;
}

/** Prefer the configured App installation, whose selected repositories are the
 * source of truth for workspace setup. A configured but unavailable App fails
 * closed instead of being masked by a user's narrower token. Without a service
 * configuration, a signed-in teammate remains the compatibility path.
 * Repository setup never inherits the server user's ambient gh login. */
async function setupGithubCredential(
  ctx: RouteContext,
): Promise<GithubCredential | null> {
  const { githubConfiguredCredential } = await import("../github-app");
  if (githubConfiguredCredential()) {
    try {
      return await resolveGithubCredential(serviceGithubCredential);
    } catch {
      // A just-installed App can take a moment to appear in GitHub's installation
      // list. Retry once so the next onboarding step does not race that edge.
      await Bun.sleep(750);
      return resolveGithubCredential(serviceGithubCredential).catch(() => null);
    }
  }
  return actingGithubCredential(ctx);
}

// ── GitHub repo listing ──────────────────────────────────────────────────────

interface PickerRepo {
  fullName: string;
  private: boolean;
  description?: string;
  defaultBranch: string;
  registered: boolean;
  /** For pushed_at-desc sorting; stripped before responding. */
  pushedAt?: string;
}

const REPO_LIST_CAP = 300;
const REPO_CACHE_TTL_MS = 60_000;

/** 60s in-module cache keyed by credential principal, to keep the picker
 *  snappy across the setup page's refetches. */
const repoListCache = new Map<
  string,
  { at: number; payload: { source: "user" | "app"; repos: PickerRepo[] } }
>();

async function githubJson(
  token: string,
  url: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opensession",
    },
  });
  return {
    ok: res.ok,
    status: res.status,
    body: await res.json().catch(() => null),
  };
}

function toPickerRepo(r: any, registeredNames: Set<string>): PickerRepo | null {
  const fullName = typeof r?.full_name === "string" ? r.full_name : null;
  if (!fullName) return null;
  return {
    fullName,
    private: r.private === true,
    ...(typeof r.description === "string" && r.description
      ? { description: r.description }
      : {}),
    defaultBranch:
      typeof r.default_branch === "string" ? r.default_branch : "main",
    registered: registeredNames.has(fullName.toLowerCase()),
    ...(typeof r.pushed_at === "string" ? { pushedAt: r.pushed_at } : {}),
  };
}

/** Registered ghRepo names, lowercased, for the picker's `registered` flag. */
function registeredGhRepos(): Set<string> {
  return new Set(
    Object.values(configuredRepos())
      .map((r) => r.ghRepo.toLowerCase())
      .filter(Boolean),
  );
}

/** User-token path: everything the connected teammate can access. */
async function listReposViaUserRepos(token: string): Promise<PickerRepo[]> {
  const registered = registeredGhRepos();
  const repos: PickerRepo[] = [];
  for (let page = 1; repos.length < REPO_LIST_CAP && page <= 5; page++) {
    const { ok, body } = await githubJson(
      token,
      `https://api.github.com/user/repos?per_page=100&affiliation=owner,organization_member&sort=pushed&page=${page}`,
    );
    if (!ok || !Array.isArray(body)) break;
    for (const r of body) {
      const repo = toPickerRepo(r, registered);
      if (repo) repos.push(repo);
    }
    if (body.length < 100) break;
  }
  return repos.slice(0, REPO_LIST_CAP);
}

/** GitHub App installation-token path. Installation tokens cannot call the
 * user endpoints used by PATs and App user tokens. */
export async function listReposViaAppInstallation(
  token: string,
): Promise<PickerRepo[]> {
  const registered = registeredGhRepos();
  const repos: PickerRepo[] = [];
  for (let page = 1; repos.length < REPO_LIST_CAP && page <= 5; page++) {
    const { ok, body } = await githubJson(
      token,
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
    );
    if (!ok || !Array.isArray(body?.repositories)) break;
    for (const raw of body.repositories) {
      const repo = toPickerRepo(raw, registered);
      if (repo) repos.push(repo);
    }
    if (body.repositories.length < 100) break;
  }
  return repos.slice(0, REPO_LIST_CAP);
}

/** GitHub App user-token path: union of the token's accessible installations.
 *  Returns null when the token isn't installation-scoped (a non-installation OAuth token)
 *  so the caller can fall back to /user/repos. */
async function listReposViaInstallations(
  token: string,
): Promise<PickerRepo[] | null> {
  const installations = await githubJson(
    token,
    "https://api.github.com/user/installations?per_page=100",
  );
  const list = installations.body?.installations;
  if (!installations.ok || !Array.isArray(list)) return null;
  const registered = registeredGhRepos();
  const repos: PickerRepo[] = [];
  for (const installation of list) {
    const id = installation?.id;
    if (typeof id !== "number") continue;
    for (let page = 1; repos.length < REPO_LIST_CAP && page <= 5; page++) {
      const { ok, body } = await githubJson(
        token,
        `https://api.github.com/user/installations/${id}/repositories?per_page=100&page=${page}`,
      );
      if (!ok || !Array.isArray(body?.repositories)) break;
      for (const r of body.repositories) {
        const repo = toPickerRepo(r, registered);
        if (repo) repos.push(repo);
      }
      if (body.repositories.length < 100) break;
    }
    if (repos.length >= REPO_LIST_CAP) break;
  }
  return repos.slice(0, REPO_LIST_CAP);
}

// ── code.storage repo listing ────────────────────────────────────────────────

/** Same 60s snappiness as the GitHub cache; one org per instance, one slot. */
let csRepoListCache: {
  at: number;
  payload: { source: "org"; repos: PickerRepo[] };
} | null = null;

/** Drop the cached org repo list — the connect/disconnect flow
 *  (setup-codestorage.ts) calls this so the setup wizard's code.storage
 *  section reflects the new connection immediately instead of serving a
 *  stale (pre-connect or pre-disconnect) probe for up to 60s. */
export function invalidateCsRepoListCache(): void {
  csRepoListCache = null;
}

/** Registered csRepo paths, lowercased, for the picker's `registered` flag. */
function registeredCsRepos(): Set<string> {
  return new Set(
    Object.values(configuredRepos())
      .filter((r) => r.host === "codestorage")
      .map((r) => (r.csRepo || "").toLowerCase())
      .filter(Boolean),
  );
}

/** Everything the org's signing key can see. Mirrors the /setup/github/repos
 *  shape so the wizard renders either host with the same component. */
async function listCodestorageRepos(): Promise<PickerRepo[]> {
  const registered = registeredCsRepos();
  const repos = await listCsRepos();
  return repos
    .map((r) => ({
      fullName: r.url || r.repo_id,
      // No public/private concept — repos are only reachable with an org JWT.
      private: true,
      defaultBranch: r.default_branch || "main",
      registered: registered.has((r.url || r.repo_id).toLowerCase()),
      ...(typeof r.created_at === "string" ? { pushedAt: r.created_at } : {}),
    }))
    .slice(0, REPO_LIST_CAP);
}

// ── Server-side clone + register ─────────────────────────────────────────────

async function runCommand(
  argv: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(argv, {
    env: {
      ...process.env,
      GIT_SSH_COMMAND:
        process.env.GIT_SSH_COMMAND ||
        "ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 -o ServerAliveCountMax=3",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(9), timeoutMs);
  const [exitCode, stderr] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timeout)),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim() };
}

/** Replace every occurrence of a secret in text bound for a log or an API
 *  error. Cheap and total, so a token can't ride out on a clone failure. */
function scrubSecret(text: string, secret?: string): string {
  return secret ? text.split(secret).join("***") : text;
}

/**
 * Clone `owner/name` to `dest`, NEVER embedding a credential in the persisted
 * remote URL. Both paths take the full https URL (never the bare owner/name) so
 * a `-`-prefixed name can't be read as a CLI flag.
 *
 * With a connected user token, clone privately and secretlessly: the token
 * reaches git only through a 0700 GIT_ASKPASS helper that echoes it for the
 * password prompt — never in argv (ps-visible), never in .git/config. The URL
 * carries the username `x-access-token` (GitHub's app-token username, not a
 * secret) so git skips the username prompt; origin is normalized to the
 * tokenless URL afterward, holding the "no credential in the persisted remote"
 * invariant. Without a token, use an anonymous HTTPS clone. Never invoke the
 * host's ambient gh login: repository setup is authorized only by the selected
 * user or the configured GitHub App installation.
 */
async function cloneGithubRepo(
  fullName: string,
  dest: string,
  userToken?: string,
): Promise<void> {
  const cleanUrl = `https://github.com/${fullName}.git`;
  if (userToken) {
    const askpassDir = mkdtempSync(join(tmpdir(), "os-gh-askpass-"));
    const askpass = join(askpassDir, "askpass.sh");
    // The script body is static and secret-free: git passes the prompt text as
    // $1, and the helper echoes the username or the token from the environment
    // (which only this child and its git subprocess can read).
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n*[Uu]sername*) printf %s "$GIT_USERNAME" ;;\n*) printf %s "$GIT_PASSWORD" ;;\nesac\n',
      { mode: 0o700 },
    );
    chmodSync(askpass, 0o700); // belt against a permissive umask on create
    try {
      const result = await runCommand(
        [
          "git",
          "clone",
          "--",
          `https://x-access-token@github.com/${fullName}.git`,
          dest,
        ],
        5 * 60_000,
        {
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: "0",
          GIT_USERNAME: "x-access-token",
          GIT_PASSWORD: userToken,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          scrubSecret(result.stderr, userToken) || "git clone failed",
        );
      }
      // The token never touched the persisted remote (it lived only in the
      // askpass env), but drop the username too so origin is the plain URL.
      await runCommand(
        ["git", "-C", dest, "remote", "set-url", "origin", cleanUrl],
        30_000,
      );
    } finally {
      rmSync(askpassDir, { recursive: true, force: true });
    }
    return;
  }
  const result = await runCommand(
    ["git", "clone", "--", cleanUrl, dest],
    5 * 60_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "git clone failed");
  }
}

function checkoutsRoot(): string {
  return `${homeDir()}/checkouts`;
}

function setupRepoError(message: string, status: number): Error {
  const error = new Error(message);
  (error as Error & { status: number }).status = status;
  return error;
}

function statusForError(error: unknown, fallback = 500): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : fallback;
}

function canonicalRepoPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sectionFromRepo(repo: Repo): RepoSection {
  const { id: _id, ...section } = repo;
  return section;
}

function assertRepoSlotAvailable(
  id: string,
  registered: Record<string, Repo>,
): void {
  if (registered[id]) {
    throw setupRepoError(`Repository id already registered: ${id}`, 409);
  }
  if (Object.values(registered).some((repo) => repo.wtPrefix === id)) {
    throw setupRepoError(`Worktree prefix already registered: ${id}`, 409);
  }
}

function assertRepoPathAvailable(
  path: string,
  registered: Record<string, Repo>,
): void {
  const canonical = canonicalRepoPath(path);
  if (
    Object.values(registered).some(
      (repo) => canonicalRepoPath(repo.repo) === canonical,
    )
  ) {
    throw setupRepoError(`Repository is already registered: ${canonical}`, 409);
  }
}

async function assertRepoOriginAvailable(
  originIdentity: string,
  registered: Record<string, Repo>,
): Promise<void> {
  if (!originIdentity) return;
  const matches = await Promise.all(
    Object.values(registered).map(async (repo) => ({
      repo,
      originIdentity: await repoOriginIdentity(repo.repo),
    })),
  );
  const duplicate = matches.find(
    (match) => match.originIdentity === originIdentity,
  );
  if (duplicate) {
    throw setupRepoError(
      `Repository origin is already registered: ${duplicate.repo.id}`,
      409,
    );
  }
}

/** Once config has an explicit `repos` object it becomes authoritative. Seed
 *  it from the effective registry when the first repo is added so turning an
 *  implicit built-in registry into an explicit one cannot remove that repo. */
function repoSectionsForMutation(
  config: Record<string, unknown>,
  registered: Record<string, Repo>,
): Record<string, RepoSection> {
  if (config.repos === undefined) {
    return Object.fromEntries(
      Object.entries(registered).map(([id, repo]) => [
        id,
        sectionFromRepo(repo),
      ]),
    );
  }
  if (
    !config.repos ||
    typeof config.repos !== "object" ||
    Array.isArray(config.repos)
  ) {
    throw new Error("Config repos must contain a JSON object");
  }
  return { ...(config.repos as Record<string, RepoSection>) };
}

function persistRepoRegistration(input: {
  id: string;
  entry: RepoSection;
  registered: Record<string, Repo>;
  auditRepo: string;
  adopted?: boolean;
}): RepoSection & { id: string } {
  const config = rawConfig();
  const repos = repoSectionsForMutation(config, input.registered);
  const entry: RepoSection = {
    ...input.entry,
    ...(Object.keys(input.registered).length === 0 ? { default: true } : {}),
  };
  repos[input.id] = entry;
  config.repos = repos;
  persistRawConfig(config);
  // Registration changes the `registered` bit in both browse payloads. Do not
  // serve a stale Add button when the picker reopens after a background clone.
  repoListCache.clear();
  csRepoListCache = null;
  audit({
    kind: "setup_repo_register",
    repo: input.auditRepo,
    id: input.id,
    path: entry.repo,
    ...(input.adopted ? { adopted: true } : {}),
  });
  return { id: input.id, ...entry };
}

async function configureGithubCredentialHelper(
  checkoutPath: string,
): Promise<void> {
  const helperKey = "credential.https://github.com.helper";
  await $`git -C ${checkoutPath} config --replace-all ${helperKey} ${""}`.quiet();
  await $`git -C ${checkoutPath} config --add ${helperKey} ${githubCredentialHelperCommand()}`.quiet();
}

/**
 * Adopt a checkout already sitting at the clone destination, or refuse.
 *
 * Uninstall deliberately preserves ~/checkouts — it is the user's code, not
 * app state — so a reinstall (or any re-registration after the repo was
 * removed from config) starts with an empty config and a full checkouts dir.
 * Registering the same repo again should take what is on disk instead of
 * failing, which also works before GitHub auth is set up: adoption needs no
 * token, only the existing origin.
 *
 * Returns the inspected repo when the path holds a checkout of the very repo
 * being registered (so the caller can skip the clone and keep the checkout on
 * a later failure), null when nothing is there. Anything else at the path — a
 * non-git directory, or a checkout of a DIFFERENT repo — still throws, since
 * adopting it would silently register the wrong code.
 */
type InspectedRepo = Awaited<ReturnType<typeof inspectRepo>>;

export async function adoptExistingCheckout(
  dest: string,
  matches: (inspected: InspectedRepo) => boolean,
): Promise<InspectedRepo | null> {
  if (!existsSync(dest)) return null;
  const inspected = await inspectRepo(dest).catch(() => null);
  if (!inspected || !matches(inspected)) {
    throw new Error(`Clone destination already exists: ${dest}`);
  }
  return inspected;
}

async function registerGithubRepo(input: {
  fullName: string;
  id?: string;
  /** Connected user credential for the private clone and later Git operations. */
  credential?: GithubCredential;
}): Promise<RepoSection & { id: string }> {
  const name = input.fullName.split("/")[1];
  const id = repoIdFromName(input.id?.trim() || name);
  const registered = configuredRepos();
  assertRepoSlotAvailable(id, registered);
  if (
    Object.values(registered).some(
      (repo) => repo.ghRepo.toLowerCase() === input.fullName.toLowerCase(),
    )
  ) {
    throw setupRepoError(
      `GitHub repository is already registered: ${input.fullName}`,
      409,
    );
  }
  const root = checkoutsRoot();
  const dest = `${root}/${id}`;
  assertRepoPathAvailable(dest, registered);
  await assertRepoOriginAvailable(
    normalizeRepoOrigin(`https://github.com/${input.fullName}.git`),
    registered,
  );
  const adopted = await adoptExistingCheckout(
    dest,
    (i) => (i.ghRepo || "").toLowerCase() === input.fullName.toLowerCase(),
  );
  mkdirSync(root, { recursive: true });
  try {
    if (!adopted) {
      await cloneGithubRepo(
        input.fullName,
        dest,
        input.credential?.env.GH_TOKEN,
      );
    }
    // A private clone authenticated through a one-shot GIT_ASKPASS leaves a
    // tokenless remote. Wire the helper for future fetches and pushes, and
    // refresh it on a checkout preserved from an earlier install.
    if (input.credential) await configureGithubCredentialHelper(dest);
    const inspected = adopted ?? (await inspectRepo(dest));
    const defaultBranch = await normalizeInspectedDefaultBranch(
      inspected.defaultBranch,
    );
    return persistRepoRegistration({
      id,
      registered,
      auditRepo: input.fullName,
      adopted: Boolean(adopted),
      entry: {
        label: name,
        repo: inspected.path,
        wtPrefix: id,
        defaultBranch,
        ghRepo: inspected.ghRepo || input.fullName,
      },
    });
  } catch (error) {
    // Only clean up a checkout this call created. An adopted one predates us.
    if (!adopted) rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

async function inspectLocalRepo(input: {
  path: string;
  id?: string;
}): Promise<{ inspected: InspectedRepo; name: string; id: string }> {
  try {
    const inspected = await inspectRepo(input.path);
    const name = basename(inspected.path);
    return {
      inspected,
      name,
      id: repoIdFromName(input.id?.trim() || name),
    };
  } catch (error) {
    throw setupRepoError(
      error instanceof Error ? error.message : String(error),
      400,
    );
  }
}

async function registerLocalRepo(input: {
  inspected: InspectedRepo;
  name: string;
  id: string;
}): Promise<RepoSection & { id: string }> {
  const { inspected, name, id } = input;
  const registered = configuredRepos();
  assertRepoSlotAvailable(id, registered);
  assertRepoPathAvailable(inspected.path, registered);
  if (
    inspected.ghRepo &&
    Object.values(registered).some(
      (repo) => repo.ghRepo.toLowerCase() === inspected.ghRepo!.toLowerCase(),
    )
  ) {
    throw setupRepoError(
      `GitHub repository is already registered: ${inspected.ghRepo}`,
      409,
    );
  }
  if (
    inspected.cs &&
    Object.values(registered).some(
      (repo) =>
        repo.host === "codestorage" &&
        repo.csRepo?.toLowerCase() === inspected.cs!.repoId.toLowerCase(),
    )
  ) {
    throw setupRepoError(
      `code.storage repository is already registered: ${inspected.cs.repoId}`,
      409,
    );
  }
  await assertRepoOriginAvailable(inspected.originIdentity, registered);
  if (inspected.cs) {
    const csConfig = codeStorageConfig();
    if (!csConfig) {
      throw setupRepoError(
        "code.storage is not configured (integrations.codeStorage)",
        400,
      );
    }
    if (csConfig.org !== inspected.cs.org) {
      throw setupRepoError(
        `code.storage is configured for ${csConfig.org}, not ${inspected.cs.org}`,
        400,
      );
    }
    await ensureCsCredentialHelper(inspected.path, inspected.cs.org);
  }

  const defaultBranch = await normalizeInspectedDefaultBranch(
    inspected.defaultBranch,
  );
  return persistRepoRegistration({
    id,
    registered,
    auditRepo: inspected.path,
    entry: {
      label: name,
      repo: inspected.path,
      wtPrefix: id,
      defaultBranch,
      ...(inspected.ghRepo ? { ghRepo: inspected.ghRepo } : {}),
      ...(inspected.cs
        ? { host: "codestorage" as const, csRepo: inspected.cs.repoId }
        : {}),
    },
  });
}

/** code.storage repo path, e.g. "acme/widget" — only ever reaches an https
 *  URL (and the array-spawned git argv behind `--`). */
export const CS_REPO_ID_RE = /^[\w.-]+(?:\/[\w.-]+)*$/;

export function validCsRepoId(value: unknown): value is string {
  return typeof value === "string" && CS_REPO_ID_RE.test(value);
}

export function matchesCodeStorageCheckout(
  inspected: InspectedRepo,
  org: string,
  repoId: string,
): boolean {
  return (
    inspected.cs?.org.toLowerCase() === org.toLowerCase() &&
    inspected.cs.repoId.toLowerCase() === repoId.toLowerCase()
  );
}

async function registerCodestorageRepo(input: {
  repoId: string;
  id?: string;
}): Promise<RepoSection & { id: string }> {
  const cfg = codeStorageConfig();
  if (!cfg)
    throw new Error(
      "code.storage is not configured (integrations.codeStorage)",
    );
  // Resolve through the REST API: validates existence and canonicalizes the
  // repo path before anything touches disk or config.
  const resolved = await getCsRepo(input.repoId);
  const csRepo = resolved.url || input.repoId;
  const name = csRepo.split("/").pop() || csRepo;
  const id = repoIdFromName(input.id?.trim() || name);
  const registered = configuredRepos();
  assertRepoSlotAvailable(id, registered);
  if (
    Object.values(registered).some(
      (repo) =>
        repo.host === "codestorage" &&
        repo.csRepo?.toLowerCase() === csRepo.toLowerCase(),
    )
  ) {
    throw setupRepoError(
      `code.storage repository is already registered: ${csRepo}`,
      409,
    );
  }
  const root = checkoutsRoot();
  const dest = `${root}/${id}`;
  assertRepoPathAvailable(dest, registered);
  await assertRepoOriginAvailable(
    normalizeRepoOrigin(csRemoteUrl(cfg.org, csRepo)),
    registered,
  );
  const adopted = await adoptExistingCheckout(dest, (i) =>
    matchesCodeStorageCheckout(i, cfg.org, csRepo),
  );
  mkdirSync(root, { recursive: true });
  try {
    // Clones with a short-lived JWT, persists the credential-free remote, and
    // wires the URL-scoped credential helper for ambient git fetch/push. Boot
    // rewires the helper on a checkout preserved from an earlier install.
    if (!adopted) await cloneCsCheckout(csRepo, dest);
    const inspected = adopted ?? (await inspectRepo(dest));
    const defaultBranch = await normalizeInspectedDefaultBranch(
      inspected.defaultBranch,
    );
    return persistRepoRegistration({
      id,
      registered,
      auditRepo: csRepo,
      adopted: Boolean(adopted),
      entry: {
        label: name,
        repo: inspected.path,
        wtPrefix: id,
        defaultBranch,
        host: "codestorage",
        csRepo,
      },
    });
  } catch (error) {
    if (!adopted) rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

/**
 * `selfDev` was the first, instance-wide escape hatch for shared checkouts.
 * Once someone edits one repository in the UI, preserve every repository's
 * effective behavior as a per-repo `sharedCheckout` value and retire the
 * global override. That makes later toggles independent without changing any
 * repository the person did not touch.
 */
function migrateLegacySelfDev(
  config: Record<string, unknown>,
  resolvedRepos: Record<string, Repo>,
): void {
  if (config.selfDev === undefined) return;
  const legacyIsolated = config.selfDev === "worktree";
  const sections = reposForMutation(config, resolvedRepos);
  for (const repo of Object.values(resolvedRepos)) {
    if (!repo.sharedCheckout) continue;
    const section = sections[repo.id];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      (section as Record<string, unknown>).sharedCheckout = !legacyIsolated;
    }
  }
  delete config.selfDev;
}

// ── Routes ───────────────────────────────────────────────────────────────────

function registrationErrorResponse(error: unknown): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: statusForError(error) },
  );
}

async function registrationResponse(
  register: () => Promise<RepoSection & { id: string }>,
): Promise<Response> {
  try {
    const repo = await withConfigMutationLock(register);
    return Response.json(repo, { status: 201 });
  } catch (error) {
    return registrationErrorResponse(error);
  }
}

export async function handleSetupRepoRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/setup/github/repos" && req.method === "GET") {
    // Browse the repositories selected for the workspace App installation.
    // A connected teammate is only a compatibility path when no App service
    // credential is configured; ambient credentials are never consulted.
    const credential = await setupGithubCredential(ctx);
    const token = credential?.env.GH_TOKEN;
    const source: "user" | "app" | null = credential
      ? credential.kind === "user"
        ? "user"
        : "app"
      : null;
    if (!token || !source) {
      const { githubConfiguredCredential } = await import("../github-app");
      return Response.json({
        source: null,
        repos: [],
        appConfigured: githubConfiguredCredential(),
        appInstallUrl: githubAppInstallUrl(),
      });
    }
    const cacheKey = credential.principal;
    const cached = repoListCache.get(cacheKey);
    if (cached && Date.now() - cached.at < REPO_CACHE_TTL_MS) {
      return Response.json(cached.payload);
    }
    try {
      // Installation tokens have a direct repository list. App user tokens list
      // through their installations, with /user/repos as a compatibility path
      // for older non-expiring OAuth grants already stored before migration.
      const repos =
        source === "app"
          ? await listReposViaAppInstallation(token)
          : ((await listReposViaInstallations(token)) ??
            (await listReposViaUserRepos(token)));
      repos.sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""));
      const payload = {
        source,
        repos: repos.map(({ pushedAt: _pushedAt, ...repo }) => repo),
      };
      repoListCache.set(cacheKey, { at: Date.now(), payload });
      return Response.json(payload);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      );
    }
  }

  if (path === "/api/setup/codestorage/repos" && req.method === "GET") {
    // Same well-formed empty answer as the GitHub route when unconfigured, so
    // the wizard can probe both hosts unconditionally.
    if (!codeStorageConfig()) return Response.json({ source: null, repos: [] });
    if (
      csRepoListCache &&
      Date.now() - csRepoListCache.at < REPO_CACHE_TTL_MS
    ) {
      return Response.json(csRepoListCache.payload);
    }
    try {
      const repos = await listCodestorageRepos();
      repos.sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""));
      const payload = {
        source: "org" as const,
        repos: repos.map(({ pushedAt: _pushedAt, ...repo }) => repo),
      };
      csRepoListCache = { at: Date.now(), payload };
      return Response.json(payload);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      );
    }
  }

  if (path === "/api/setup/repos" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      source?: unknown;
      fullName?: unknown;
      repoId?: unknown;
      path?: unknown;
      id?: unknown;
    } | null;
    if (body?.source === "local") {
      if (typeof body.path !== "string" || !isAbsolute(body.path.trim())) {
        return Response.json(
          { error: "path must be an absolute path to a Git repository" },
          { status: 400 },
        );
      }
      const localPath = body.path.trim();
      if (
        body?.id !== undefined &&
        (typeof body.id !== "string" || !body.id.trim())
      ) {
        return Response.json(
          { error: "id must be a non-empty string" },
          { status: 400 },
        );
      }
      let inspected: Awaited<ReturnType<typeof inspectLocalRepo>>;
      try {
        inspected = await inspectLocalRepo({
          path: localPath,
          ...(typeof body.id === "string" ? { id: body.id } : {}),
        });
      } catch (error) {
        return registrationErrorResponse(error);
      }
      return registrationResponse(() => registerLocalRepo(inspected));
    }
    if (body?.source === "codestorage") {
      // Accepts the id under either key so the wizard can reuse its GitHub
      // submit shape ({fullName}) unchanged.
      const repoId = body?.repoId ?? body?.fullName;
      if (!validCsRepoId(repoId)) {
        return Response.json(
          {
            error: "repoId must be a code.storage repo path (e.g. acme/widget)",
          },
          { status: 400 },
        );
      }
      if (
        body?.id !== undefined &&
        (typeof body.id !== "string" || !body.id.trim())
      ) {
        return Response.json(
          { error: "id must be a non-empty string" },
          { status: 400 },
        );
      }
      if (!codeStorageConfig()) {
        return Response.json(
          {
            error: "code.storage is not configured (integrations.codeStorage)",
          },
          { status: 400 },
        );
      }
      return registrationResponse(() =>
        registerCodestorageRepo({
          repoId,
          ...(typeof body!.id === "string" ? { id: body!.id } : {}),
        }),
      );
    }
    if (!validGithubFullName(body?.fullName)) {
      return Response.json(
        { error: "fullName must be a GitHub owner/name" },
        { status: 400 },
      );
    }
    if (
      body?.id !== undefined &&
      (typeof body.id !== "string" || !body.id.trim())
    ) {
      return Response.json(
        { error: "id must be a non-empty string" },
        { status: 400 },
      );
    }
    // The acting token lets a private clone succeed without ambient gh /
    // credential-helper auth; absent, the clone stays anonymous (public repos).
    const credential = await setupGithubCredential(ctx);
    if (!credential) {
      const { githubConfiguredCredential } = await import("../github-app");
      if (githubConfiguredCredential()) {
        return Response.json(
          {
            error:
              "The configured GitHub App installation is unavailable. Check the installation owner and make sure the App is installed for this repository.",
          },
          { status: 409 },
        );
      }
    }
    return registrationResponse(() =>
      registerGithubRepo({
        fullName: body!.fullName as string,
        ...(typeof body!.id === "string" ? { id: body!.id } : {}),
        ...(credential ? { credential } : {}),
      }),
    );
  }

  const updateMatch = path.match(/^\/api\/setup\/repos\/([^/]+)$/);
  if (updateMatch && req.method === "PATCH") {
    let id: string;
    try {
      id = decodeURIComponent(updateMatch[1]);
    } catch {
      return Response.json({ error: "Invalid repository id" }, { status: 400 });
    }
    if (["__proto__", "prototype", "constructor"].includes(id)) {
      return Response.json({ error: "Invalid repository id" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as {
      defaultBranch?: unknown;
      isolatedWorktrees?: unknown;
    } | null;
    if (!body) {
      return Response.json({ error: "expected a JSON body" }, { status: 400 });
    }
    const changesBranch = body.defaultBranch !== undefined;
    const changesWorktrees = body.isolatedWorktrees !== undefined;
    if (!changesBranch && !changesWorktrees) {
      return Response.json(
        { error: "No repository setting provided" },
        { status: 400 },
      );
    }
    if (changesWorktrees && typeof body.isolatedWorktrees !== "boolean") {
      return Response.json(
        { error: "isolatedWorktrees must be a boolean" },
        { status: 400 },
      );
    }
    const defaultBranch = changesBranch
      ? await normalizeDefaultBranch(body.defaultBranch)
      : null;
    if (changesBranch && !defaultBranch) {
      return Response.json(
        { error: "defaultBranch must be a shell-safe Git branch" },
        { status: 400 },
      );
    }

    const repos = configuredRepos();
    if (!Object.hasOwn(repos, id)) {
      return Response.json(
        { error: `Unknown repository: ${id}` },
        { status: 404 },
      );
    }
    const repo = repos[id];
    if (defaultBranch && !(await repoHasBranch(repo.repo, defaultBranch))) {
      return Response.json(
        { error: `Branch not found on ${id}'s origin: ${defaultBranch}` },
        { status: 400 },
      );
    }
    if (defaultBranch && repo.sharedCheckout) {
      const current = await repoCurrentBranch(repo.repo);
      if (current !== defaultBranch) {
        return Response.json(
          {
            error: `The shared checkout is on ${current || "a detached HEAD"}. Switch it to ${defaultBranch} before changing the default branch.`,
          },
          { status: 400 },
        );
      }
    }

    try {
      const updated = await withConfigMutationLock(async () => {
        const config = rawConfig();
        if (changesWorktrees) migrateLegacySelfDev(config, repos);
        const section = repoSectionForMutation(config, id);
        if (!section) return null;
        if (defaultBranch) section.defaultBranch = defaultBranch;
        if (changesWorktrees) {
          section.sharedCheckout = !(body.isolatedWorktrees as boolean);
        }
        persistRawConfig(config);
        const result = {
          id,
          defaultBranch: defaultBranch || repo.defaultBranch,
          isolatedWorktrees: changesWorktrees
            ? (body.isolatedWorktrees as boolean)
            : !repo.sharedCheckout || configuredSelfDev() === "worktree",
        };
        audit({ kind: "setup_repo_update", ...result });
        return result;
      });
      if (!updated) {
        return Response.json(
          { error: `Unknown repository: ${id}` },
          { status: 404 },
        );
      }
      if (defaultBranch && process.env.NODE_ENV !== "test") {
        const [
          { scheduleSandboxEnvironmentInvalidation },
          { invalidateAskCheckoutRefresh },
          { invalidatePreviewPoolDefaultBranch },
        ] = await Promise.all([
          import("../sandbox/environments"),
          import("../worktree"),
          import("../preview-pool"),
        ]);
        invalidateAskCheckoutRefresh(id);
        scheduleSandboxEnvironmentInvalidation(id);
        invalidatePreviewPoolDefaultBranch(id);
      }
      return Response.json(updated);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  return undefined;
}
