/**
 * Intake-time prompt durability (2026-07-24, bks-019f93ea: a restart killed a
 * create-run during engine-server spawn and the opening prompt was lost from
 * every store). run-session persists the user line at intake with a stable
 * uuid, and the runner's own transcript write reuses that uuid — these tests
 * pin the store contract that makes the two writes ONE bubble: upsert-dedupe
 * by (session_id, uuid), with the later (context-decorated) write replacing
 * the intake row in place.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setTranscriptStoreForTest,
  TranscriptStore,
} from "./transcript-store";
import {
  storeAppendUserLineEarly,
  transcriptLineUser,
} from "./transcript-persistence";
import { parseJsonlLines } from "./jsonl-parser";

async function withStore(run: (store: TranscriptStore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "transcript-early-persist-"));
  try {
    const store = new TranscriptStore(join(dir, "transcripts.db"));
    try {
      await run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SESSION = "bks-early-persist-test";

function userEntries(text: string, uuid: string, sourceMessageIds?: string[]) {
  return parseJsonlLines([
    JSON.stringify(
      transcriptLineUser(text, uuid, undefined, undefined, sourceMessageIds),
    ),
  ]);
}

describe("intake-time user-line persist", () => {
  test("session creation persists the visible prompt before workspace setup", async () => {
    const source = await Bun.file(
      new URL("./session-create.ts", import.meta.url),
    ).text();
    // The prompt row is one required write keyed by the durable dispatch id.
    const helper = source.indexOf("async function appendOpeningPromptLine(");
    const helperEnd = source.indexOf("\n}\n", helper);
    const promptWrite = source.indexOf(
      "await storeAppendUserLineEarly(",
      helper,
    );
    expect(helper).toBeGreaterThan(-1);
    expect(promptWrite).toBeGreaterThan(helper);
    expect(promptWrite).toBeLessThan(helperEnd);
    expect(source.slice(promptWrite, helperEnd)).toContain("required: true");

    // An accepted create writes its session file and that row before any git
    // work runs, so a setup failure or a slow effect cannot leave a titled but
    // empty session, or no session at all.
    const projection = source.indexOf("async function projectAcceptedCreate(");
    const fileWrite = source.indexOf("await updateSessionFile(", projection);
    const projectedPrompt = source.indexOf(
      "await appendOpeningPromptLine(",
      fileWrite,
    );
    expect(fileWrite).toBeGreaterThan(projection);
    expect(projectedPrompt).toBeGreaterThan(fileWrite);
    const opening = source.indexOf("export function runOpeningCreateOnce(");
    const projected = source.indexOf("await projectAcceptedCreate(", opening);
    const workspaceSetup = source.indexOf(
      "await spec.materializeWorktree();",
      projected,
    );
    expect(projected).toBeGreaterThan(opening);
    expect(workspaceSetup).toBeGreaterThan(projected);

    // The opening turn repeats both writes after its own persist, so a
    // restart-recovered opening reaches the same state.
    const persisted = source.indexOf("await persist();");
    expect(persisted).toBeGreaterThan(-1);
    expect(
      source.indexOf("await appendOpeningPromptLine(", persisted),
    ).toBeGreaterThan(persisted);
  });

  test("run intake persists sender attribution at its durability boundary", async () => {
    const source = await Bun.file(
      new URL("./run-session.ts", import.meta.url),
    ).text();
    const runStart = source.indexOf("async function runSessionPromptInner(");
    const attribution = source.indexOf(
      "let prompt = withPromptAttribution(",
      runStart,
    );
    const promptWrite = source.indexOf("storeAppendUserLineEarly(", runStart);

    expect(runStart).toBeGreaterThan(-1);
    expect(attribution).toBeGreaterThan(runStart);
    expect(promptWrite).toBeGreaterThan(attribution);
    expect(source.slice(promptWrite - 10, promptWrite)).toContain("await");
    expect(source.slice(promptWrite, promptWrite + 500)).toContain(
      "transcriptLineUser(\n        prompt,",
    );
    expect(source.slice(promptWrite, promptWrite + 500)).toContain(
      "required: true",
    );
  });

  test("required intake writes fail closed when the actor append fails", async () => {
    await withStore(async (store) => {
      const previous = __setTranscriptStoreForTest(store);
      (
        store as unknown as { applyActorRequest: () => never }
      ).applyActorRequest = () => {
        throw new Error("actor append failed");
      };
      try {
        await expect(
          storeAppendUserLineEarly(
            SESSION,
            transcriptLineUser("required", "required-id"),
            { required: true },
          ),
        ).rejects.toThrow("actor append failed");
        await expect(
          storeAppendUserLineEarly(
            SESSION,
            transcriptLineUser("best effort", "best-effort-id"),
          ),
        ).resolves.toBeUndefined();
      } finally {
        __setTranscriptStoreForTest(previous);
      }
    });
  });

  test("intake write + runner write with the same uuid = one upserted row", async () => {
    await withStore(async (store) => {
      const uuid = "prompt-uuid-1";
      // Intake: raw user content, persisted before any engine exists.
      const first = await store.appendTranscriptEvents(
        SESSION,
        userEntries("fix the mask selection", uuid, ["delivery-one"]),
      );
      expect(first).toMatchObject({ inserted: 1, updated: 0 });

      // Runner start: same uuid, content now carries the context decoration.
      const second = await store.appendTranscriptEvents(
        SESSION,
        userEntries(
          "<opensession:context>\nhandoff\n</backstage:context>\n\nfix the mask selection",
          uuid,
        ),
      );
      expect(second).toMatchObject({ inserted: 0, updated: 1 });

      const tail = store.readTail(SESSION);
      const users = tail.entries.filter((e) => e.type === "user");
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(uuid);
      expect(users[0].content).toContain("fix the mask selection");
      expect(users[0].sourceMessageIds).toEqual(["delivery-one"]);
    });
  });

  test("a re-run with a DIFFERENT uuid would duplicate — the contract promptEntryId exists to prevent", async () => {
    await withStore(async (store) => {
      await store.appendTranscriptEvents(
        SESSION,
        userEntries("do the thing", "uuid-a"),
      );
      await store.appendTranscriptEvents(
        SESSION,
        userEntries("do the thing", "uuid-b"),
      );
      const users = store
        .readTail(SESSION)
        .entries.filter((e) => e.type === "user");
      expect(users).toHaveLength(2);
    });
  });

  test("a session first touched by an intake write is marked live-only, not import-blocked", async () => {
    await withStore(async (store) => {
      expect(store.needsImport(SESSION)).toBe(true);
      await store.appendTranscriptEvents(
        SESSION,
        userEntries("first ever message", "u1"),
      );
      expect(store.needsImport(SESSION)).toBe(false);
      expect(store.readTail(SESSION).entries).toHaveLength(1);
    });
  });
});
