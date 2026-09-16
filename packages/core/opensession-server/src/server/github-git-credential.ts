/** Process-local Git credential wiring for trusted server-owned Git calls. */

import { existsSync } from "fs";
import { resolve } from "path";
import { SHIM_PATH } from "../../../../../scripts/lib/paths";
import { isCompiledBinary } from "../runner-host/exe";
import { githubGitCredentialEnvWithHelper } from "./github-git-credential-env";

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
  return githubGitCredentialEnvWithHelper(token, helper);
}
