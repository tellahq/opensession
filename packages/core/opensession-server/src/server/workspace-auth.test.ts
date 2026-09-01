import { describe, expect, test } from "bun:test";
import { identityIsWorkspaceAdmin } from "./workspace-auth";

describe("workspace administrator roles", () => {
  test("uses the verified GitHub login when explicit roles exist", () => {
    const team = [
      { name: "Ada", github: "Ada", admin: true },
      { name: "Grace", github: "grace", admin: false },
    ];
    expect(identityIsWorkspaceAdmin({ login: "ada" }, team)).toBe(true);
    expect(identityIsWorkspaceAdmin({ login: "Grace" }, team)).toBe(false);
    expect(identityIsWorkspaceAdmin({ login: "unknown" }, team)).toBe(false);
    expect(identityIsWorkspaceAdmin(null, team)).toBe(false);
  });

  test("preserves the existing all-members-admin workspace model until roles are set", () => {
    const team = [{ name: "Ada", github: "ada" }];
    expect(
      identityIsWorkspaceAdmin({ login: "any-verified-member" }, team),
    ).toBe(true);
  });
});
