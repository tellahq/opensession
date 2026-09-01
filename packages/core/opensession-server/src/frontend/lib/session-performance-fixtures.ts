import type { TranscriptEntry } from "./types";

/** Deterministic transcript fixtures for profiling without production data. */
export function makeSessionFixture(
  count: 200 | 2_000 | 10_000,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let index = 0; index < count; index++) {
    const turn = Math.floor(index / 5);
    const slot = index % 5;
    const id = `fixture-${String(index).padStart(5, "0")}`;
    if (slot === 0) {
      entries.push({
        id,
        type: "user",
        content: `Request ${turn}: inspect the session and make the smallest safe change.`,
        timestamp: new Date(base + index * 100).toISOString(),
      });
    } else if (slot === 1 || slot === 3) {
      const toolUseId = `tool-${index}`;
      entries.push({
        id,
        type: "tool_use",
        content: "Using Read",
        toolName: slot === 1 ? "Read" : "Bash",
        toolUseId,
        toolInput:
          slot === 1
            ? { file_path: `src/fixture-${turn % 40}.ts` }
            : { command: `bun test fixture-${turn % 20}` },
        timestamp: new Date(base + index * 100).toISOString(),
      });
    } else {
      entries.push({
        id,
        type: "assistant",
        content:
          slot === 4
            ? `Implemented fixture turn ${turn}. The result is intentionally concise.`
            : `I’m checking the relevant evidence for turn ${turn}.`,
        timestamp: new Date(base + index * 100).toISOString(),
      });
    }
  }
  return entries;
}

export function makeStreamDeltas(
  perSecond = 100,
  seconds = 1,
): Array<{ atMs: number; text: string }> {
  return Array.from({ length: perSecond * seconds }, (_, index) => ({
    atMs: Math.floor((index * 1_000) / perSecond),
    text: `${index % 11 === 0 ? "\n" : " "}delta-${index}`,
  }));
}
