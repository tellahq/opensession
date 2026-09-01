import { describe, expect, it } from "bun:test";
import { buildFeedRows } from "./feed-rows";
import type { WorktreeRow } from "./pr-rows";
import type { RecentCommit } from "./api";

const pr = (over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  key: "https://github.com/tellahq/tella-fusion/pull/12",
  title: "Export presets",
  repo: "tella-fusion",
  branch: "presets",
  url: "https://github.com/tellahq/tella-fusion/pull/12",
  state: "MERGED",
  number: 12,
  updatedAt: "2026-08-14T09:00:00Z",
  archived: false,
  person: "kent",
  ...over,
});

const commit = (over: Partial<RecentCommit> = {}): RecentCommit => ({
  repo: "opensession",
  sha: "a1b2c3d4e5f6",
  title: "Feed: show what shipped without a PR",
  url: "https://github.com/tellahq/opensession/commit/a1b2c3d4e5f6",
  author: "Kent de Bruin",
  person: "kent",
  committedAt: "2026-08-14T10:00:00Z",
  additions: 40,
  deletions: 3,
  ...over,
});

describe("buildFeedRows", () => {
  it("sorts merges and commits together, newest first", () => {
    const rows = buildFeedRows(
      [
        pr({ updatedAt: "2026-08-14T11:00:00Z", key: "later-pr", number: 13 }),
        pr(),
      ],
      [commit()],
    );
    expect(rows.map((row) => row.kind)).toEqual(["pr", "commit", "pr"]);
  });

  it("names a PR by number and a commit by short sha", () => {
    const [commitRow, prRow] = buildFeedRows([pr()], [commit()]).sort((a, b) =>
      a.kind.localeCompare(b.kind),
    );
    expect(commitRow.ref).toBe("a1b2c3d");
    expect(prRow.ref).toBe("#12");
  });

  it("opens the attributed session behind a merge after it is archived", () => {
    const [row] = buildFeedRows([pr({ sessionId: "os-1" })], []);
    expect(row.sessionId).toBe("os-1");
  });

  it("gives a teammate a face and an automation its name", () => {
    const isTeammate = (key: string) => key === "kent";
    const [teammate] = buildFeedRows([pr({ person: "kent" })], [], isTeammate);
    expect(teammate.owner).toEqual({ person: "kent", label: "Kent" });

    // An automation owns its own sessions, so the field holds its name.
    const [auto] = buildFeedRows(
      [pr({ person: "plain ticket triage" })],
      [],
      isTeammate,
    );
    expect(auto.owner).toEqual({ person: null, label: "Plain ticket triage" });
  });

  it("falls back to the recorded author, and to nothing when there is none", () => {
    const isTeammate = () => false;
    const [signed] = buildFeedRows(
      [],
      [commit({ person: null, author: "SEO Sweep" })],
      isTeammate,
    );
    expect(signed.owner).toEqual({ person: null, label: "SEO Sweep" });

    const [unsigned] = buildFeedRows(
      [],
      [commit({ person: null, author: "" })],
      isTeammate,
    );
    expect(unsigned.owner).toBeNull();
  });

  it("opens the session that wrote a commit even once it is archived", () => {
    // The whole point of keeping the id: a session is archived when its work
    // is done, so by the time anyone reads the feed almost none of what it
    // can open is still in the live list. Nothing here consults one.
    const [row] = buildFeedRows([], [commit({ sessionId: "os-1" })]);
    expect(row.sessionId).toBe("os-1");
  });

  it("leaves a commit nobody wrote to its web host", () => {
    // A commit made outside Open Session has no session to name, and a row
    // with nowhere of ours to go still has GitHub.
    const [row] = buildFeedRows([], [commit()]);
    expect(row.sessionId).toBeUndefined();
    expect(row.url).toContain("/commit/");
  });

  it("keys a commit by repo and sha, so two repos can't collide", () => {
    const rows = buildFeedRows([], [commit(), commit({ repo: "other" })]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});
