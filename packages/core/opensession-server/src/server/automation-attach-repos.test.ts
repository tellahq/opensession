import { describe, expect, test } from "bun:test";
import { sanitizeAttachRepos } from "./automations";

describe("sanitizeAttachRepos", () => {
  const registered = (id: string) => ["app", "evals", "docs"].includes(id);
  const code = { repo: "app", mode: "code" as const };

  test("keeps registered repos in order, deduped, without the automation's own", () => {
    expect(
      sanitizeAttachRepos(
        [" evals ", "docs", "evals", "app", ""],
        code,
        registered,
      ),
    ).toEqual(["evals", "docs"]);
  });

  test("an empty list, or one naming only the automation's own repo, clears the field", () => {
    for (const cleared of [[], ["app"], undefined, null, ""])
      expect(sanitizeAttachRepos(cleared, code, registered)).toBeUndefined();
  });

  test("refuses an unknown repo, and a write that is not a list of ids", () => {
    expect(sanitizeAttachRepos(["evals", "nope"], code, registered)).toEqual({
      error: 'Unknown repo "nope" in attachRepos',
    });
    for (const bad of ["evals", ["evals", 7], { repo: "evals" }])
      expect(sanitizeAttachRepos(bad, code, registered)).toEqual({
        error: "attachRepos must be a list of registered repo ids",
      });
  });

  test("needs a host code-mode automation, the only run with a worktree to attach beside", () => {
    const refused = {
      error:
        "attachRepos needs a code-mode automation that runs on the host (not in a sandbox)",
    };
    expect(
      sanitizeAttachRepos(["evals"], { repo: "app", mode: "ask" }, registered),
    ).toEqual(refused);
    expect(
      sanitizeAttachRepos(["evals"], { ...code, sandbox: true }, registered),
    ).toEqual(refused);
    expect(
      sanitizeAttachRepos([], { repo: "app", mode: "ask" }, registered),
    ).toBeUndefined();
  });
});
