import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "../transcript-store";
import { SessionKernelStoreHost } from "./store-host";
import {
  SESSION_KERNEL_SCHEMA_VERSION,
  SessionKernelStore,
  sessionKernelSessionDbPath,
} from "./store";
import {
  migrateActorTranscriptsOffline,
  rollbackActorTranscriptsOffline,
} from "./transcript-offline-migration";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "actor-transcript-migration-"));
  roots.push(root);
  const centralPath = join(root, "session-kernel.sqlite");
  const isolatedRoot = join(root, "session-kernel-sessions");
  const sourcePath = join(root, "transcripts.db");
  const sessionId = "fixture-session";
  const central = new SessionKernelStore(centralPath);
  central.setRunState({ sessionId, state: "idle", event: "seed" });
  central.close();
  const host = new SessionKernelStoreHost(centralPath, isolatedRoot);
  expect(host.migrateLegacySessions(1)).toBe(1);
  host.close();

  const source = new TranscriptStore(sourcePath);
  const oversized = "x".repeat(40_000);
  await source.importLegacyTranscript(
    sessionId,
    [
      {
        id: "old",
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: oversized,
      },
    ],
    "merged",
    123,
  );
  await source.importLegacyTranscript(
    "orphan-without-placement",
    [
      {
        id: "orphan",
        type: "system",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "rollback evidence only",
      },
    ],
    "merged",
    10,
  );
  await source.appendTranscriptDestination({
    sessionId,
    appendId: "destination-one",
    runId: "run-one",
    turnId: "turn-one",
    generation: 1,
    entries: [
      {
        id: "new",
        type: "user",
        timestamp: "2026-01-01T00:00:01.000Z",
        content: "hello",
      },
    ],
  });
  source.close();
  return {
    root,
    centralPath,
    isolatedRoot,
    sourceTranscriptPath: sourcePath,
    sessionId,
  };
}

function snapshot(store: TranscriptStore, sessionId: string) {
  return {
    tail: store.readTail(sessionId, 100),
    outline: store.readTranscriptIndex(sessionId),
    old: store.getFullEntry(sessionId, "old"),
    info: store.getImportInfo(sessionId),
    count: store.countEvents(sessionId),
    seq: store.getLastSeq(sessionId),
    changeSeq: store.getLastChangeSeq(sessionId),
    reset: store.getLastResetChangeSeq(sessionId),
  };
}

describe("offline actor transcript migration", () => {
  test("copies exact transcript authority and leaves the rollback source untouched", async () => {
    const paths = await fixture();
    const beforeBytes = readFileSync(paths.sourceTranscriptPath);
    const beforeMode = statSync(paths.sourceTranscriptPath).mode & 0o777;
    const source = new TranscriptStore(paths.sourceTranscriptPath);
    const expected = snapshot(source, paths.sessionId);
    source.close();

    const audit = migrateActorTranscriptsOffline({ ...paths, dryRun: true });
    expect(audit).toMatchObject({
      dryRun: true,
      migrated: 0,
      claimedTranscriptOnly: 1,
      sessions: [
        { sessionId: paths.sessionId },
        { sessionId: "orphan-without-placement" },
      ],
    });
    let auditCentral = new SessionKernelStore(paths.centralPath);
    expect(
      auditCentral.sessionPlacement(paths.sessionId)?.transcriptAuthority,
    ).toBe("shared");
    expect(
      auditCentral.sessionPlacement("orphan-without-placement"),
    ).toBeUndefined();
    auditCentral.close();
    expect(
      existsSync(
        sessionKernelSessionDbPath(
          "orphan-without-placement",
          paths.isolatedRoot,
        ),
      ),
    ).toBe(false);
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);

    let readOnlyAttachVerified = false;
    const result = migrateActorTranscriptsOffline({
      ...paths,
      afterSourceAttached: (db) => {
        expect(() =>
          db.exec(
            "DELETE FROM source.transcript_events WHERE session_id = 'fixture-session'",
          ),
        ).toThrow("readonly");
        readOnlyAttachVerified = true;
      },
    });
    expect(readOnlyAttachVerified).toBe(true);
    expect(result).toMatchObject({
      migrated: 2,
      adopted: 0,
      migratedLegacyKernel: 0,
      claimedTranscriptOnly: 1,
    });
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);
    expect(statSync(paths.sourceTranscriptPath).mode & 0o777).toBe(beforeMode);

    const target = new TranscriptStore(
      sessionKernelSessionDbPath(paths.sessionId, paths.isolatedRoot),
    );
    expect(snapshot(target, paths.sessionId)).toEqual(expected);
    target.close();
    const targetDb = new Database(
      sessionKernelSessionDbPath(paths.sessionId, paths.isolatedRoot),
      { readonly: true },
    );
    expect(
      (
        targetDb.query("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(SESSION_KERNEL_SCHEMA_VERSION);
    targetDb.close();
    const central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
    });
    expect(central.sessionPlacement("orphan-without-placement")).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
    });
    central.close();

    expect(
      rollbackActorTranscriptsOffline({
        centralPath: paths.centralPath,
        sourceTranscriptPath: paths.sourceTranscriptPath,
        isolatedRoot: paths.isolatedRoot,
      }),
    ).toBe(2);
    auditCentral = new SessionKernelStore(paths.centralPath);
    expect(
      auditCentral.sessionPlacement(paths.sessionId)?.transcriptAuthority,
    ).toBe("shared");
    expect(
      auditCentral.sessionPlacement("orphan-without-placement")
        ?.transcriptAuthority,
    ).toBe("shared");
    auditCentral.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);
  });

  test("allows legacy lazy-outline gaps and backfills them after cutover", async () => {
    const paths = await fixture();
    const sourceDb = new Database(paths.sourceTranscriptPath);
    sourceDb.run("DELETE FROM transcript_outline WHERE session_id = ?", [
      paths.sessionId,
    ]);
    sourceDb.close();

    const result = migrateActorTranscriptsOffline(paths);
    expect(result.migrated).toBe(2);
    const target = new TranscriptStore(
      sessionKernelSessionDbPath(paths.sessionId, paths.isolatedRoot),
    );
    expect(target.readTranscriptIndex(paths.sessionId).entries).toHaveLength(0);
    await target.ensureTranscriptOutline(paths.sessionId);
    expect(target.readTranscriptIndex(paths.sessionId).entries).toHaveLength(
      target.countEvents(paths.sessionId),
    );
    target.close();
  });

  test("allows legacy sparse sequences and events before the reset cursor", async () => {
    const paths = await fixture();
    const source = new Database(paths.sourceTranscriptPath);
    const last = source
      .query(`
      SELECT seq, change_seq FROM transcript_events
      WHERE session_id = ? ORDER BY seq DESC LIMIT 1
    `)
      .get(paths.sessionId) as { seq: number; change_seq: number };
    const sourceCount = Number(
      (
        source
          .query(
            "SELECT COUNT(*) AS value FROM transcript_events WHERE session_id = ?",
          )
          .get(paths.sessionId) as { value: number }
      ).value,
    );
    const minChangeSeq = Number(
      (
        source
          .query(
            "SELECT MIN(change_seq) AS value FROM transcript_events WHERE session_id = ?",
          )
          .get(paths.sessionId) as { value: number }
      ).value,
    );
    source.run(
      "UPDATE transcript_events SET seq = ? WHERE session_id = ? AND seq = ?",
      [last.seq + 1, paths.sessionId, last.seq],
    );
    source.run(
      "UPDATE transcript_outline SET seq = ? WHERE session_id = ? AND seq = ?",
      [last.seq + 1, paths.sessionId, last.seq],
    );
    source.run(
      `
      UPDATE transcript_sessions
      SET next_seq = ?, reset_change_seq = ?
      WHERE session_id = ?
    `,
      [last.seq + 2, minChangeSeq, paths.sessionId],
    );
    source.close();

    expect(migrateActorTranscriptsOffline(paths).migrated).toBe(2);
    const target = new TranscriptStore(
      sessionKernelSessionDbPath(paths.sessionId, paths.isolatedRoot),
    );
    expect(target.countEvents(paths.sessionId)).toBe(sourceCount);
    expect(target.getLastSeq(paths.sessionId)).toBe(last.seq + 1);
    target.close();
  });

  test("rollback fails closed after post-cutover append, import, or replace", async () => {
    for (const operation of ["append", "import", "replace"] as const) {
      const paths = await fixture();
      migrateActorTranscriptsOffline(paths);
      const target = new TranscriptStore(
        sessionKernelSessionDbPath(paths.sessionId, paths.isolatedRoot),
      );
      const entry = {
        id: `post-cutover-${operation}`,
        type: "assistant" as const,
        timestamp: "2026-01-01T00:00:02.000Z",
        content: operation,
      };
      if (operation === "append")
        await target.appendTranscriptEvents(paths.sessionId, [entry]);
      else if (operation === "replace")
        await target.replaceTranscriptEvents(paths.sessionId, [entry]);
      else
        target.applyActorRequest({
          op: "import",
          requestId: "post-cutover-import-request",
          sessionId: paths.sessionId,
          entries: [entry],
          src: "post-cutover",
          watermark: 999,
        });
      target.close();

      if (operation === "append") {
        const bin = join(paths.root, "bin");
        const systemctl = join(bin, "systemctl");
        Bun.spawnSync(["mkdir", "-p", bin]);
        writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\nexit 3\n");
        chmodSync(systemctl, 0o755);
        const cli = Bun.spawnSync(
          [
            process.execPath,
            join(process.cwd(), "scripts/migrate-actor-transcripts.ts"),
            "--rollback",
            "--central",
            paths.centralPath,
            "--source",
            paths.sourceTranscriptPath,
            "--isolated-root",
            paths.isolatedRoot,
          ],
          {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(cli.exitCode).not.toBe(0);
      }
      expect(() =>
        rollbackActorTranscriptsOffline({
          centralPath: paths.centralPath,
          sourceTranscriptPath: paths.sourceTranscriptPath,
          isolatedRoot: paths.isolatedRoot,
        }),
      ).toThrow();
      const central = new SessionKernelStore(paths.centralPath);
      expect(
        central.sessionPlacement(paths.sessionId)?.transcriptAuthority,
      ).toBe("actor");
      central.close();
    }
  });

  test("adopts a verified target after a crash before placement publication", async () => {
    const paths = await fixture();
    const beforeBytes = readFileSync(paths.sourceTranscriptPath);
    const beforeMode = statSync(paths.sourceTranscriptPath).mode & 0o777;
    let verified = 0;
    expect(() =>
      migrateActorTranscriptsOffline({
        ...paths,
        beforePublish: () => {
          verified++;
          if (verified === 2)
            throw new Error("simulated crash before publication");
        },
      }),
    ).toThrow("simulated crash before publication");
    expect(verified).toBe(2);

    let central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe(
      "shared",
    );
    expect(central.sessionPlacement("orphan-without-placement")).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "shared",
    });
    central.close();
    const orphanTarget = new TranscriptStore(
      sessionKernelSessionDbPath(
        "orphan-without-placement",
        paths.isolatedRoot,
      ),
    );
    expect(
      orphanTarget.readTail("orphan-without-placement", 10).entries,
    ).toMatchObject([{ id: "orphan" }]);
    orphanTarget.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);
    expect(statSync(paths.sourceTranscriptPath).mode & 0o777).toBe(beforeMode);

    const adopted = migrateActorTranscriptsOffline(paths);
    expect(adopted).toMatchObject({
      migrated: 0,
      adopted: 2,
      claimedTranscriptOnly: 0,
    });
    central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe(
      "actor",
    );
    central.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);
  });

  test("refuses to adopt a staged target that changed after verification", async () => {
    const paths = await fixture();
    expect(() =>
      migrateActorTranscriptsOffline({
        ...paths,
        beforePublish: () => {
          throw new Error("stop before publication");
        },
      }),
    ).toThrow("stop before publication");
    const target = new Database(
      sessionKernelSessionDbPath(paths.sessionId, paths.isolatedRoot),
    );
    target.run(
      "UPDATE transcript_events SET data = ? WHERE session_id = ? AND seq = 1",
      [JSON.stringify({ changed: true }), paths.sessionId],
    );
    target.close();
    expect(() => migrateActorTranscriptsOffline(paths)).toThrow(
      "target transcript digest differs from source",
    );
    const central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe(
      "shared",
    );
    central.close();
  });

  test("enumerates receipt-only rows and aborts all authority publication", () => {
    const root = mkdtempSync(join(tmpdir(), "actor-transcript-incoherent-"));
    roots.push(root);
    const centralPath = join(root, "session-kernel.sqlite");
    const isolatedRoot = join(root, "session-kernel-sessions");
    const sourceTranscriptPath = join(root, "transcripts.db");
    new SessionKernelStore(centralPath).close();
    new TranscriptStore(sourceTranscriptPath).close();
    const source = new Database(sourceTranscriptPath);
    source.run(`
      INSERT INTO transcript_append_receipts
        (session_id, append_id, request_digest, fence_json, result_json, created_at)
      VALUES ('receipt-only', 'append', 'digest', '{}', '{}', 1)
    `);
    source.close();
    const beforeBytes = readFileSync(sourceTranscriptPath);
    expect(() =>
      migrateActorTranscriptsOffline({
        centralPath,
        isolatedRoot,
        sourceTranscriptPath,
      }),
    ).toThrow("has 0 transcript metadata rows");
    expect(readFileSync(sourceTranscriptPath)).toEqual(beforeBytes);
    const central = new SessionKernelStore(centralPath);
    expect(central.sessionPlacement("receipt-only")).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "shared",
    });
    central.close();
  });

  test("cuts over a legacy central session with no transcript rows", () => {
    const root = mkdtempSync(
      join(tmpdir(), "actor-transcript-no-source-rows-"),
    );
    roots.push(root);
    const centralPath = join(root, "session-kernel.sqlite");
    const isolatedRoot = join(root, "session-kernel-sessions");
    const sourceTranscriptPath = join(root, "transcripts.db");
    const sessionId = "legacy-central-without-transcript";
    const central = new SessionKernelStore(centralPath);
    central.setRunState({ sessionId, state: "idle", event: "legacy" });
    central.close();
    new TranscriptStore(sourceTranscriptPath).close();

    const audit = migrateActorTranscriptsOffline({
      centralPath,
      isolatedRoot,
      sourceTranscriptPath,
      dryRun: true,
    });
    expect(audit).toMatchObject({
      migrated: 0,
      migratedLegacyKernel: 1,
      claimedTranscriptOnly: 0,
      sessions: [{ sessionId }],
    });

    const result = migrateActorTranscriptsOffline({
      centralPath,
      isolatedRoot,
      sourceTranscriptPath,
    });
    expect(result).toMatchObject({
      migrated: 1,
      migratedLegacyKernel: 1,
      claimedTranscriptOnly: 0,
      sessions: [{ sessionId, receipt: audit.sessions[0]!.receipt }],
    });
    const targetPath = sessionKernelSessionDbPath(sessionId, isolatedRoot);
    const targetTranscript = new TranscriptStore(targetPath);
    expect(targetTranscript.countEvents(sessionId)).toBe(0);
    expect(targetTranscript.getImportInfo(sessionId)).toBeNull();
    targetTranscript.close();
    const reopened = new SessionKernelStore(centralPath);
    expect(reopened.hasSessionDurableState(sessionId)).toBe(false);
    expect(reopened.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
      transcriptMigrationReceipt: audit.sessions[0]!.receipt,
    });
    reopened.close();
  });

  test("refuses contradictory transcript evidence for an empty source", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "actor-transcript-empty-conflict-"),
    );
    roots.push(root);
    const centralPath = join(root, "session-kernel.sqlite");
    const isolatedRoot = join(root, "session-kernel-sessions");
    const sourceTranscriptPath = join(root, "transcripts.db");
    const sessionId = "empty-source-with-target-evidence";
    const central = new SessionKernelStore(centralPath);
    central.claimIsolatedSessionForTranscriptMigration(sessionId);
    central.close();
    new TranscriptStore(sourceTranscriptPath).close();
    const target = new TranscriptStore(
      sessionKernelSessionDbPath(sessionId, isolatedRoot),
    );
    await target.appendTranscriptEvents(sessionId, [
      {
        id: "contradiction",
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "must not be erased",
      },
    ]);
    target.close();

    expect(() =>
      migrateActorTranscriptsOffline({
        centralPath,
        isolatedRoot,
        sourceTranscriptPath,
      }),
    ).toThrow("empty transcript target contains transcript_events");
    const preserved = new TranscriptStore(
      sessionKernelSessionDbPath(sessionId, isolatedRoot),
    );
    expect(preserved.readTail(sessionId, 10).entries).toMatchObject([
      { id: "contradiction", content: "must not be erased" },
    ]);
    preserved.close();
    const reopened = new SessionKernelStore(centralPath);
    expect(reopened.sessionPlacement(sessionId)?.transcriptAuthority).toBe(
      "shared",
    );
    reopened.close();
  });

  test("rejects non-positive change cursors and corrupt durable receipts", async () => {
    for (const corruption of ["change-seq", "receipt"] as const) {
      const root = mkdtempSync(
        join(tmpdir(), `actor-transcript-${corruption}-`),
      );
      roots.push(root);
      const centralPath = join(root, "session-kernel.sqlite");
      const isolatedRoot = join(root, "session-kernel-sessions");
      const sourceTranscriptPath = join(root, "transcripts.db");
      const sessionId = `corrupt-${corruption}`;
      new SessionKernelStore(centralPath).close();
      const source = new TranscriptStore(sourceTranscriptPath);
      source.applyActorRequest({
        op: "append",
        requestId: "corrupt-source-request",
        sessionId,
        entries: [
          {
            id: "one",
            type: "user",
            timestamp: "2026-01-01T00:00:00.000Z",
            content: "one",
          },
          {
            id: "two",
            type: "assistant",
            timestamp: "2026-01-01T00:00:01.000Z",
            content: "two",
          },
        ],
      });
      source.close();
      const corrupt = new Database(sourceTranscriptPath);
      if (corruption === "change-seq") {
        corrupt.run(
          "UPDATE transcript_events SET change_seq = 0 WHERE session_id = ? AND seq = 1",
          [sessionId],
        );
        corrupt.run(
          "UPDATE transcript_outline SET change_seq = 0 WHERE session_id = ? AND seq = 1",
          [sessionId],
        );
      } else {
        corrupt.run(
          `UPDATE transcript_append_receipts
           SET result_json = '{"replay":false,"result":{"inserted":"bad","updated":0},"wakeCursor":1}'
           WHERE session_id = ?`,
          [sessionId],
        );
      }
      corrupt.close();

      expect(() =>
        migrateActorTranscriptsOffline({
          centralPath,
          isolatedRoot,
          sourceTranscriptPath,
        }),
      ).toThrow();
      const central = new SessionKernelStore(centralPath);
      expect(central.sessionPlacement(sessionId)?.transcriptAuthority).toBe(
        "shared",
      );
      central.close();
    }
  });

  test("migrates legacy central kernel placement before an empty-reset transcript", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "actor-transcript-legacy-central-"),
    );
    roots.push(root);
    const centralPath = join(root, "session-kernel.sqlite");
    const isolatedRoot = join(root, "session-kernel-sessions");
    const sourceTranscriptPath = join(root, "transcripts.db");
    const sessionId = "legacy-central-empty-reset";
    const central = new SessionKernelStore(centralPath);
    central.setRunState({ sessionId, state: "idle", event: "legacy" });
    central.close();
    const source = new TranscriptStore(sourceTranscriptPath);
    await source.importLegacyTranscript(
      sessionId,
      [
        {
          id: "removed",
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "remove me",
        },
      ],
      "merged",
      42,
    );
    await source.replaceTranscriptEvents(sessionId, []);
    const expected = snapshot(source, sessionId);
    expect(expected).toMatchObject({
      count: 0,
      seq: 0,
      changeSeq: 2,
      reset: 2,
    });
    source.close();

    const result = migrateActorTranscriptsOffline({
      centralPath,
      isolatedRoot,
      sourceTranscriptPath,
    });
    expect(result).toMatchObject({
      migrated: 1,
      migratedLegacyKernel: 1,
      claimedTranscriptOnly: 0,
    });
    const migrated = new TranscriptStore(
      sessionKernelSessionDbPath(sessionId, isolatedRoot),
    );
    expect(snapshot(migrated, sessionId)).toEqual(expected);
    migrated.close();
    const reopened = new SessionKernelStore(centralPath);
    expect(reopened.hasSessionDurableState(sessionId)).toBe(false);
    expect(reopened.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
    });
    reopened.close();
  });
});
