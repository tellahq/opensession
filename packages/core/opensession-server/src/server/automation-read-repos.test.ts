import { describe, expect, test } from "bun:test";
import { sanitizeReadRepos } from "./automations";

describe("sanitizeReadRepos", () => {
  const own = "tellahq/app";

  test("keeps well-formed sibling repositories under the automation's owner", () => {
    expect(
      sanitizeReadRepos([" tellahq/api ", "tellahq/web", "tellahq/docs"], own),
    ).toEqual(["tellahq/api", "tellahq/web", "tellahq/docs"]);
  });

  test("dedupes case-insensitively and drops the automation's own repo", () => {
    expect(
      sanitizeReadRepos(["tellahq/api", "TellaHQ/Api", "tellahq/app", ""], own),
    ).toEqual(["tellahq/api"]);
  });

  test("an empty or absent list clears the field", () => {
    expect(sanitizeReadRepos([], own)).toBeUndefined();
    expect(sanitizeReadRepos(undefined, own)).toBeUndefined();
    expect(sanitizeReadRepos(null, own)).toBeUndefined();
    expect(sanitizeReadRepos("", own)).toBeUndefined();
    expect(sanitizeReadRepos([own], own)).toBeUndefined();
  });

  test("rejects names that are not owner/repo", () => {
    for (const bad of ["api", "tellahq/", "/api", "tellahq/a pi", "a/b/c"]) {
      expect(sanitizeReadRepos([bad], own)).toEqual({
        error: `Invalid read repo "${bad}" — use a GitHub owner/repo name`,
      });
    }
    // A non-list is an error, never a clear: the HTTP routes hand raw JSON
    // to the same shape check the field table uses, so a mistyped write
    // must not silently drop an existing allowlist. Only absent, null, and
    // "" clear the field.
    for (const bad of ["tellahq/api", { repo: "tellahq/api" }, 1, true]) {
      expect(sanitizeReadRepos(bad, own)).toEqual({
        error: "readRepos must be a list of owner/repo names",
      });
    }
    // The same for a non-string member: a list of objects must not clear
    // the field, and a mixed list must not silently narrow it.
    for (const bad of [
      [{ repo: "tellahq/api" }],
      ["tellahq/api", 7],
      [null],
      ["tellahq/api", ["tellahq/web"]],
    ]) {
      expect(sanitizeReadRepos(bad, own)).toEqual({
        error: "readRepos must be a list of owner/repo names",
      });
    }
  });

  test("rejects a repository under another owner: one installation, one token", () => {
    expect(sanitizeReadRepos(["octo-org/api"], own)).toEqual({
      error:
        'Read repo "octo-org/api" is not under tellahq; one installation token covers one owner',
    });
  });

  test("needs a GitHub repo to anchor the owner", () => {
    expect(sanitizeReadRepos(["tellahq/api"], undefined)).toEqual({
      error: "readRepos needs the automation's repo to be a GitHub repository",
    });
  });
});
