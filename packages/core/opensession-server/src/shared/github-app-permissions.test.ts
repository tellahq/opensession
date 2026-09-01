// A GitHub App installation-token mint is all-or-nothing: it succeeds only if
// every requested scope is a subset of what the App was granted. So each mint
// set MUST be a subset of the grant set the create-app URL requests. When they
// drifted apart, real Apps 422'd on every mint and fell through to unrelated host credentials —
// which is exactly the bug this pins shut.

import { describe, test, expect } from "bun:test";
import {
  GITHUB_APP_CODE_PERMISSIONS,
  GITHUB_APP_GRANT_PERMISSIONS,
  GITHUB_APP_READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS,
} from "./github-app-permissions";

/** A mint scope is covered when the grant holds the same key at an access level
 *  at least as strong (write covers read). */
function uncoveredScopes(mint: Record<string, string>): string[] {
  const rank = (v: string) => (v === "write" ? 2 : v === "read" ? 1 : 0);
  return Object.entries(mint)
    .filter(
      ([key, level]) =>
        rank(GITHUB_APP_GRANT_PERMISSIONS[key] ?? "") < rank(level),
    )
    .map(([key]) => key);
}

describe("github app permission sets", () => {
  test("the read mint is within the grant", () => {
    expect(uncoveredScopes(GITHUB_APP_READ_PERMISSIONS)).toEqual([]);
  });

  test("the write mint is within the grant", () => {
    expect(uncoveredScopes(GITHUB_APP_WRITE_PERMISSIONS)).toEqual([]);
  });

  test("the repository code mint is within the grant", () => {
    expect(uncoveredScopes(GITHUB_APP_CODE_PERMISSIONS)).toEqual([]);
    expect(GITHUB_APP_CODE_PERMISSIONS.actions).toBe("read");
    expect(GITHUB_APP_CODE_PERMISSIONS.checks).toBe("read");
    expect(GITHUB_APP_CODE_PERMISSIONS.issues).toBe("write");
  });

  test("the grant includes the scopes the two capabilities depend on", () => {
    // checks:read is required for check runs;
    // issues+pull_requests+contents:write are the agent's write path.
    expect(GITHUB_APP_GRANT_PERMISSIONS.checks).toBe("read");
    expect(GITHUB_APP_GRANT_PERMISSIONS.issues).toBe("write");
    expect(GITHUB_APP_GRANT_PERMISSIONS.pull_requests).toBe("write");
    expect(GITHUB_APP_GRANT_PERMISSIONS.contents).toBe("write");
    expect(GITHUB_APP_READ_PERMISSIONS.members).toBe("read");
    expect(GITHUB_APP_READ_PERMISSIONS.deployments).toBe("read");
  });

  test("the read mint keeps actions:read for the status check rollup", () => {
    // gh's `pr view --json statusCheckRollup` selects checkSuite.workflowRun,
    // which is gated on Actions. Dropping this scope does not degrade the
    // rollup — GitHub fails the entire GraphQL response, so every PR panel,
    // review and auto-fix run reports "missing a permission for this API".
    expect(GITHUB_APP_READ_PERMISSIONS.actions).toBe("read");
    expect(GITHUB_APP_GRANT_PERMISSIONS.actions).toBe("read");
  });

  test("the write mint carries no read-only scope whose absence would 422 it", () => {
    // It must not request checks/statuses — writes never touch them, and an
    // App without them granted would otherwise reject the whole write token.
    expect(GITHUB_APP_WRITE_PERMISSIONS.checks).toBeUndefined();
    expect(GITHUB_APP_WRITE_PERMISSIONS.statuses).toBeUndefined();
  });
});
