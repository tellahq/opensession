import { describe, expect, it } from "bun:test";
import {
  parseCommitLog,
  recentCommitMatcher,
  type RecentCommit,
} from "./recent-commits";

const RECORD = "\x1e";
const FIELD = "\x1f";

function entry(fields: string[], stat?: string) {
  return `${RECORD}${fields.join(FIELD)}\n${stat ? `${stat}\n` : ""}`;
}

describe("recentCommitMatcher", () => {
  const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const commit: RecentCommit = {
    repo: "opensession",
    sha,
    title: "Show committed work",
    author: "Kent",
    person: "kent",
    committedAt: "2026-08-28T10:00:00Z",
    filesChanged: 2,
    additions: 10,
    deletions: 1,
  };

  it("matches a commit from the explicit session transcript", () => {
    const matcher = recentCommitMatcher([commit]);
    matcher.observe("os-maker", [
      {
        id: "tool-result",
        type: "tool_result",
        timestamp: "2026-08-28T10:00:01Z",
        content: `[main ${sha.slice(0, 9)}] Show committed work`,
      },
    ]);
    expect(matcher.commits()).toEqual([{ ...commit, sessionId: "os-maker" }]);
  });

  it("does not treat nearby git log output as authorship", () => {
    const matcher = recentCommitMatcher([commit]);
    matcher.observe("os-reader", [
      {
        id: "tool-result",
        type: "tool_result",
        timestamp: "2026-08-28T10:00:01Z",
        content: `${sha.slice(0, 9)} Show committed work`,
      },
    ]);
    expect(matcher.commits()).toEqual([]);
  });
});

describe("parseCommitLog", () => {
  it("reads a commit's fields and its line counts", () => {
    const rows = parseCommitLog(
      entry(
        [
          "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
          "OS Robot",
          "os@tella.dev",
          "2026-08-14T10:17:45+00:00",
          "Open a turn's diff from the fold header",
        ],
        " 3 files changed, 21 insertions(+), 4 deletions(-)",
      ),
      { id: "opensession", ghRepo: "tellahq/opensession" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: "opensession",
      sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      title: "Open a turn's diff from the fold header",
      author: "OS Robot",
      committedAt: "2026-08-14T10:17:45+00:00",
      filesChanged: 3,
      additions: 21,
      deletions: 4,
      url: "https://github.com/tellahq/opensession/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    });
  });

  it("counts an insertion-only commit, and one that only removes", () => {
    const rows = parseCommitLog(
      entry(
        ["aaa", "A", "a@example.com", "2026-08-14T10:00:00+00:00", "Add"],
        " 1 file changed, 9 insertions(+)",
      ) +
        entry(
          ["bbb", "B", "b@example.com", "2026-08-14T09:00:00+00:00", "Drop"],
          " 1 file changed, 2 deletions(-)",
        ),
      { id: "opensession" },
    );
    expect(rows.map((r) => [r.additions, r.deletions])).toEqual([
      [9, 0],
      [0, 2],
    ]);
  });

  it("leaves the url off a repo with no GitHub remote", () => {
    const [row] = parseCommitLog(
      entry(["ccc", "C", "c@example.com", "2026-08-14T10:00:00+00:00", "Ship"]),
      { id: "local" },
    );
    expect(row.url).toBeUndefined();
    expect(row.filesChanged).toBe(0);
    expect(row.additions).toBe(0);
  });

  it("keeps a subject that contains a separator character", () => {
    const [row] = parseCommitLog(
      entry([
        "ddd",
        "D",
        "d@example.com",
        "2026-08-14T10:00:00+00:00",
        `Fix${FIELD}this`,
      ]),
      { id: "opensession" },
    );
    expect(row.title).toBe(`Fix${FIELD}this`);
  });

  it("ignores empty output", () => {
    expect(parseCommitLog("", { id: "opensession" })).toEqual([]);
    expect(parseCommitLog("\n\n", { id: "opensession" })).toEqual([]);
  });
});
