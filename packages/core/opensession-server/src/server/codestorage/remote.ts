/**
 * Git-remote plumbing for code.storage checkouts.
 *
 * Remotes are plain HTTPS (`https://<org>.code.storage/<repoId>.git`) with
 * username "t" and a JWT password. Rather than embedding a token that expires
 * into the remote URL, checkouts get a URL-scoped git credential helper that
 * mints a fresh JWT per fetch/push (scripts/cs-credential.ts). Helper config
 * is CUMULATIVE across scopes (system/global/local), so the URL-scoped entry
 * is preceded by an empty value — git's documented way to reset the helper
 * list for that context — or an inherited persisting helper (osxkeychain,
 * `credential.helper store`) would both answer first with a stale JWT after
 * expiry and get our short-lived JWTs `approve`d into it at rest. The scope
 * only matches https://<org>.code.storage, never github.com flows. The scope
 * is host-wide (no path in the config key), so it also covers ephemeral
 * remotes (`…/<repoId>+ephemeral.git`) on the same host — one wired checkout
 * authenticates both its origin and any `ephemeral` remote it adds.
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { resolve as resolvePath } from "path";
import { codeStorageConfig, configuredRepos } from "../config";
import { authedRemoteUrl, remoteUrl } from "./auth";

const CREDENTIAL_SCRIPT = resolvePath(
  import.meta.dir,
  "../../../../../../scripts/cs-credential.ts",
);

// https://<org>.code.storage/<repoId>(.git), with optional t:<jwt>@ userinfo.
// Multi-label hosts (api.<org>.code.storage) deliberately don't match.
const CS_REMOTE_RE =
  /^https:\/\/(?:t:[^@]*@)?([A-Za-z0-9][A-Za-z0-9-]*)\.code\.storage\/(.+?)(?:\.git)?\/?$/;

/**
 * Recognize a code.storage remote URL → {org, repoId}, or null.
 *
 * The ephemeral-branches remote form (`…/<repoId>+ephemeral.git`, see
 * https://code.storage/docs/guides/ephemeral-branches.md) resolves to the SAME
 * repo — `+ephemeral` selects a disposable ref namespace, not a different
 * repository — so it parses to the base {org, repoId} with `ephemeral: true`.
 */
export function parseCsRemote(
  url: string,
): { org: string; repoId: string; ephemeral?: boolean } | null {
  const m = url.trim().match(CS_REMOTE_RE);
  if (!m) return null;
  const [, org, rawRepoId] = m;
  if (!org || !rawRepoId) return null;
  const ephemeral = rawRepoId.endsWith("+ephemeral");
  const repoId = ephemeral
    ? rawRepoId.slice(0, -"+ephemeral".length)
    : rawRepoId;
  if (!repoId) return null;
  return ephemeral ? { org, repoId, ephemeral: true } : { org, repoId };
}

/**
 * JWT `repo` claim from a git credential request path ("/<repoId>.git" or
 * "/<repoId>+ephemeral.git"). Ephemeral remotes are the same repo behind a
 * different ref namespace, so the claim is always the bare repoId — the
 * code.storage auth docs scope tokens per repository, not per namespace.
 * Shared with scripts/cs-credential.ts.
 */
export function csRepoClaimFromPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .replace(/\+ephemeral$/, "");
}

/**
 * Point a checkout's code.storage credentials at the minting helper.
 * `useHttpPath` is required: without it git omits the request path, and the
 * helper needs it to scope the JWT's `repo` claim.
 */
export async function configureCsCredentialHelper(
  checkoutPath: string,
  org: string,
): Promise<void> {
  const helperKey = `credential.https://${org}.code.storage.helper`;
  // Two entries, in order: an empty value (resets the helper list inherited
  // from system/global config for this URL scope — see the module doc), then
  // the minting helper. --replace-all keeps re-runs from stacking duplicates.
  await $`git -C ${checkoutPath} config --replace-all ${helperKey} ${""}`.quiet();
  await $`git -C ${checkoutPath} config --add ${helperKey} ${`!bun ${CREDENTIAL_SCRIPT}`}`.quiet();
  await $`git -C ${checkoutPath} config ${`credential.https://${org}.code.storage.useHttpPath`} true`.quiet();
}

/** The exact helper-entry list configureCsCredentialHelper writes. */
function expectedHelperValues(): string[] {
  return ["", `!bun ${CREDENTIAL_SCRIPT}`];
}

/** Idempotent configureCsCredentialHelper: cheap read-before-write so boot
 *  adoption never churns .git/config (or its mtime) on already-wired repos. */
export async function ensureCsCredentialHelper(
  checkoutPath: string,
  org: string,
): Promise<void> {
  const raw =
    await $`git -C ${checkoutPath} config --get-all ${`credential.https://${org}.code.storage.helper`}`
      .quiet()
      .nothrow()
      .text();
  const current = raw.replace(/\n$/, "").split("\n");
  const expected = expectedHelperValues();
  if (
    current.length === expected.length &&
    current.every((v, i) => v === expected[i])
  )
    return;
  await configureCsCredentialHelper(checkoutPath, org);
}

/**
 * Clone a code.storage repo for registration: clone with an embedded
 * short-lived JWT, then persist the credential-free remote and wire the
 * minting helper — so ambient `git fetch`/`git push` (worktree.ts et al.)
 * works from then on without a token ever landing in git config.
 */
export async function cloneCsCheckout(
  repoId: string,
  dest: string,
  org?: string,
): Promise<void> {
  const cfg = codeStorageConfig();
  if (!cfg)
    throw new Error(
      "code.storage is not configured (integrations.codeStorage)",
    );
  const theOrg = org || cfg.org;
  const authed = await authedRemoteUrl(repoId, { org: theOrg });
  const proc = Bun.spawn(["git", "clone", "--", authed, dest], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(9), 5 * 60_000);
  const [exitCode, stderr] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timeout)),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    // git may echo the clone URL (JWT included) into stderr — redact it.
    throw new Error(
      (stderr.trim() || "git clone failed").replace(
        /t:[A-Za-z0-9_.-]+@/g,
        "t:***@",
      ),
    );
  }
  await $`git -C ${dest} remote set-url origin ${remoteUrl(theOrg, repoId)}`.quiet();
  await configureCsCredentialHelper(dest, theOrg);
}

/**
 * Boot adoption: make sure every registered code.storage repo's main checkout
 * has the credential helper wired (e.g. checkouts registered by hand, or
 * synced from another instance). No-op unless configured; best-effort per
 * repo so one bad checkout never blocks the rest.
 */
export async function adoptCsCheckouts(): Promise<void> {
  const cfg = codeStorageConfig();
  if (!cfg) return;
  for (const repo of Object.values(configuredRepos())) {
    if (repo.host !== "codestorage" || !existsSync(repo.repo)) continue;
    try {
      const origin = (
        await $`git -C ${repo.repo} remote get-url origin`
          .quiet()
          .nothrow()
          .text()
      ).trim();
      const org = parseCsRemote(origin)?.org || cfg.org;
      await ensureCsCredentialHelper(repo.repo, org);
    } catch (e) {
      console.warn(
        `[codestorage] credential-helper adoption failed for ${repo.id}:`,
        e,
      );
    }
  }
}
