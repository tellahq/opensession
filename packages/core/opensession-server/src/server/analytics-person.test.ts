import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamMember } from "./config";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import { analyticsPersonName, analyticsRepo } from "./analytics";

const TEAM: TeamMember[] = [
  {
    name: "Alice Example",
    email: "alice@example.com",
    aliases: ["alice"],
    github: "alice-login",
  },
];

describe("Analytics person attribution", () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = __setIdentitiesForTest(TEAM);
  });

  afterAll(() => restore?.());

  test("merges a teammate's short name, full name, and verified login", () => {
    expect(analyticsPersonName("Alice")).toBe("Alice");
    expect(analyticsPersonName("Alice Example")).toBe("Alice");
    expect(analyticsPersonName("Old display label", "alice-login")).toBe(
      "Alice",
    );
  });

  test("preserves labels outside the configured roster", () => {
    expect(analyticsPersonName("Other")).toBe("Other");
  });
});

describe("Analytics repo attribution", () => {
  const repos = {
    opensession: {
      id: "opensession",
      repo: "/home/example/projects/opensession",
      wtPrefix: "opensession",
    },
  };

  test("prefers the persisted repo ID over a historical worktree path", () => {
    expect(
      analyticsRepo(
        "opensession",
        "/home/example/projects/tella-backstage",
        repos,
      ),
    ).toBe("opensession");
  });

  test("falls back to worktree inference for sessions without a repo ID", () => {
    expect(analyticsRepo("", "/home/example/projects/opensession", repos)).toBe(
      "opensession",
    );
    expect(
      analyticsRepo("", "/home/example/projects/unknown", repos),
    ).toBeNull();
  });
});
