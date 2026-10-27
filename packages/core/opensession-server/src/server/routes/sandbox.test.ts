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
  sandboxDetachRefusal,
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

  test("a session already in a Sandbox may not move to the same provider", () => {
    const inBox = { ...host, sandbox: { provider: "box", sandboxId: "bx_1" } };
    expect(sandboxAttachRefusal(inBox)).toMatch(/already runs on box/);
    expect(sandboxAttachRefusal(inBox, "box")).toMatch(/already runs on box/);
  });

  test("another GPU on the same provider is a move", () => {
    const onModal = {
      ...host,
      sandbox: { provider: "modal", sandboxId: "md-1" },
    };
    expect(sandboxAttachRefusal(onModal, "modal")).toMatch(/already runs/);
    expect(sandboxAttachRefusal(onModal, "modal", "T4")).toBeNull();
    const onT4 = { ...onModal, sandboxGpu: "T4" };
    expect(sandboxAttachRefusal(onT4, "modal", "T4")).toMatch(/T4 GPU/);
    expect(sandboxAttachRefusal(onT4, "modal", "L4")).toBeNull();
    expect(sandboxAttachRefusal(onT4, "modal")).toBeNull();
  });

  test("a session in a Sandbox may move to another provider", () => {
    expect(
      sandboxAttachRefusal(
        { ...host, sandbox: { provider: "box", sandboxId: "bx_1" } },
        "daytona",
      ),
    ).toBeNull();
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

describe("sandboxDetachRefusal", () => {
  const inSandbox = {
    mode: "code" as const,
    repo: "opensession",
    sandbox: { provider: "daytona", sandboxId: "dt_1" },
  };

  test("a Sandbox code session may move back to this machine", () => {
    expect(sandboxDetachRefusal(inSandbox)).toBeNull();
  });

  test("a host session, an automation, and a non-code session are refused", () => {
    expect(
      sandboxDetachRefusal({ ...inSandbox, sandbox: { provider: "local" } }),
    ).toMatch(/already runs on this machine/);
    expect(sandboxDetachRefusal({ ...inSandbox, sandbox: undefined })).toMatch(
      /already runs on this machine/,
    );
    expect(
      sandboxDetachRefusal({ ...inSandbox, automationId: "plain-triage" }),
    ).toMatch(/automation/);
    expect(sandboxDetachRefusal({ ...inSandbox, mode: "ask" })).toMatch(
      /code sessions/,
    );
  });
});

describe("recreateSandboxSpec checkpoint", () => {
  test("carries the session's last checkpoint so the rebuild restores it", () => {
    const checkpoint = {
      ref: `refs/opensession/checkpoints/${session.id}`,
      commit: "c".repeat(40),
      head: "h".repeat(40),
      tree: "t".repeat(40),
      branch: session.branch,
      at: "2026-09-16T10:00:00.000Z",
    };
    expect(
      recreateSandboxSpec({ ...session, sandboxCheckpoint: checkpoint }, null)
        .restoreCheckpoint,
    ).toEqual({
      ref: checkpoint.ref,
      commit: checkpoint.commit,
      branch: checkpoint.branch,
    });
    expect(
      recreateSandboxSpec(session, null).restoreCheckpoint,
    ).toBeUndefined();
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
