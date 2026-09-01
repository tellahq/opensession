import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
type UsageDay = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const root = mkdtempSync(join(tmpdir(), "analytics-home-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

const { buildHomeStats } = await import(`./analytics?home-stats=${Date.now()}`);

const NOW = Date.parse("2026-08-16T12:00:00Z");

function event(fields: Record<string, unknown>): string {
  return JSON.stringify({
    time: "2026-08-16T10:00:00Z",
    service: "opensession",
    ...fields,
  });
}

function usage(_date: string, input: number, output: number): UsageDay {
  return { input, output, cacheRead: input * 10, cacheWrite: output * 10 };
}

beforeAll(() => {
  const auditDir = join(root, ".opensession-audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    join(auditDir, "audit-2026-08-16.jsonl"),
    [
      event({
        msg: "pi_turn",
        direction: "out",
        session: "session-a",
        run_kind: "prompt",
        model: "pi/anthropic/claude-opus-5",
        ok: false,
      }),
      event({
        kind: "session_turn_metric",
        session_id: "session-a",
        duration_ms: 300,
        outcome: "failed",
      }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(auditDir, "audit-2026-08-15.jsonl"),
    event({
      kind: "result",
      session_id: "session-a",
      input_tokens: 3,
      output_tokens: 4,
    }) + "\n",
  );
});

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  rmSync(root, { recursive: true, force: true });
});

test("Home takes activity from audit and tokens from engine usage", async () => {
  const loadedDates: string[][] = [];
  const stats = await buildHomeStats(NOW, async (dates: string[]) => {
    loadedDates.push(dates);
    return new Map([
      ["2026-08-16", usage("2026-08-16", 100, 200)],
      ["2026-08-15", usage("2026-08-15", 10, 20)],
    ]);
  });

  expect(loadedDates).toEqual([
    Array.from({ length: 15 }, (_, back) =>
      new Date(NOW - back * 86_400_000).toISOString().slice(0, 10),
    ),
  ]);
  expect(stats.today).toEqual({
    sessions: 1,
    turns: 1,
    errors: 1,
    durationMs: 300,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 2_000,
  });
  expect(stats.week).toMatchObject({
    sessions: 1,
    turns: 2,
    inputTokens: 110,
    outputTokens: 220,
    cacheReadTokens: 1_100,
    cacheWriteTokens: 2_200,
  });
  expect(stats.completeWeek).toMatchObject({
    sessions: 1,
    turns: 1,
    inputTokens: 10,
    outputTokens: 20,
  });
});
