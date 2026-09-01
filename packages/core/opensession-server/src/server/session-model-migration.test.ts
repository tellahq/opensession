import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setSessionsDirForTest } from "./paths";

const scratch = mkdtempSync(join(tmpdir(), "migrate-engine-test-"));
const prevDir = __setSessionsDirForTest(scratch);

// Import AFTER repointing the sessions dir isn't required (the module reads the
// live binding per call), but cache-bust anyway for isolation.
const {
  migrateSessionEngine,
  isAutomationOwnedSession,
  sessionHasJournaledRun,
} = await import("./session-model-migration");

function writeSession(id: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(scratch, `${id}.json`),
    JSON.stringify({
      id,
      claudeSessionId: "11111111-2222-7000-8000-000000000000",
      branch: "",
      worktreeDir: "/tmp",
      createdBy: "Alex",
      createdAt: "2026-07-08T00:00:00.000Z",
      lastActivity: "2026-07-08T00:00:00.000Z",
      model: "claude-haiku-4-5",
      ...extra,
    }),
  );
}

beforeAll(() => {
  writeSession("bks-mig-ok");
  writeSession("bks-mig-automation", { automation: "plain triage" });
  writeSession("bks-mig-automation2", { createdBy: "triage (automation)" });
  writeSession("bks-mig-busy");
  writeFileSync(
    join(scratch, "active-runs.json"),
    JSON.stringify({
      runkey1: {
        runKey: "runkey1",
        osSessionId: "bks-mig-busy",
        cwd: "/tmp",
        startedAt: "now",
      },
    }),
  );
});

afterAll(() => {
  __setSessionsDirForTest(prevDir);
  rmSync(scratch, { recursive: true, force: true });
});

describe("migrateSessionEngine", async () => {
  test("flips the model and records modelHistory", async () => {
    const res = await migrateSessionEngine(
      "bks-mig-ok",
      "pi/anthropic/claude-haiku-4-5",
      "tester",
    );
    expect(res).toMatchObject({
      ok: true,
      from: "claude-haiku-4-5",
      to: "pi/anthropic/claude-haiku-4-5",
    });
    const data = JSON.parse(
      readFileSync(join(scratch, "bks-mig-ok.json"), "utf-8"),
    );
    expect(data.model).toBe("pi/anthropic/claude-haiku-4-5");
    expect(data.claudeSessionId).toBe("11111111-2222-7000-8000-000000000000"); // untouched
    expect(data.modelHistory).toHaveLength(1);
    expect(data.modelHistory[0]).toMatchObject({
      model: "pi/anthropic/claude-haiku-4-5",
      from: "claude-haiku-4-5",
      by: "tester",
    });
    // Idempotent: same target again is ok, no duplicate history entry.
    const again = await migrateSessionEngine(
      "bks-mig-ok",
      "pi/anthropic/claude-haiku-4-5",
    );
    expect(again.ok).toBe(true);
    expect(
      JSON.parse(readFileSync(join(scratch, "bks-mig-ok.json"), "utf-8"))
        .modelHistory,
    ).toHaveLength(1);
  });

  test("rejects targets that name a model rather than an engine", async () => {
    // A bare native slug dispatches to whatever the default engine is — it is
    // not an engine choice, so it can't be a migration target.
    for (const target of ["claude-sonnet-5", "gpt-5.6-sol", "nonsense"]) {
      const res = await migrateSessionEngine("bks-mig-ok", target);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("not an engine model id");
    }
  });

  test("accepts any enabled engine, not just pi", async () => {
    // pi ids need no extra switch here: the pi runner reports its own config
    // gate at run time.
    const pi = await migrateSessionEngine(
      "bks-mig-ok",
      "pi/anthropic/claude-opus-5",
    );
    expect(pi.ok).toBe(true);
    if (pi.ok) expect(pi.to).toBe("pi/anthropic/claude-opus-5");

    // A legacy direct-engine id normalizes onto pi (the engines are
    // removed), so the flip lands the session on a runnable engine rather
    // than failing or bricking it.
    const legacy = await migrateSessionEngine(
      "bks-mig-ok",
      "claude/anthropic/claude-opus-5",
    );
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.to).toBe("pi/anthropic/claude-opus-5");
    // Leave the session where the other tests expect it.
    await migrateSessionEngine("bks-mig-ok", "pi/anthropic/claude-haiku-4-5");
  });

  test("allows automation-owned sessions to migrate to Pi", async () => {
    for (const id of ["bks-mig-automation", "bks-mig-automation2"]) {
      const pi = await migrateSessionEngine(
        id,
        "pi/anthropic/claude-haiku-4-5",
      );
      expect(pi.ok).toBe(true);
      if (pi.ok) expect(pi.to).toBe("pi/anthropic/claude-haiku-4-5");
    }
    expect(isAutomationOwnedSession({ automation: "x", createdBy: "y" })).toBe(
      true,
    );
    expect(isAutomationOwnedSession({ createdBy: "Alex" })).toBe(false);
  });

  test("can preserve last activity during a fleet migration", async () => {
    writeSession("bks-mig-preserve");
    const res = await migrateSessionEngine(
      "bks-mig-preserve",
      "pi/anthropic/claude-haiku-4-5",
      "fleet",
      { preserveActivity: true },
    );
    expect(res.ok).toBe(true);
    const data = JSON.parse(
      readFileSync(join(scratch, "bks-mig-preserve.json"), "utf-8"),
    );
    expect(data.lastActivity).toBe("2026-07-08T00:00:00.000Z");
    expect(data.modelHistory.at(-1)).toMatchObject({ by: "fleet" });
  });

  test("rejects sessions with an in-flight journaled run", async () => {
    expect(sessionHasJournaledRun("bks-mig-busy")).toBe(true);
    const res = await migrateSessionEngine(
      "bks-mig-busy",
      "pi/anthropic/claude-haiku-4-5",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("in-flight");
  });

  test("rejects unknown sessions", async () => {
    const res = await migrateSessionEngine(
      "bks-nope",
      "pi/anthropic/claude-haiku-4-5",
    );
    expect(res.ok).toBe(false);
  });
});
