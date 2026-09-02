import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamMember } from "../config";
import {
  __setIdentitiesForTest,
  commitAuthorFor,
  deriveIdentityTables,
  gitIdentityEnv,
  labelIdentity,
  githubLoginForTrustedSlackId,
  githubLoginToPersonKeyFromTeam,
  isTrustedGithubLogin,
  isTrustedUser,
  personKeyToDisplayName,
} from "./user-mappings";

const TEAM: TeamMember[] = [
  {
    name: "Alice Example",
    email: "alice@example.com",
    aliases: ["alice", "ali"],
    slackId: "U_ALICE",
    github: "alice",
    linearEmails: ["alice@work.example"],
  },
  {
    name: "Bob Builder",
    email: "bob@example.com",
    slackId: "U_BOB",
    github: "bob",
    linearEmails: ["bob@work.example"],
    githubToSlack: false,
  },
];

describe("identity table derivation", () => {
  test("derives GitHub, Slack, Linear, and git attribution tables from config", () => {
    const tables = deriveIdentityTables(TEAM, { U_SYSTEM: "Build Bot" });

    expect(tables.githubToSlack).toEqual({ alice: "U_ALICE" });
    expect(tables.linearEmailToGithub).toEqual({
      "alice@work.example": "alice",
      "bob@work.example": "bob",
    });
    expect(tables.slackIdToName).toEqual({
      U_ALICE: "Alice Example",
      U_BOB: "Bob Builder",
      U_SYSTEM: "Build Bot",
    });
    expect(tables.teamGitIdentity).toEqual([
      {
        name: "Alice Example",
        email: "alice@example.com",
        aliases: ["alice", "ali"],
        slackId: "U_ALICE",
        github: "alice",
      },
      {
        name: "Bob Builder",
        email: "bob@example.com",
        aliases: ["bob"],
        slackId: "U_BOB",
        github: "bob",
      },
    ]);
  });

  test("empty team produces empty tables", () => {
    expect(deriveIdentityTables([], {})).toEqual({
      githubToSlack: {},
      linearEmailToGithub: {},
      slackIdToName: {},
      teamGitIdentity: [],
    });
  });

  test("member without explicit aliases uses the lowercased first name", () => {
    const tables = deriveIdentityTables([
      { name: "Ada Lovelace", email: "ada@example.com" },
    ]);
    expect(tables.teamGitIdentity).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com", aliases: ["ada"] },
    ]);
  });

  test("directory display helpers accept an explicit configured team", () => {
    expect(githubLoginToPersonKeyFromTeam("alice", TEAM)).toBe("alice");
    expect(githubLoginToPersonKeyFromTeam("unknown", TEAM)).toBeNull();
    expect(personKeyToDisplayName("ali", TEAM)).toBe("Alice");
    expect(personKeyToDisplayName("unknown", TEAM)).toBeNull();
  });
});

describe("commit attribution", () => {
  // Roster-dependent: pin a fixture team so the assertions don't read the
  // operator's own ~/.opensession/config.json.
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = __setIdentitiesForTest(TEAM);
  });
  afterAll(() => restore?.());

  test("only configured identities are trusted", () => {
    expect(isTrustedGithubLogin("@Alice")).toBe(true);
    expect(isTrustedGithubLogin("mallory")).toBe(false);
    expect(isTrustedGithubLogin("")).toBe(false);
    expect(isTrustedUser("U_BOB")).toBe(true);
    expect(isTrustedUser("alice@work.example")).toBe(true);
    expect(isTrustedUser("ali")).toBe(false); // aliases are not authentication evidence
    expect(isTrustedUser("mallory")).toBe(false);
  });

  test("trusted Slack login lookup uses one exact roster entry", () => {
    expect(githubLoginForTrustedSlackId("U_ALICE")).toBe("alice");
    expect(githubLoginForTrustedSlackId("U_SYSTEM")).toBeNull();
    expect(githubLoginForTrustedSlackId("alice")).toBeNull();

    const restoreDuplicate = __setIdentitiesForTest([
      ...TEAM,
      { name: "Mallory", slackId: "U_ALICE", github: "mallory" },
    ]);
    try {
      expect(githubLoginForTrustedSlackId("U_ALICE")).toBeNull();
    } finally {
      restoreDuplicate();
    }
  });

  test("the prompt's sender wins", () => {
    expect(commitAuthorFor("alice", "Bob Builder")).toEqual({
      name: "Alice Example",
      email: "alice@example.com",
    });
  });

  test("a turn nobody sent is the session owner's work", () => {
    // The senders the server's own resume paths pass. None is a person, and
    // without the fallback each one dropped the commit onto the bot identity.
    for (const sender of [undefined, null, "", "auto-continue", "anonymous"]) {
      expect(commitAuthorFor(sender, "Bob Builder")).toEqual({
        name: "Bob Builder",
        email: "bob@example.com",
      });
    }
  });

  test("an owner who is on no roster signs under its own name", () => {
    // What an automation-owned session looks like: no person to credit, but
    // the automation is still the owner, and every unattended run in the
    // instance would otherwise share one anonymous author.
    expect(commitAuthorFor("auto-continue", "Dreaming (automation)")).toEqual({
      name: "Dreaming",
      email: "",
    });
  });

  test("a placeholder owner is not written into history", () => {
    for (const owner of [undefined, null, "", "Anonymous", "Assistant"]) {
      expect(commitAuthorFor(null, owner)).toBeNull();
    }
  });

  test("a name-only identity leaves the address to git's own config", () => {
    // An empty GIT_AUTHOR_EMAIL is taken literally by git, so the variable
    // has to be absent rather than blank.
    expect(gitIdentityEnv(labelIdentity("Production Watchdog"))).toEqual({
      GIT_AUTHOR_NAME: "Production Watchdog",
      GIT_COMMITTER_NAME: "Production Watchdog",
    });
    expect(gitIdentityEnv(commitAuthorFor("alice"))).toEqual({
      GIT_AUTHOR_NAME: "Alice Example",
      GIT_AUTHOR_EMAIL: "alice@example.com",
      GIT_COMMITTER_NAME: "Alice Example",
      GIT_COMMITTER_EMAIL: "alice@example.com",
    });
    expect(gitIdentityEnv(null)).toEqual({});
  });
});
