#!/usr/bin/env bun
/**
 * Git credential helper for code.storage remotes.
 *
 * Wired per-checkout by configureCsCredentialHelper (src/server/codestorage/
 * remote.ts) as a URL-scoped helper with useHttpPath=true, so git hands us the
 * host AND the request path. For the "get" action we answer with username "t"
 * and a freshly minted repo-scoped JWT; every other action (store/erase) is a
 * silent no-op — the password is derived, there is nothing to persist.
 *
 * Helper contract: key=value lines on stdin until a blank line; never prompt,
 * never write to stderr on success. When anything is missing (unconfigured
 * instance, foreign host, no path) we print nothing and exit 0 so git falls
 * through to its other helpers instead of failing the whole operation.
 */

import { mintCsJwt } from "../packages/core/opensession-server/src/server/codestorage/auth";
import { csRepoClaimFromPath } from "../packages/core/opensession-server/src/server/codestorage/remote";
import { codeStorageConfig } from "../packages/core/opensession-server/src/server/config";

const action = process.argv[2];
if (action !== "get") process.exit(0);

const attrs: Record<string, string> = {};
for (const line of (await Bun.stdin.text()).split("\n")) {
  if (!line) break;
  const eq = line.indexOf("=");
  if (eq > 0) attrs[line.slice(0, eq)] = line.slice(eq + 1);
}

const host = attrs.host || "";
const org = host.endsWith(".code.storage")
  ? host.slice(0, -".code.storage".length)
  : "";
// Strips "/", ".git", and a "+ephemeral" ref-namespace suffix — ephemeral
// remotes (…/<repoId>+ephemeral.git) authenticate as the base repo.
const repoId = csRepoClaimFromPath(attrs.path || "");

if (
  attrs.protocol !== "https" ||
  !org ||
  org.includes(".") ||
  !repoId ||
  !codeStorageConfig()
) {
  process.exit(0);
}

const jwt = await mintCsJwt({
  org,
  repo: repoId,
  scopes: ["git:read", "git:write"],
});
process.stdout.write(`username=t\npassword=${jwt}\n`);
