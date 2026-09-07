/** Process-local Git credential wiring for trusted server-owned Git calls. */

import { existsSync } from "fs";
import { resolve } from "path";
import { GITHUB_PUSH_TOKEN_RUN_ENV } from "../../../../../scripts/lib/github-credential";
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
 * An operator-configured OPENSESSION_GITHUB_PUSH_TOKEN rides along — under
 * the run-scoped name the credential helper reads — so git transport uses it
 * while API calls keep GH_TOKEN. It rides only next to a real session token:
 * a run that carries no GitHub credential must stay credential-free, and the
 * distinct name keeps the operator's ambient variable inert in children that
 * merely inherit the server's environment.
 */
export function githubGitCredentialEnv(
  token: string,
  helper = githubCredentialHelperCommand(),
  pushToken = process.env.OPENSESSION_GITHUB_PUSH_TOKEN,
): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    ...(token && pushToken ? { [GITHUB_PUSH_TOKEN_RUN_ENV]: pushToken } : {}),
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
