/**
 * The recreate route's ensure() spec. A recreate destroys the sandbox first,
 * and destroy() deletes the state file that records the sandbox's trust
 * policy — so the policy has to travel through this spec explicitly. When it
 * did not, an automation's sandbox came back "interactive": no egress
 * firewall, no credential-minimal projection, under a contract documented as
 * fail-closed (sandbox/provider.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  recreateSandboxSpec,
  sandboxAttachRefusal,
  unpublishedWorkSummary,
} from "./sandbox";

const session = {
  id: "os-019fea32-b27e-7000-9131-0f5484659833",
  repo: "opensession",
  branch: "auto-plain-triage-202608161200",
  mode: "code" as const,
  worktreeDir: "/home/ubuntu/microvm-workspaces/os-019fea32",
};

describe("recreateSandboxSpec", () => {
  test("preserves an automation sandbox's recorded trust profile and egress allowlist", () => {
    expect(
      recreateSandboxSpec(
        {
          ...session,
          automationId: "plain-triage",
          automation: "Plain triage",
        },
        {
          trustProfile: "automation",
          egressAllowlist: ["https://api.plain.com"],
        },
      ),
    ).toEqual({
      sessionId: session.id,
      repo: "opensession",
      branch: session.branch,
      mode: "code",
      cwd: session.worktreeDir,
      trustProfile: "automation",
      egressAllowlist: ["https://api.plain.com"],
    });
  });

  test("an automation-owned session fails closed when the provider recorded no policy", () => {
    const spec = recreateSandboxSpec(
      { ...session, automationId: "plain-triage" },
      null,
    );
    expect(spec.trustProfile).toBe("automation");
    expect(spec.egressAllowlist).toBeUndefined();
  });

  test("an interactive session stays interactive", () => {
    const spec = recreateSandboxSpec(session, {
      trustProfile: "interactive",
      egressAllowlist: [],
    });
    expect(spec.trustProfile).toBe("interactive");
    expect(recreateSandboxSpec(session, null).trustProfile).toBeUndefined();
  });
});

describe("sandboxAttachRefusal", () => {
  const host = { mode: "code" as const, repo: "opensession" };

  test("a host code session with a repository may move", () => {
    expect(sandboxAttachRefusal(host)).toBeNull();
  });

  test("a session already in a Sandbox may not move again", () => {
    expect(
      sandboxAttachRefusal({
        ...host,
        sandbox: { provider: "box", sandboxId: "bx_1" },
      }),
    ).toMatch(/already runs in a Sandbox/);
  });

  test("a move that has not materialized may be retried", () => {
    expect(
      sandboxAttachRefusal({
        ...host,
        sandbox: { provider: "box", lifecycle: "needs_attention" },
      }),
    ).toBeNull();
  });

  test("an explicit host record does not count as a Sandbox", () => {
    expect(
      sandboxAttachRefusal({ ...host, sandbox: { provider: "local" } }),
    ).toBeNull();
  });

  test("Runner, automation, ask and repo-less sessions are refused", () => {
    expect(
      sandboxAttachRefusal({
        ...host,
        runner: { id: "runner-1", name: "Bill", workspacePath: "/w" },
      }),
    ).toMatch(/Runner/);
    expect(
      sandboxAttachRefusal({ ...host, automationId: "plain-triage" }),
    ).toMatch(/automation/);
    expect(sandboxAttachRefusal({ ...host, mode: "ask" })).toMatch(
      /code sessions/,
    );
    expect(sandboxAttachRefusal({ mode: "code", repo: undefined })).toMatch(
      /code sessions/,
    );
  });
});

describe("unpublishedWorkSummary", () => {
  const published = {
    branch: "feature",
    hasUpstream: true,
    ahead: 0,
    uncommittedFiles: 0,
  };

  test("published work needs no confirmation", () => {
    expect(unpublishedWorkSummary(published)).toBeNull();
  });

  test("names uncommitted files and unpushed commits", () => {
    expect(
      unpublishedWorkSummary({ ...published, uncommittedFiles: 3, ahead: 1 }),
    ).toBe(
      "This machine has 3 uncommitted files and 1 unpushed commit. The Sandbox clones the branch from origin, so push first, or move anyway and leave them here.",
    );
  });

  test("a branch origin never saw is called out instead of a commit count", () => {
    expect(
      unpublishedWorkSummary({ ...published, hasUpstream: false, ahead: 4 }),
    ).toMatch(/^This machine has the branch feature, which was never pushed\./);
  });
});
