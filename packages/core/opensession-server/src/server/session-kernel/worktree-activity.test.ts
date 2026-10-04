import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionKernelStore } from "./store";
import {
  migrateSessionMetadataSchema33,
  migrateWorktreeActivitySchema35,
} from "./metadata-store";

test("worktree activity lookup is indexed and separates active, queued and unknown siblings", () => {
  const store = new SessionKernelStore(":memory:");
  try {
    for (const id of ["self", "idle", "active", "queued", "unknown", "other"]) {
      store.seedSessionMetadataCatalog([
        {
          sessionId: id,
          doc: JSON.stringify({
            id,
            worktreeDir: id === "other" ? "/tmp/other" : "/tmp/acme",
          }),
          rev: 1,
          archived: false,
          lastActivityMs: 0,
        },
      ]);
    }
    for (const id of ["self", "idle", "other"])
      store.projectWorktreeActivity(id, false, false);
    store.projectWorktreeActivity("active", true, false);
    store.projectWorktreeActivity("queued", false, true);
    expect(store.worktreeActivity("/tmp/acme", "self")).not.toHaveLength(0);
    expect(store.worktreeActivity("/tmp/other", "other")).toEqual([]);
    expect(store.sessionsInWorktree("/tmp/acme").sort()).toEqual([
      "active",
      "idle",
      "queued",
      "self",
      "unknown",
    ]);
    store.projectWorktreeActivity("active", false, false);
    store.projectWorktreeActivity("queued", false, false);
    store.projectWorktreeActivity("unknown", false, false);
    expect(store.worktreeActivity("/tmp/acme", "self")).toEqual([]);
  } finally {
    store.close();
  }
  const db = new Database(":memory:");
  try {
    migrateSessionMetadataSchema33(db, 0);
    migrateWorktreeActivitySchema35(db, 33);
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT session_id FROM session_kernel_metadata_catalog WHERE json_extract(doc, '$.worktreeDir') = ?",
      )
      .all("/tmp/acme");
    expect(JSON.stringify(plan)).toContain("idx_skmc_worktree");
  } finally {
    db.close();
  }
});
