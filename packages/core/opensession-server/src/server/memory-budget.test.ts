/**
 * The three memory changes that bound prompt cost: supersede, search, and the
 * injection budget. Each is here because the store had no way to shrink — an
 * opensession run injected ~368,000 characters of memory on every turn, and
 * nothing had ever removed an entry.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  __setMemoryDirForTest,
  activeMemories,
  saveScope,
  type MemoryEntry,
} from "../agents/slack/memory";
import {
  addSessionMemory,
  archiveMemories,
  invalidateMemorySnapshot,
  listSessionMemory,
  renderSessionMemoryNote,
  restoreMemory,
  searchSessionMemory,
  selectWithinBudget,
  snapshotMemoryNote,
  type MemoryScope,
} from "./session-memory";

const DIR = mkdtempSync(join(tmpdir(), "memory-budget-"));
const PREV = __setMemoryDirForTest(DIR);

const REPO: MemoryScope = {
  key: "repo-testrepo",
  kind: "repo",
  label: "testrepo",
};
const TEAM: MemoryScope = { key: "workspace", kind: "team", label: "team" };
const SCOPES = [REPO, TEAM];

beforeEach(async () => {
  __setMemoryDirForTest(DIR);
  invalidateMemorySnapshot();
  await saveScope(REPO.key, []);
  await saveScope(TEAM.key, []);
});

afterAll(() => {
  __setMemoryDirForTest(PREV);
  rmSync(DIR, { recursive: true, force: true });
});

function entry(id: string, text: string, at: string): MemoryEntry {
  return { id, text, by: "tester", at };
}

describe("supersede", () => {
  test("a correction archives what it replaces, and the archived entry leaves the prompt", async () => {
    const wrong = await addSessionMemory(REPO, "The flag is --fast.", "tester");
    const note = await renderSessionMemoryNote(SCOPES);
    expect(note).toContain("--fast");

    const right = await addSessionMemory(
      REPO,
      "The flag is actually --quick.",
      "tester",
      {
        supersedes: [wrong.id],
        scopes: SCOPES,
      },
    );

    const after = await renderSessionMemoryNote(SCOPES);
    expect(after).toContain("--quick");
    expect(after).not.toContain("--fast");

    // Archived, not deleted: still on disk, still linked to its replacement.
    const all = (
      await listSessionMemory(SCOPES, { includeArchived: true })
    ).flatMap((s) => s.entries);
    const stored = all.find((e) => e.id === wrong.id);
    expect(stored?.archivedAt).toBeTruthy();
    expect(stored?.supersededBy).toBe(right.id);
    expect(all.find((e) => e.id === right.id)?.supersedes).toEqual([wrong.id]);
  });

  test("a correction can archive an entry in a DIFFERENT scope of the session", async () => {
    const teamFact = await addSessionMemory(
      TEAM,
      "Deploys run at noon.",
      "tester",
    );
    await addSessionMemory(REPO, "Deploys actually run at 09:00.", "tester", {
      supersedes: [teamFact.id],
      scopes: SCOPES,
    });
    const note = await renderSessionMemoryNote(SCOPES);
    expect(note).not.toContain("noon");
  });

  test("archiveMemories reports ids it could not find instead of failing", async () => {
    const kept = await addSessionMemory(REPO, "A fact.", "tester");
    const res = await archiveMemories(SCOPES, [kept.id, "nosuchid"]);
    expect(res.archived.map((a) => a.entry.id)).toEqual([kept.id]);
    expect(res.missing).toEqual(["nosuchid"]);
  });

  test("restore puts an archived entry back into the prompt", async () => {
    const e = await addSessionMemory(REPO, "Recoverable fact.", "tester");
    await archiveMemories(SCOPES, [e.id]);
    expect(await renderSessionMemoryNote(SCOPES)).not.toContain("Recoverable");
    const restored = await restoreMemory(SCOPES, e.id);
    expect(restored?.entry.archivedAt).toBeUndefined();
    expect(await renderSessionMemoryNote(SCOPES)).toContain("Recoverable");
  });

  test("an entry cannot supersede itself", async () => {
    const e = await addSessionMemory(REPO, "Self.", "tester");
    await archiveMemories(SCOPES, [e.id], e.id);
    expect(
      activeMemories(
        (await listSessionMemory(SCOPES, { includeArchived: true }))[0].entries,
      ),
    ).toHaveLength(1);
  });
});

describe("search", () => {
  test("finds archived entries, so a budget never loses information", async () => {
    const old = await addSessionMemory(
      REPO,
      "The postgres socket lives in /var/run.",
      "tester",
    );
    await addSessionMemory(
      REPO,
      "Correction: the postgres socket is in /tmp.",
      "tester",
      {
        supersedes: [old.id],
        scopes: SCOPES,
      },
    );
    const hits = await searchSessionMemory(SCOPES, "postgres socket");
    expect(hits).toHaveLength(2);
    // Current entry first, superseded one behind it and marked.
    expect(hits[0].archived).toBe(false);
    expect(hits[1].archived).toBe(true);
  });

  test("every term must match, so a long entry does not match by accident", async () => {
    await addSessionMemory(
      REPO,
      "A long entry mentioning deploy and cache and socket.",
      "tester",
    );
    expect(await searchSessionMemory(SCOPES, "deploy cache")).toHaveLength(1);
    expect(await searchSessionMemory(SCOPES, "deploy kubernetes")).toHaveLength(
      0,
    );
  });

  test("archived entries can be excluded", async () => {
    const e = await addSessionMemory(REPO, "retired fact", "tester");
    await archiveMemories(SCOPES, [e.id]);
    expect(
      await searchSessionMemory(SCOPES, "retired", { includeArchived: false }),
    ).toHaveLength(0);
    expect(await searchSessionMemory(SCOPES, "retired")).toHaveLength(1);
  });

  test("an empty query returns nothing rather than everything", async () => {
    await addSessionMemory(REPO, "anything", "tester");
    expect(await searchSessionMemory(SCOPES, "   ")).toHaveLength(0);
  });
});

describe("budget", () => {
  const big = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) =>
      entry(
        `${prefix}${i}`.padEnd(8, "x"),
        `${prefix} fact ${i} ${"y".repeat(1000)}`,
        `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      ),
    );

  test("keeps newest entries and drops oldest when the budget binds", () => {
    const scoped = [{ scope: REPO, entries: big(20, "r") }];
    const selected = selectWithinBudget(scoped, 5_000);
    const kept = selected.get(REPO.key)!;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(20);
    // The newest survive...
    expect(kept.at(-1)!.id).toBe(scoped[0].entries.at(-1)!.id);
    // ...and what is kept is still in chronological order, so the note reads
    // as a history rather than backwards.
    const ats = kept.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);
  });

  test("a huge repo scope cannot starve the team scope", () => {
    const scoped = [
      { scope: REPO, entries: big(200, "r") },
      { scope: TEAM, entries: big(5, "t") },
    ];
    const selected = selectWithinBudget(scoped, 20_000);
    expect(selected.get(TEAM.key)!.length).toBeGreaterThan(0);
  });

  test("everything is kept when it fits", () => {
    const scoped = [{ scope: REPO, entries: big(3, "r") }];
    expect(selectWithinBudget(scoped, 1_000_000).get(REPO.key)).toHaveLength(3);
  });

  test("the note says what was held back and how to reach it", async () => {
    await saveScope(REPO.key, big(40, "r"));
    const note = await renderSessionMemoryNote(SCOPES, { budgetChars: 6_000 });
    expect(note).toMatch(/held back/);
    expect(note).toContain("search_memory");
  });

  test("entries are never truncated mid-sentence", async () => {
    await saveScope(REPO.key, big(40, "r"));
    const note = await renderSessionMemoryNote(SCOPES, { budgetChars: 6_000 });
    for (const line of note.split("\n").filter((l) => l.startsWith("- ["))) {
      // Every rendered entry carries its full 1000-char body.
      expect(line).toContain("y".repeat(1000));
    }
  });
});

describe("snapshot", () => {
  test("a session reuses the same bytes even after the store changes", async () => {
    await addSessionMemory(REPO, "First fact.", "tester");
    const build = () => renderSessionMemoryNote(SCOPES);
    const first = await snapshotMemoryNote("session-a", build);

    // Another session writes to a scope this one injects.
    await addSessionMemory(REPO, "Someone else's fact.", "tester");
    expect(await snapshotMemoryNote("session-a", build)).toBe(first);

    // A fresh session sees the new state.
    expect(await snapshotMemoryNote("session-b", build)).toContain(
      "Someone else's fact",
    );
  });

  test("this session's own write refreshes its snapshot", async () => {
    const build = () => renderSessionMemoryNote(SCOPES);
    await snapshotMemoryNote("session-c", build);
    await addSessionMemory(REPO, "My own new fact.", "tester");
    invalidateMemorySnapshot("session-c");
    expect(await snapshotMemoryNote("session-c", build)).toContain(
      "My own new fact",
    );
  });

  test("no session id means no snapshot, so non-session callers are unaffected", async () => {
    await addSessionMemory(REPO, "One.", "tester");
    const build = () => renderSessionMemoryNote(SCOPES);
    await snapshotMemoryNote(undefined, build);
    await addSessionMemory(REPO, "Two.", "tester");
    expect(await snapshotMemoryNote(undefined, build)).toContain("Two.");
  });
});
