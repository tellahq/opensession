import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { MEMORY_DIR } from "../agents/slack/memory";
import { SLACK_ID_TO_NAME } from "./shared/user-mappings";
import {
  addSessionMemory,
  forgetSessionMemory,
  listSessionMemory,
  renderSessionMemoryNote,
  sessionMemoryScopes,
  type MemoryScope,
} from "./session-memory";

// Round-trip tests write to uniquely-named scope files inside the real store
// dir (never touching existing scopes) and remove them afterwards.
const TEST_REPO = `__sm-test-${Math.random().toString(36).slice(2, 8)}`;
const TEST_SCOPE: MemoryScope = {
  key: `repo-${TEST_REPO}`,
  kind: "repo",
  label: TEST_REPO,
};

afterAll(() => {
  rmSync(`${MEMORY_DIR}/${TEST_SCOPE.key}.json`, { force: true });
});

describe("sessionMemoryScopes", () => {
  test("repo scopes first (deduped), then user, then team", () => {
    const scopes = sessionMemoryScopes({
      user: "definitely-not-a-teammate-xyz",
      repos: ["tella-fusion", "opensession", "tella-fusion"],
    });
    expect(scopes.map((s) => s.key)).toEqual([
      "repo-tella-fusion",
      "repo-opensession",
      "user-definitely-not-a-teammate-xyz",
      "workspace",
    ]);
    expect(scopes.at(-1)?.kind).toBe("team");
  });

  test("teammate user unifies with their Slack DM store (user-<slackId>)", () => {
    // Instance-independent: pick any teammate from the configured identity
    // table; with no team configured there is nothing to unify — skip.
    const [slackId, name] = Object.entries(SLACK_ID_TO_NAME)[0] ?? [];
    if (!slackId) return;
    const scopes = sessionMemoryScopes({ user: name, repos: [] });
    const user = scopes.find((s) => s.kind === "user");
    expect(user?.key).toBe(`user-${slackId}`);
  });

  test("no user → no user scope; includeTeam:false drops workspace", () => {
    expect(
      sessionMemoryScopes({ repos: ["a"], includeTeam: false }).map(
        (s) => s.key,
      ),
    ).toEqual(["repo-a"]);
  });
});

describe("memory round-trip", () => {
  test("add → list → forget", async () => {
    const entry = await addSessionMemory(TEST_SCOPE, "  the fact  ", "tester");
    expect(entry.text).toBe("the fact");

    const listed = await listSessionMemory([TEST_SCOPE]);
    expect(listed[0].entries.map((e) => e.id)).toContain(entry.id);

    const note = await renderSessionMemoryNote([TEST_SCOPE]);
    expect(note).toContain(`[${entry.id}] the fact`);
    expect(note).toContain(`Repo ${TEST_REPO}:`);

    const gone = await forgetSessionMemory([TEST_SCOPE], entry.id);
    expect(gone.ok).toBe(true);
    expect((await listSessionMemory([TEST_SCOPE]))[0].entries).toHaveLength(0);
  });

  test("forget of unknown id fails cleanly", async () => {
    const res = await forgetSessionMemory([TEST_SCOPE], "nope1234");
    expect(res.ok).toBe(false);
  });
});

describe("renderSessionMemoryNote", () => {
  test("empty scopes render nothing without tools, guidance with tools", async () => {
    expect(await renderSessionMemoryNote([TEST_SCOPE])).toBe("");
    const withTools = await renderSessionMemoryNote([TEST_SCOPE], {
      tools: true,
    });
    expect(withTools).toContain("store_memory");
  });
});
