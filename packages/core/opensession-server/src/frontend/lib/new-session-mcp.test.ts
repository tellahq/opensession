import { describe, expect, test } from "bun:test";
import {
  createMcpServers,
  isPrivateRepoOption,
  mcpControlReadout,
  mcpControlState,
} from "./new-session-mcp";

const shared = { id: "app", label: "App" };
const personal = {
  id: "repo-9f2c",
  label: "octocat/private",
  accessScope: { kind: "personal" as const, ownerGithubAccountId: 41 },
};

describe("private repositories and connected services", () => {
  test("privacy comes from the server's access scope, never from the id", () => {
    expect(isPrivateRepoOption(personal)).toBe(true);
    expect(isPrivateRepoOption(shared)).toBe(false);
    expect(isPrivateRepoOption({ ...shared, id: "personal-looking" })).toBe(
      false,
    );
    expect(isPrivateRepoOption(undefined)).toBe(false);
  });

  test("a private repo reads unavailable instead of 'empty means all'", () => {
    expect(mcpControlReadout(mcpControlState(true, []))).toBe("Unavailable");
    expect(mcpControlReadout(mcpControlState(true, ["github"]))).toBe(
      "Unavailable",
    );
    expect(mcpControlReadout(mcpControlState(false, []))).toBe("All");
    expect(mcpControlReadout(mcpControlState(false, ["github", "x"]))).toBe(
      "2 on",
    );
  });

  test("a private create omits mcpServers even with an earlier shared pick", () => {
    expect(createMcpServers(true, ["github"])).toBeUndefined();
    expect(createMcpServers(true, [])).toBeUndefined();
    expect(createMcpServers(false, [])).toBeUndefined();
    expect(createMcpServers(false, ["github"])).toEqual(["github"]);
  });

  test("the shared pick survives a detour through a private repo", () => {
    const pick = ["github", "linear"];
    // The state is the same array the palette keeps; the private view only
    // hides it, so switching back presents the pick unchanged.
    expect(mcpControlState(true, pick)).toEqual({ kind: "private" });
    expect(mcpControlState(false, pick)).toEqual({
      kind: "shared",
      selected: pick,
    });
    expect(createMcpServers(false, pick)).toEqual(pick);
  });
});
