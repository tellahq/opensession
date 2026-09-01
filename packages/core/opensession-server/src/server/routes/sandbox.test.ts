/**
 * The recreate route's ensure() spec. A recreate destroys the sandbox first,
 * and destroy() deletes the state file that records the sandbox's trust
 * policy — so the policy has to travel through this spec explicitly. When it
 * did not, an automation's sandbox came back "interactive": no egress
 * firewall, no credential-minimal projection, under a contract documented as
 * fail-closed (sandbox/provider.ts).
 */

import { describe, expect, test } from "bun:test";
import { recreateSandboxSpec } from "./sandbox";

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
