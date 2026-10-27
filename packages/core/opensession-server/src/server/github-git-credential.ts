/** Process-local Git credential wiring for trusted server-owned Git calls. */

import { existsSync } from "fs";
import { resolve } from "path";
import { SHIM_PATH } from "../../../../../scripts/lib/paths";
import { isCompiledBinary } from "../runner-host/exe";

const GH_CREDENTIAL_SCRIPT = resolve(
  import.meta.dir,
  "../../../../../scripts/gh-credential.ts",
);

function shellQuoteWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Use the stable installed command so compiled releases need neither Bun nor a
 * scripts sidecar. A compiled binary without the shim, such as the Sandbox
 * runner host, re-invokes itself: its `import.meta.dir` is virtual, so the
 * source-tree path would name a file that does not exist in the guest. The
 * source-tree fallback keeps direct development runs useful before install.sh
 * creates the shim.
 */
export function githubCredentialHelperCommand(
  shimPath = SHIM_PATH,
  shimExists = existsSync(shimPath),
  compiled = isCompiledBinary(),
  execPath = process.execPath,
): string {
  if (shimExists) return `!${shellQuoteWord(shimPath)} github-credential`;
  if (compiled) return `!${shellQuoteWord(execPath)} github-credential`;
  return `!bun ${shellQuoteWord(GH_CREDENTIAL_SCRIPT)}`;
}

/**
 * Authentication for one trusted Git subprocess. The token stays in the child
 * environment. Git receives only process-local helper and URL-rewrite config,
 * so existing SSH checkouts use the projected HTTPS identity without mutating
 * .git/config or falling through to a host SSH key.
 *
 * One token does both API calls and git transport. There is deliberately no
 * second, git-only credential: the only way a process pushes is with the
 * identity it was handed, and what that identity may push is GitHub's
 * ruleset decision (docs/github-authority.md).
 */
export function githubGitCredentialEnv(
  token: string,
  helper = githubCredentialHelperCommand(),
): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: helper,
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
    GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
  };
}

/** Answers git with `GH_READ_TOKEN`, the read-only token for the repositories
 *  a run may read beside its own (readRepos). Plain shell, so it works on any
 *  host or Sandbox; the token stays in the environment. */
export const INLINE_GITHUB_READ_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_READ_TOKEN"; }; f';

/**
 * Let git fetch `readRepos` (`owner/name`) with the read token: one helper per
 * repository URL, placed after the helper reset and before the run's own
 * GitHub helper, so it answers for exactly those URLs and every other
 * github.com URL keeps the run's primary credential. Git matches the path
 * as written, so both the `.git` and bare forms are listed.
 */
export function withReadRepoCredentials(
  env: Record<string, string>,
  readRepos: readonly string[],
): Record<string, string> {
  if (!env.GH_READ_TOKEN || !readRepos.length) return env;
  const entries: Array<[string, string]> = [];
  for (let index = 0; ; index++) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    if (key === undefined) break;
    entries.push([key, env[`GIT_CONFIG_VALUE_${index}`] ?? ""]);
  }
  const scoped: Array<[string, string]> = readRepos
    .filter((repo) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    .flatMap((repo) => [
      [
        `credential.https://github.com/${repo}.git.helper`,
        INLINE_GITHUB_READ_CREDENTIAL_HELPER,
      ],
      [
        `credential.https://github.com/${repo}.helper`,
        INLINE_GITHUB_READ_CREDENTIAL_HELPER,
      ],
    ]);
  const general = entries.findIndex(
    ([key, value]) => key === "credential.https://github.com.helper" && value,
  );
  const at = general === -1 ? entries.length : general;
  const merged = [...entries.slice(0, at), ...scoped, ...entries.slice(at)];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (!/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) out[key] = value;
  merged.forEach(([key, value], index) => {
    out[`GIT_CONFIG_KEY_${index}`] = key;
    out[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(merged.length);
  return out;
}
