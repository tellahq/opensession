import { describe, expect, test } from "bun:test";
import { DEFAULT_GITHUB_FLOW_MCP_SERVERS } from "./run";

/**
 * The PR flows mount an explicit MCP allowlist instead of every connector
 * (~430 external tool schemas on 1,410 sessions to serve the ~20 that ever
 * called one). The list is configurable on the review automation; these guard
 * the two properties that make the wiring safe rather than the list itself.
 */
describe("github flow MCP scope", () => {
  test("the default is non-empty and explicit", () => {
    // The runner reads `undefined` as "every server" and `[]` as "none", so a
    // default that collapsed to undefined would silently restore the old
    // mount-everything behavior (see githubFlowMcpServers).
    expect(DEFAULT_GITHUB_FLOW_MCP_SERVERS.length).toBeGreaterThan(0);
    expect(DEFAULT_GITHUB_FLOW_MCP_SERVERS.every((s) => !!s.trim())).toBe(true);
  });

  test("the default names only servers that PR flows actually called", () => {
    // grafana (149 calls / 7 sessions) and linear (13 / 8) were the only two
    // with more than a handful of uses across the audited window. Widening
    // this set is a config change on the automation, not a code change.
    expect([...DEFAULT_GITHUB_FLOW_MCP_SERVERS].sort()).toEqual([
      "grafana",
      "linear",
    ]);
  });
});
