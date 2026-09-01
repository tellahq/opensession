/**
 * Reading a DIRECT-SDK engine session's transcript by engine session id.
 *
 * claude-direct and codex-direct reuse the legacy provider tags
 * ("claude"/"codex") and session-id slots (claudeSessionId/codexThreadId) of
 * the CLI engines they replace, but they persist into the transcript STORE
 * under the engine session id — there is no worktree jsonl and no codex
 * rollout. readEngineTranscript is what the cross-engine handoff builds its
 * note from, so its claude/codex arms have to fall through to the store read
 * when the file isn't on disk; otherwise a handoff FROM one of these sessions
 * hands the incoming engine a blank conversation.
 *
 * What this file pins is the SELECTION: a real file still wins (legacy
 * behavior, unchanged), and a missing one delegates instead of returning the
 * unparsed path. The store read it delegates to (engineStoreTranscript) is the
 * same one pi has used since it shipped.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readEngineTranscript,
  readEngineTranscriptAsync,
  getEngineTranscriptPath,
} from "./sessions";

const scratch = mkdtempSync(join(tmpdir(), "direct-engine-transcript-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Write a claude-shape jsonl where getEngineTranscriptPath will look for it. */
function writeLegacyJsonl(
  worktree: string,
  engineSessionId: string,
  text: string,
) {
  const path = getEngineTranscriptPath(worktree, engineSessionId, "claude")!;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "assistant",
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    ].join("\n") + "\n",
  );
  return path;
}

describe("readEngineTranscript for direct-SDK engine sessions", () => {
  test("a legacy claude jsonl on disk is still parsed", async () => {
    const engineId = crypto.randomUUID();
    writeLegacyJsonl(scratch, engineId, "from the legacy file");
    for (const entries of [
      readEngineTranscript(scratch, engineId, "claude"),
      await readEngineTranscriptAsync(scratch, engineId, "claude"),
    ]) {
      expect(entries.map((e) => e.content).join("\n")).toContain(
        "from the legacy file",
      );
    }
  });

  test("no file on disk delegates to the store instead of failing", async () => {
    // Nothing wrote these ids anywhere, so the store answers empty too — the
    // point is that the read resolves through the store path rather than
    // throwing or parsing a path that does not exist.
    const engineId = crypto.randomUUID();
    expect(readEngineTranscript(scratch, engineId, "claude")).toEqual([]);
    expect(
      await readEngineTranscriptAsync(scratch, engineId, "claude"),
    ).toEqual([]);
    expect(readEngineTranscript(scratch, "", "codex")).toEqual([]);
  });
});
