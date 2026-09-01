import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { TranscriptStore } from "./transcript-store";
import { transcriptEntryMatchSnippet } from "./transcript-search";
import { searchStoredTranscripts } from "./transcript-search-worker";
import { sessionKernelSessionDbPath } from "./session-kernel/store";
import type { TranscriptEntry } from "./types";

describe("transcript search", () => {
  let root = "";
  const stores: TranscriptStore[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "transcript-search-"));
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function entry(
    id: string,
    content: string,
    extra: Partial<TranscriptEntry> = {},
  ): TranscriptEntry {
    return {
      id,
      type: "assistant",
      content,
      ...extra,
      timestamp: extra.timestamp ?? "2026-08-20T10:00:00Z",
    };
  }

  function append(sessionId: string, entries: TranscriptEntry[]): void {
    const store = new TranscriptStore(
      sessionKernelSessionDbPath(sessionId, root),
    );
    stores.push(store);
    store.appendTranscriptEvents(sessionId, entries);
  }

  test("matches visible text in requested session order from read-only actor files", () => {
    append("newer", [
      entry("tool", "Ran a command", {
        type: "tool_use",
        toolInput: { command: "echo NEEDLE" },
      }),
    ]);
    append("older", [entry("answer", "The needle is here")]);
    append("metadata", [entry("needle-only-id", "Nothing visible")]);

    const result = searchStoredTranscripts({
      isolatedRoot: root,
      query: "needle",
      sessionIds: ["newer", "older", "metadata"],
    });
    expect(result.matches.map((match) => match.id)).toEqual(["newer", "older"]);
    expect(result.matches[0]!.snippet).toContain("NEEDLE");
    expect(result.searchedSessions).toBe(3);
  });

  test("pages beyond the newest 24 rows within the global budget", () => {
    append(
      "deep",
      Array.from({ length: 60 }, (_, i) =>
        entry(
          `deep-${i}`,
          i === 10 ? "older needle survives paging" : `ordinary row ${i}`,
        ),
      ),
    );
    const result = searchStoredTranscripts({
      isolatedRoot: root,
      query: "older needle",
      sessionIds: ["deep"],
      maxRows: 60,
    });
    expect(result.matches).toMatchObject([{ id: "deep" }]);
    expect(result.candidateRows).toBeGreaterThan(24);
  });

  test("skips actor databases whose transcript schema is not initialized", () => {
    append("match", [entry("answer", "needle after an empty actor database")]);
    const path = sessionKernelSessionDbPath("kernel-only", root);
    mkdirSync(dirname(path), { recursive: true });
    const kernelOnly = new Database(path);
    kernelOnly.exec("CREATE TABLE session_kernel_state (id TEXT PRIMARY KEY)");
    kernelOnly.close();

    const result = searchStoredTranscripts({
      isolatedRoot: root,
      query: "needle",
      sessionIds: ["kernel-only", "match"],
    });
    expect(result).toMatchObject({
      matches: [{ id: "match" }],
      searchedSessions: 2,
      candidateRows: 1,
    });
  });

  test("enforces total session and candidate-row budgets", () => {
    for (const id of ["one", "two", "three"])
      append(
        id,
        Array.from({ length: 4 }, (_, i) =>
          entry(`${id}-${i}`, "shared phrase"),
        ),
      );
    expect(
      searchStoredTranscripts({
        isolatedRoot: root,
        query: "shared phrase",
        sessionIds: ["one", "two", "three"],
        maxMatches: 10,
        maxSessions: 2,
      }),
    ).toMatchObject({
      searchedSessions: 2,
      exhausted: "sessions",
    });
    expect(
      searchStoredTranscripts({
        isolatedRoot: root,
        query: "shared phrase",
        sessionIds: ["one", "two", "three"],
        maxMatches: 10,
        maxRows: 1,
      }),
    ).toMatchObject({
      candidateRows: 1,
      exhausted: "rows",
    });
  });

  test("enforces a wall-clock budget", () => {
    append("one", [entry("a", "needle")]);
    let tick = 0;
    const result = searchStoredTranscripts(
      {
        isolatedRoot: root,
        query: "needle",
        sessionIds: ["one", "two"],
        maxMs: 1,
      },
      () => tick++,
    );
    expect(result).toMatchObject({ searchedSessions: 0, exhausted: "time" });
  });

  test("global route dispatches a worker instead of scanning actor mailboxes", () => {
    const route = readFileSync(
      join(import.meta.dir, "routes/sessions.ts"),
      "utf8",
    );
    const search = route.slice(
      route.indexOf("async function searchStoredTranscripts"),
      route.indexOf("async function ripgrepFiles"),
    );
    expect(search).toContain("transcriptSearchWorkerArgv");
    expect(search).not.toContain("transcript.search");
    expect(search).toContain("signal?.addEventListener");
    expect(search).toContain("exhausted");
    expect(route).toContain("stored.exhausted !== null");
    expect(route).toContain("stored.searchedSessions < recentIds.length");
  });

  test("builds one-line context around a match", () => {
    expect(
      transcriptEntryMatchSnippet(
        entry("a", `before ${"x".repeat(80)}\nNeedle\tafter`),
        "needle",
        12,
      ),
    ).toMatch(/^….*Needle after$/);
  });
});
