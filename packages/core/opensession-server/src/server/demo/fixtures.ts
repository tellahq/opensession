/**
 * Synthetic demo dataset fixtures — every session, transcript, automation,
 * goal and audit line the generator writes. All content is fictional
 * and PII-free (fake teammates "Alex"/"Sam", fake repo "acme-todo"); nothing
 * here may embed an absolute path from THIS machine — paths are threaded in
 * from the generator, which resolves them through the server's own resolvers
 * (paths.ts / rename-compat.ts), so the dataset lands wherever the instance's
 * state is pointed.
 *
 * Ids are `bks-demo-*`: the `bks-` prefix keeps the two prefix-sensitive
 * readers happy (analytics.ts / workspace-resolve.ts filter on it) while the
 * `demo-` marker makes every artifact greppably synthetic. Engine ids are
 * `ses_demo*` so resolveTranscriptPath picks the pi-engine jsonl
 * (sessions.ts isPiSessionId matches /^ses_/).
 */

import {
  transcriptLineAssistantText,
  transcriptLineCompactionSummary,
  transcriptLineContextInjection,
  transcriptLineRecap,
  transcriptLineRunnerNotice,
  transcriptLineToolResult,
  transcriptLineToolUse,
  transcriptLineUser,
  transcriptLineYouShouldKnow,
} from "../transcript-persistence";
import type { NativeSessionFile } from "../types";
import { MONITOR_FIT_PAGE } from "./monitor-fit-page";
import {
  loopTickMessage,
  youShouldKnowRecordContent,
} from "@tellahq/opensession-protocol/notices";
import { describeLoop, loopTickNote } from "../session-loop";

type JsonlLine = Record<string, unknown>;

export const DEMO_MARKER_FILE = ".demo-marker.json";
export const DEMO_BRANCH = "demo/fix-flaky-upload";
/** The repo the demo dataset pretends to work in. The generator registers it
 *  in the instance config (repo path + worktrees dir both inside the demo
 *  state), which is what makes the PR panel, the Home PR list and the Changes
 *  diff resolve — before that, repoForPath() threw on the demo worktree and
 *  every repo-derived surface came up empty (2026-08-05). */
export const DEMO_REPO_ID = "acme-todo";
export const DEMO_REPO_WT_PREFIX = "acme";
export const DEMO_GH_REPO = "acme/acme-todo";
export const DEMO_LIVE_SESSION_ID = "bks-demo-live";
export const DEMO_LIVE_ENGINE_SESSION_ID = "ses_demolive";
export const DEMO_ASK_SESSION_ID = "bks-demo-ask";
export const DEMO_ASK_ENGINE_SESSION_ID = "ses_demoask";
export const DEMO_PR_NUMBER = 128;
/** The session that shows an HTML render, and where its page is stored. */
export const DEMO_RENDER_SESSION_ID = "bks-demo-render";
export const DEMO_RENDER_ASSET = "html-renders/monitor-arm-clamp-fit-demo.html";
export const DEMO_RENDER_TITLE = "Monitor arm clamp fit";
/** The same page shown from a codemode script through `mcp_call`, the way
 *  pi agents usually reach `html_render`, then a screenshot marker. */
export const DEMO_SCRIPT_RENDER_SESSION_ID = "bks-demo-render-script";

const MODEL_FABLE = "pi/anthropic/claude-fable-5-1";
const MODEL_SONNET = "pi/anthropic/claude-sonnet-5-5";
const MODEL_CODEX = "pi/openai/gpt-5.5-codex";

export interface DemoSessionFixture {
  id: string;
  /** Engine session id; also the transcript jsonl basename. Empty = no jsonl. */
  engineSessionId: string;
  file: NativeSessionFile;
  lines: JsonlLine[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function usage(
  costUsd: number,
  inputTokens: number,
  outputTokens: number,
  turns: number,
  at: string,
) {
  return {
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens: Math.round(inputTokens * 3.2),
    cacheCreationTokens: Math.round(inputTokens * 0.4),
    contextTokens: Math.min(inputTokens + outputTokens, 150_000),
    contextWindow: 200_000,
    turns,
    updatedAt: at,
  };
}

/** A ~40KB tool output so the transcript import exercises the store's
 *  oversized-entry blob path (TRANSCRIPT_DATA_MAX_BYTES = 32KB). */
function bigToolOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 700; i++) {
    lines.push(
      `[upload-worker] chunk=${i} attempt=1 status=200 bytes=524288 latency_ms=${40 + (i % 37)} backoff_ms=0`,
    );
  }
  return lines.join("\n");
}

/** One tool step (use + result) with stable per-session ids. */
function tool(
  sid: string,
  n: number,
  name: string,
  input: unknown,
  output: string,
  at: number,
  isError?: boolean,
): JsonlLine[] {
  const id = `demo-${sid}-t${n}`;
  return [
    transcriptLineToolUse(id, name, input, iso(at)),
    transcriptLineToolResult(id, output, isError, iso(at + 1500)),
  ];
}

// ── The fake repo the transcripts talk about ────────────────────────────────
// Also materialized as a real git repo + worktree by the generator so the
// Diff panel renders a real committed + uncommitted + untracked spread.

export const DEMO_REPO_FILES: Record<string, string> = {
  "README.md": [
    "# acme-todo",
    "",
    "A tiny demo task app. Entirely synthetic — used to seed Open Session's",
    "demo dataset. Nothing here corresponds to a real project.",
    "",
  ].join("\n"),
  "src/upload.ts": [
    "export interface UploadOpts {",
    "  retries?: number;",
    "}",
    "",
    "export async function uploadChunk(",
    "  chunk: Uint8Array,",
    "  opts: UploadOpts = {},",
    "): Promise<void> {",
    "  const max = opts.retries ?? 3;",
    "  // BUG: `<` skips the final attempt — flaky under packet loss.",
    "  for (let attempt = 0; attempt < max - 1; attempt++) {",
    "    if (await tryPut(chunk)) return;",
    "  }",
    "  throw new Error(`upload failed after ${max} attempts`);",
    "}",
    "",
    "async function tryPut(_chunk: Uint8Array): Promise<boolean> {",
    "  return true;",
    "}",
    "",
  ].join("\n"),
  "src/upload.test.ts": [
    'import { expect, it } from "bun:test";',
    'import { uploadChunk } from "./upload";',
    "",
    'it("retries up to the configured limit", async () => {',
    "  await uploadChunk(new Uint8Array(8), { retries: 3 });",
    "});",
    "",
  ].join("\n"),
};

/** The committed fix on the demo branch (upload.ts retry off-by-one). */
export const DEMO_COMMITTED_CHANGE: Record<string, string> = {
  "src/upload.ts": DEMO_REPO_FILES["src/upload.ts"].replace(
    [
      "  // BUG: `<` skips the final attempt — flaky under packet loss.",
      "  for (let attempt = 0; attempt < max - 1; attempt++) {",
    ].join("\n"),
    "  for (let attempt = 0; attempt < max; attempt++) {",
  ),
};

/** Left uncommitted in the worktree (dirty file for the Diff panel). */
export const DEMO_UNCOMMITTED_CHANGE: Record<string, string> = {
  "src/upload.test.ts": DEMO_REPO_FILES["src/upload.test.ts"].replace(
    "});",
    [
      "});",
      "",
      'it("surfaces the terminal error", async () => {',
      "  // TODO(demo): assert the thrown message once tryPut is fakeable.",
      "});",
    ].join("\n"),
  ),
};

export const DEMO_UNTRACKED_FILE: Record<string, string> = {
  "NOTES.md":
    "# Scratch notes\n\n- reproduce with `bun test --rerun-each 50`\n",
};

// ── Sessions + transcripts ──────────────────────────────────────────────────

export function demoSessions(opts: {
  now: number;
  /** The generated demo worktree (real git checkout on DEMO_BRANCH). */
  worktreeDir: string;
  /** The generated base repo (clean checkout on main). */
  repoDir: string;
  /** Where the generator wrote the stills the hero session shows
   *  (generate.ts retryStill); served by the /media route. */
  mediaDir: string;
}): DemoSessionFixture[] {
  const { now, worktreeDir, repoDir, mediaDir } = opts;
  const min = 60_000;
  const sessions: DemoSessionFixture[] = [];

  const base = (
    id: string,
    ocId: string,
    startedAgoMin: number,
    lastAgoMin: number,
    file: Partial<NativeSessionFile>,
  ): NativeSessionFile =>
    ({
      id,
      claudeSessionId: ocId,
      branch: "",
      worktreeDir: "",
      createdBy: "Alex",
      createdAt: iso(now - startedAgoMin * min),
      lastActivity: iso(now - lastAgoMin * min),
      mode: "code",
      model: MODEL_FABLE,
      // Every demo session works in the registered demo repo; without this the
      // UI has to infer the repo from worktreeDir and everything repo-derived
      // (PR panel, diff, Home's PR rows) falls back to empty.
      repo: DEMO_REPO_ID,
      ...file,
    }) as NativeSessionFile;

  // 1. The hero session: completed bug-fix with a real diff + seeded PR.
  {
    const t0 = now - 170 * min;
    sessions.push({
      id: "bks-demo-pr",
      engineSessionId: "ses_demo01",
      file: base("bks-demo-pr", "ses_demo01", 170, 150, {
        title: "Fix flaky upload retry test",
        branch: DEMO_BRANCH,
        worktreeDir,
        usage: usage(1.84, 42_310, 6_920, 9, iso(now - 150 * min)),
      }),
      lines: [
        transcriptLineUser(
          "The upload retry test flakes about once in 40 runs on CI. Find the bug in src/upload.ts and fix it — keep the fix minimal and add a regression note.",
          "demo-pr-u1",
          iso(t0),
        ),
        transcriptLineAssistantText(
          "I'll reproduce first, then read the retry loop.",
          "demo-pr-a1",
          iso(t0 + 20_000),
          MODEL_FABLE,
        ),
        ...tool(
          "pr",
          1,
          "Bash",
          { command: "bun test src/upload.test.ts --rerun-each 50" },
          "49 pass\n1 fail\n\nupload.test.ts > retries up to the configured limit\nerror: upload failed after 3 attempts",
          t0 + 40_000,
        ),
        ...tool(
          "pr",
          2,
          "Read",
          { file_path: "src/upload.ts" },
          DEMO_REPO_FILES["src/upload.ts"],
          t0 + 70_000,
        ),
        transcriptLineAssistantText(
          "Found it: the loop runs `attempt < max - 1`, so with `retries: 3` only two attempts happen — the third, which usually succeeds after transient failures, is skipped. Off-by-one in the retry bound.",
          "demo-pr-a2",
          iso(t0 + 90_000),
          MODEL_FABLE,
        ),
        ...tool(
          "pr",
          3,
          "Edit",
          {
            file_path: "src/upload.ts",
            old_string: "for (let attempt = 0; attempt < max - 1; attempt++) {",
            new_string: "for (let attempt = 0; attempt < max; attempt++) {",
          },
          "Edited src/upload.ts",
          t0 + 110_000,
        ),
        ...tool(
          "pr",
          4,
          "Bash",
          { command: "bun test src/upload.test.ts --rerun-each 100" },
          "100 pass\n0 fail",
          t0 + 140_000,
        ),
        transcriptLineYouShouldKnow(
          youShouldKnowRecordContent(
            "Heads up",
            "Old upload failure logs say 3 attempts, but only 2 ever ran, so past failure counts overstate how hard uploads tried.",
            "**Old upload errors overstate the retries**\n\n" +
              "* The error reads `upload failed after 3 attempts` because it prints the retry setting, not a count of tries.\n" +
              "* Before this fix, only two attempts ran, so every one of those old errors gave up one try early.\n" +
              "* Anyone reading those logs would think a third try also failed, when it never ran.\n" +
              "* **Treat failure counts from before this fix as two-try numbers** when comparing against new ones.",
          ),
          "demo-pr-ysk1",
          iso(t0 + 145_000),
        ),
        transcriptLineAssistantText(
          "Fixed and verified — 100/100 green. The loop now honors the configured retry budget. I committed the change on `demo/fix-flaky-upload` and opened a PR with the regression note in the description.\n\n" +
            "Where the flakes were coming from, per attempt across the 50 reruns:\n\n" +
            "```vega-lite\n" +
            JSON.stringify({
              title: "Upload retries per attempt, 50 reruns",
              mark: "bar",
              data: {
                values: [
                  { attempt: "1st", build: "before", succeeded: 31 },
                  { attempt: "2nd", build: "before", succeeded: 18 },
                  { attempt: "3rd", build: "before", succeeded: 0 },
                  { attempt: "1st", build: "after", succeeded: 30 },
                  { attempt: "2nd", build: "after", succeeded: 17 },
                  { attempt: "3rd", build: "after", succeeded: 3 },
                ],
              },
              encoding: {
                x: { field: "attempt", type: "nominal", title: "Attempt" },
                xOffset: { field: "build", title: "Build" },
                y: {
                  field: "succeeded",
                  type: "quantitative",
                  title: "Runs that succeeded",
                },
                color: { field: "build", title: "Build" },
              },
            }) +
            "\n```",
          "demo-pr-a3",
          iso(t0 + 170_000),
          MODEL_FABLE,
        ),
        // Media in place: an image marker with a caption and a before/after
        // compare marker, rendered where they are written (docs/blocks.md).
        transcriptLineAssistantText(
          "Proof that the third attempt now runs. The retry timeline from the reruns, before and after the fix:\n\n" +
            `OPENSESSION_COMPARE: ${mediaDir}/retry-before.png ${mediaDir}/retry-after.png\n` +
            "Attempts per run: before on the left, after on the right\n\n" +
            `OPENSESSION_IMAGE: ${mediaDir}/retry-after.png\n` +
            "All three attempts run and the third one succeeds\n\n" +
            "Both stills come from the 100-run rerun above.",
          "demo-pr-a4",
          iso(t0 + 180_000),
          MODEL_FABLE,
        ),
        // Blocks that talk back to the session: a file tree whose rows open
        // the changed file, and quick replies that send as the next turn.
        transcriptLineAssistantText(
          "The fix touches these files:\n\n" +
            "```tree\n" +
            "acme-todo/\n" +
            "├── src/\n" +
            "│   ├── upload.ts  # retry loop\n" +
            "│   └── upload.test.ts\n" +
            "├── NOTES.md\n" +
            "└── package.json\n" +
            "```\n\n" +
            "How do you want to proceed?\n\n" +
            "```choices\n" +
            "- Merge the PR\n" +
            "- Add a test for the terminal error\n" +
            "- Explain the fix again\n" +
            "```",
          "demo-pr-a5",
          iso(t0 + 190_000),
          MODEL_FABLE,
        ),
      ],
    });
  }

  // 2. Failed session (lastRunError → "Needs input" lane + error banner).
  {
    const t0 = now - 300 * min;
    sessions.push({
      id: "bks-demo-failed",
      engineSessionId: "ses_demo02",
      file: base("bks-demo-failed", "ses_demo02", 300, 290, {
        title: "Investigate memory spike in export worker",
        createdBy: "Sam",
        mode: "ask",
        model: MODEL_SONNET,
        worktreeDir: repoDir,
        usage: usage(0.31, 9_400, 1_100, 2, iso(now - 290 * min)),
        lastRunError: {
          message:
            "Usage limit reached on every configured account — retry after the window resets",
          at: iso(now - 290 * min),
        },
      }),
      lines: [
        transcriptLineUser(
          "Export worker RSS climbs ~40MB/hour under steady load. Profile it and tell me where the growth is.",
          "demo-failed-u1",
          iso(t0),
        ),
        transcriptLineAssistantText(
          "Starting with a heap snapshot diff across two GC cycles.",
          "demo-failed-a1",
          iso(t0 + 15_000),
          MODEL_SONNET,
        ),
        ...tool(
          "failed",
          1,
          "Bash",
          { command: "bun run profile:heap --cycles 2" },
          "snapshot-1.heap written (84MB)\nsnapshot-2.heap written (121MB)",
          t0 + 30_000,
        ),
        transcriptLineRunnerNotice(
          "Run failed: usage limit reached on every configured account — retry after the window resets",
          "demo-failed-n1",
          iso(t0 + 60_000),
        ),
      ],
    });
  }

  // 3. Cancelled session (disk can only show the cancel notice; the stopped
  //    latch itself is in-memory by design — run-state.ts).
  {
    const t0 = now - 1_500 * min;
    sessions.push({
      id: "bks-demo-cancelled",
      engineSessionId: "ses_demo03",
      file: base("bks-demo-cancelled", "ses_demo03", 1_500, 1_495, {
        title: "Refactor date helpers into shared/",
        model: MODEL_CODEX,
        worktreeDir: repoDir,
        usage: usage(0.09, 3_100, 240, 1, iso(now - 1_495 * min)),
      }),
      lines: [
        transcriptLineUser(
          "Move the three date helpers from src/upload.ts into a shared/dates.ts module.",
          "demo-cancelled-u1",
          iso(t0),
        ),
        ...tool(
          "cancelled",
          1,
          "Grep",
          { pattern: "formatDate|parseDate", path: "src/" },
          "src/upload.ts:12\nsrc/upload.ts:31",
          t0 + 20_000,
        ),
        transcriptLineRunnerNotice(
          "Run cancelled by Alex",
          "demo-cancelled-n1",
          iso(t0 + 45_000),
        ),
      ],
    });
  }

  // 4. Long-transcript session: many turns, a compaction chip, and one
  //    oversized tool output (blob path in the transcript store).
  {
    const t0 = now - 2_900 * min;
    const lines: JsonlLine[] = [
      transcriptLineUser(
        "Migrate the settings storage from JSON files to SQLite, table by table, keeping the old reader as a fallback until every table is over.",
        "demo-long-u1",
        iso(t0),
      ),
    ];
    const tables = [
      "preferences",
      "shortcuts",
      "layouts",
      "filters",
      "themes",
      "drafts",
      "history",
      "labels",
      "snippets",
      "sync-state",
    ];
    tables.forEach((table, i) => {
      const at = t0 + (i + 1) * 4 * min;
      const n = i * 3;
      lines.push(
        transcriptLineAssistantText(
          `Migrating \`${table}\`: adding the table, dual-writing, then flipping the reader.`,
          `demo-long-a${i}`,
          iso(at),
          MODEL_FABLE,
        ),
        ...tool(
          "long",
          n + 1,
          "Read",
          { file_path: `src/settings/${table}.ts` },
          `// ${table} store — JSON-file backed\nexport function read${i}(): unknown { return null; }`,
          at + 30_000,
        ),
        ...tool(
          "long",
          n + 2,
          "Edit",
          {
            file_path: `src/settings/${table}.ts`,
            old_string: "…",
            new_string: "…",
          },
          `Edited src/settings/${table}.ts`,
          at + 60_000,
        ),
        ...tool(
          "long",
          n + 3,
          "Bash",
          { command: `bun test src/settings/${table}.test.ts` },
          "4 pass\n0 fail",
          at + 90_000,
        ),
      );
    });
    // Mid-session compaction chip.
    lines.splice(
      16,
      0,
      transcriptLineCompactionSummary(
        "Migrated preferences + shortcuts to SQLite with dual-write; remaining tables follow the same recipe. Reader flips are gated on a per-table env flag.",
        "demo-long-c1",
        iso(t0 + 20 * min),
      ),
    );
    // One very large tool output near the end.
    lines.push(
      ...tool(
        "long",
        99,
        "Bash",
        { command: "bun run migrate:verify --all --verbose" },
        bigToolOutput(),
        t0 + 50 * min,
      ),
      transcriptLineAssistantText(
        "All ten tables verified against the JSON snapshots — zero drift. The fallback reader can come out next week once the flag has soaked.",
        "demo-long-a-final",
        iso(t0 + 52 * min),
        MODEL_FABLE,
      ),
    );
    sessions.push({
      id: "bks-demo-long",
      engineSessionId: "ses_demo04",
      file: base("bks-demo-long", "ses_demo04", 2_900, 2_840, {
        title: "Migrate settings storage to SQLite",
        worktreeDir: repoDir,
        usage: usage(6.4, 148_000, 22_500, 34, iso(now - 2_840 * min)),
        modelHistory: [
          { model: MODEL_SONNET, at: iso(t0) },
          {
            model: MODEL_FABLE,
            from: MODEL_SONNET,
            at: iso(t0 + 10 * min),
            by: "Alex",
          },
        ],
      }),
      lines,
    });
  }

  // 5. Steered session: a joined steer turn that splits into two attributed
  //    bubbles (jsonl-parser ATTRIBUTED_JOIN_RE).
  {
    const t0 = now - 700 * min;
    sessions.push({
      id: "bks-demo-steered",
      engineSessionId: "ses_demo05",
      file: base("bks-demo-steered", "ses_demo05", 700, 680, {
        title: "Tighten retry backoff defaults",
        createdBy: "Sam",
        worktreeDir: repoDir,
        model: MODEL_SONNET,
        usage: usage(0.58, 15_200, 2_800, 4, iso(now - 680 * min)),
      }),
      lines: [
        transcriptLineUser(
          "Bump the default retry backoff from 100ms to 250ms and make it configurable.",
          "demo-steered-u1",
          iso(t0),
        ),
        ...tool(
          "steered",
          1,
          "Read",
          { file_path: "src/upload.ts" },
          DEMO_REPO_FILES["src/upload.ts"],
          t0 + 20_000,
        ),
        // Two steers released at one turn boundary arrive "\n\n"-joined with
        // per-sender attribution — the parser splits them back into bubbles.
        transcriptLineUser(
          "[Alex] Actually, name the option `retryBackoffMs`, not `backoff`\n\n[Sam] and please add it to the README's options table",
          "demo-steered-u2",
          iso(t0 + 60_000),
        ),
        transcriptLineAssistantText(
          "Renamed to `retryBackoffMs` and documented it in the README options table alongside `retries`. Pushed; CI takes a few minutes, so I scheduled a check-back instead of polling.",
          "demo-steered-a1",
          iso(t0 + 120_000),
          MODEL_SONNET,
        ),
        // A schedule_prompt check-back: delivered by the kernel timer in the
        // owner's name with the scheduled-prompt sentinel (scheduled-prompts.ts),
        // so the viewer shows it as the agent's own reminder, not Sam's words.
        transcriptLineUser(
          "[Sam (scheduled)] <!--os:scheduled-prompt:sched-demo-steered-1-->\nCheck-back on CI for the `retryBackoffMs` push. Run `gh pr checks --repo acme/acme-todo` for this branch. If everything passed, tell Sam in one line that the option is in and CI is green. If a check failed, read its log and fix the test, do not re-push blindly.",
          "demo-steered-u3",
          iso(t0 + 10 * min),
        ),
        ...tool(
          "steered",
          2,
          "Bash",
          { command: "gh pr checks --repo acme/acme-todo" },
          "6 pass\n0 pending\n0 fail",
          t0 + 10 * min + 15_000,
        ),
        transcriptLineAssistantText(
          "`retryBackoffMs` is in and CI is green (6 checks).",
          "demo-steered-a2",
          iso(t0 + 10 * min + 40_000),
          MODEL_SONNET,
        ),
      ],
    });
  }

  // 5b. A monitoring loop: the agent set a bounded loop with schedule_prompt's
  //     every_minutes, so each check is its own short turn whose answer is the
  //     update, and the banner shows the loop with a Stop button.
  {
    const t0 = now - 16 * min;
    const loop = {
      prompt:
        "Check the import queue depth with `bun scripts/queue-depth.ts`. Report the count and the trend since the last check. Once it is under 1,000, say so and stop the loop.",
      intervalMinutes: 5,
      until: iso(now + 104 * min),
      lastRunAt: iso(now - min),
      setBy: "Sam",
    };
    const tick = (n: number, at: number, depth: string, update: string) => [
      transcriptLineUser(
        `[Sam (loop)] ${loopTickMessage(loop.prompt, loopTickNote(loop))}`,
        `demo-monitor-u${n + 1}`,
        iso(at),
      ),
      ...tool(
        "monitor",
        n + 1,
        "Bash",
        { command: "bun scripts/queue-depth.ts" },
        depth,
        at + 10_000,
      ),
      transcriptLineAssistantText(
        update,
        `demo-monitor-a${n + 1}`,
        iso(at + 30_000),
        MODEL_SONNET,
      ),
    ];
    sessions.push({
      id: "bks-demo-monitor",
      engineSessionId: "ses_demo05b",
      file: base("bks-demo-monitor", "ses_demo05b", 16, 1, {
        title: "Watch the import queue drain",
        createdBy: "Sam",
        worktreeDir: repoDir,
        model: MODEL_SONNET,
        loop,
        usage: usage(0.21, 6_400, 1_100, 3, iso(now - min)),
      }),
      lines: [
        transcriptLineUser(
          "The import fix is deployed. Keep watching the queue and update me every 5 minutes until it is under 1,000.",
          "demo-monitor-u1",
          iso(t0),
        ),
        ...tool(
          "monitor",
          1,
          "schedule_prompt",
          { every_minutes: 5, for_minutes: 120, prompt: loop.prompt },
          `Loop set: ${describeLoop(loop)}. First run in 5m; /loop stop to end it.`,
          t0 + 20_000,
        ),
        transcriptLineAssistantText(
          "Watching it. The queue is at **48,210** now. I will check every 5 minutes for up to 2 hours and post each count here.",
          "demo-monitor-a1",
          iso(t0 + 40_000),
          MODEL_SONNET,
        ),
        ...tick(
          1,
          t0 + 5 * min,
          "import-queue 31,904",
          "**31,904**, down 16,306 in 5 minutes. At this rate it clears in about 10 minutes.",
        ),
        ...tick(
          2,
          t0 + 10 * min,
          "import-queue 14,377",
          "**14,377**, down 17,527. Still speeding up, no errors in the worker log.",
        ),
        ...tick(
          3,
          t0 + 15 * min,
          "import-queue 2,960",
          "**2,960**, down 11,417. One more check should put it under 1,000.",
        ),
      ],
    });
  }

  // 6. Waiting-on-question session. The card itself is in-memory only —
  //    startDemo() registers it via asks.offerAskCard; the transcript just
  //    sets the scene.
  {
    const t0 = now - 25 * min;
    sessions.push({
      id: DEMO_ASK_SESSION_ID,
      engineSessionId: DEMO_ASK_ENGINE_SESSION_ID,
      file: base(DEMO_ASK_SESSION_ID, DEMO_ASK_ENGINE_SESSION_ID, 25, 5, {
        title: "Choose an auth provider for acme-todo",
        mode: "ask",
        worktreeDir: repoDir,
        usage: usage(0.22, 8_100, 1_400, 2, iso(now - 5 * min)),
      }),
      lines: [
        transcriptLineUser(
          "We need login for acme-todo. Compare the obvious options and recommend one — but check with me before you settle on anything.",
          "demo-ask-u1",
          iso(t0),
        ),
        ...tool(
          "ask",
          1,
          "WebSearch",
          { query: "self-hosted auth provider comparison 2026" },
          "Compared: hosted OAuth broker vs self-hosted OIDC vs magic links. Trade-offs summarized.",
          t0 + 60_000,
        ),
        transcriptLineAssistantText(
          "Two candidates survive the constraints (self-hostable, no per-MAU pricing): a self-hosted OIDC server, or plain magic links with our own session store. I have a question for you before I write the plan.",
          "demo-ask-a1",
          iso(t0 + 4 * min),
          MODEL_FABLE,
        ),
      ],
    });
  }

  // 7. The live replayed session — no jsonl on disk; the replayer streams the
  //    transcript through the store/bus so watchers see it happen.
  sessions.push({
    id: DEMO_LIVE_SESSION_ID,
    engineSessionId: "",
    file: base(DEMO_LIVE_SESSION_ID, DEMO_LIVE_ENGINE_SESSION_ID, 8, 0, {
      title: "Instrument request tracing in api-gateway",
      worktreeDir: repoDir,
      usage: usage(0.12, 4_200, 800, 1, iso(now)),
    }),
    lines: [],
  });

  // 8. Automation-owned session (links to the seeded automation's run history).
  {
    const t0 = now - 900 * min;
    sessions.push({
      id: "bks-demo-automation-run",
      engineSessionId: "ses_demo07",
      file: base("bks-demo-automation-run", "ses_demo07", 900, 880, {
        title: "Nightly dependency audit — 2 advisories",
        createdBy: "Nightly dependency audit (automation)",
        mode: "ask",
        worktreeDir: repoDir,
        automation: "Nightly dependency audit",
        automationId: "auto-demo-nightly-audit",
        usage: usage(0.41, 11_900, 2_100, 3, iso(now - 880 * min)),
      }),
      lines: [
        transcriptLineUser(
          "Audit the dependency tree for new advisories since the last run; summarize anything actionable.",
          "demo-auto-u1",
          iso(t0),
        ),
        ...tool(
          "auto",
          1,
          "Bash",
          { command: "bun audit --json" },
          '{"advisories": 2, "moderate": 2, "high": 0, "critical": 0}',
          t0 + 30_000,
        ),
        transcriptLineAssistantText(
          "Two moderate advisories, both in dev-only tooling; neither is reachable from production code. Filed follow-up notes and pinned the affected ranges.",
          "demo-auto-a1",
          iso(t0 + 90_000),
          MODEL_FABLE,
        ),
      ],
    });
  }

  // 9. Quick ask-mode Q&A with a tool error (isError rendering).
  {
    const t0 = now - 60 * min;
    sessions.push({
      id: "bks-demo-scratch",
      engineSessionId: "ses_demo08",
      file: base("bks-demo-scratch", "ses_demo08", 60, 55, {
        title: "Why does the smoke test skip on CI?",
        mode: "ask",
        model: MODEL_CODEX,
        worktreeDir: repoDir,
        usage: usage(0.05, 2_300, 400, 1, iso(now - 55 * min)),
      }),
      lines: [
        transcriptLineUser(
          "Why does the smoke test get skipped on CI but run locally?",
          "demo-scratch-u1",
          iso(t0),
        ),
        ...tool(
          "scratch",
          1,
          "Bash",
          { command: "cat .ci/smoke.env" },
          "cat: .ci/smoke.env: No such file or directory",
          t0 + 20_000,
          true,
        ),
        ...tool(
          "scratch",
          2,
          "Grep",
          { pattern: "SMOKE_", path: ".github/" },
          '.github/workflows/ci.yml:41:  if: env.SMOKE_ENABLED == "1"',
          t0 + 40_000,
        ),
        transcriptLineAssistantText(
          "CI gates the smoke test on `SMOKE_ENABLED`, which is only exported by the (missing) `.ci/smoke.env`. Locally your shell profile sets it. Commit the env file or drop the gate.",
          "demo-scratch-a1",
          iso(t0 + 80_000),
          MODEL_CODEX,
        ),
      ],
    });
  }

  // 9. A PR that went through two handed-off review fix rounds and settled:
  //    the transcript folds the whole loop into one "Review loop" row and the
  //    closing wrap-up sits beneath it, so a reader coming back cold sees
  //    where the PR stands rather than the last round's report.
  {
    const t0 = now - 95 * min;
    const handoff = (round: number, quality: number, finding: string) =>
      `[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #131 “Upload progress callback” (branch \`demo/upload-progress\`) was just reviewed and is not merge-ready yet (verdict: request changes, quality ${quality}/5). You wrote this code, so the follow-through is yours — this is fix round ${round}/6.\n\nOpen review feedback (every reviewer; inline items carry a \`comment <id>\` for thread replies):\n${finding}\n\nDo this now, in this session's worktree:\n1. Sync the branch first: \`git pull origin demo/upload-progress\`.\n2. Address every actionable finding. If you disagree with one, leave the code unchanged and reply in that thread explaining why — never silently skip.\n3. Commit (stage specific files) and push: \`git push origin HEAD:demo/upload-progress\`.\n4. Reply in each addressed inline thread with what you did.\n5. NEVER merge the PR (\`gh pr merge\` is forbidden) and never force-push.\n\nThe review re-runs automatically after your push.`;
    sessions.push({
      id: "bks-demo-review",
      engineSessionId: "ses_demo09",
      file: base("bks-demo-review", "ses_demo09", 95, 40, {
        title: "Upload progress callback",
        branch: "demo/upload-progress",
        worktreeDir: repoDir,
        usage: usage(2.31, 51_800, 8_140, 12, iso(now - 40 * min)),
      }),
      lines: [
        transcriptLineUser(
          "Add a progress callback to the uploader so the UI can show a bar. Open a PR once it's green.",
          "demo-review-u1",
          iso(t0),
        ),
        transcriptLineAssistantText(
          "Adding an `onProgress` option to `upload()` and threading it through the retry loop.",
          "demo-review-a1",
          iso(t0 + 15_000),
          MODEL_FABLE,
        ),
        ...tool(
          "review",
          1,
          "Edit",
          {
            file_path: "src/upload.ts",
            old_string:
              "export async function upload(file: Blob, opts: UploadOptions) {",
            new_string:
              "export async function upload(file: Blob, opts: UploadOptions & { onProgress?: (sent: number) => void }) {",
          },
          "Edited src/upload.ts",
          t0 + 40_000,
        ),
        ...tool(
          "review",
          2,
          "Bash",
          { command: "bun test src/upload.test.ts" },
          "12 pass\n0 fail",
          t0 + 70_000,
        ),
        transcriptLineAssistantText(
          "Opened PR #131 with the progress callback. Tests pass; the review will run on the push.",
          "demo-review-a2",
          iso(t0 + 100_000),
          MODEL_FABLE,
        ),
        transcriptLineUser(
          handoff(
            1,
            3,
            "- [@acme-review[bot] · comment 9001] src/upload.ts:42 — 🔴 **P1** — `onProgress` reports the previous attempt's byte count after a failed attempt, so the bar jumps backwards on every retry.",
          ),
          "demo-review-u2",
          iso(t0 + 9 * min),
        ),
        transcriptLineAssistantText(
          "Resetting the reported byte count at the top of each attempt.",
          "demo-review-a3",
          iso(t0 + 9 * min + 20_000),
          MODEL_FABLE,
        ),
        ...tool(
          "review",
          3,
          "Edit",
          {
            file_path: "src/upload.ts",
            old_string: "  for (let attempt = 0; attempt < max; attempt++) {",
            new_string:
              "  for (let attempt = 0; attempt < max; attempt++) {\n    sent = 0;\n    opts.onProgress?.(sent);",
          },
          "Edited src/upload.ts",
          t0 + 9 * min + 40_000,
        ),
        ...tool(
          "review",
          4,
          "Bash",
          {
            command:
              "bun test src/upload.test.ts && git commit -qam 'upload: reset progress per attempt' && git push -q origin HEAD:demo/upload-progress",
          },
          "13 pass\n0 fail",
          t0 + 9 * min + 70_000,
        ),
        transcriptLineAssistantText(
          "Fix round 1 is addressed and pushed (`a1b2c3d`): the byte count resets at the start of every attempt, with a regression test for the retry path. Replied in the thread.",
          "demo-review-a4",
          iso(t0 + 9 * min + 100_000),
          MODEL_FABLE,
        ),
        transcriptLineRecap(
          "Fixed the backwards progress bar on retry and pushed; waiting for the re-review.",
          "demo-review-r1",
          iso(t0 + 12 * min),
        ),
        transcriptLineUser(
          handoff(
            2,
            4,
            "- [@acme-review[bot] · comment 9002] src/upload.ts:47 — 🟠 **P2** — The callback now fires on every 64 KiB chunk; a 2 GB upload calls it 32,000 times. Throttle it.",
          ),
          "demo-review-u3",
          iso(t0 + 20 * min),
        ),
        transcriptLineAssistantText(
          "Throttling progress events to one per 100 ms, with the final byte count always delivered.",
          "demo-review-a5",
          iso(t0 + 20 * min + 20_000),
          MODEL_FABLE,
        ),
        ...tool(
          "review",
          5,
          "Edit",
          {
            file_path: "src/upload.ts",
            old_string: "    opts.onProgress?.(sent);",
            new_string: "    reportProgress(sent);",
          },
          "Edited src/upload.ts",
          t0 + 20 * min + 40_000,
        ),
        ...tool(
          "review",
          6,
          "Bash",
          {
            command:
              "bun test src/upload.test.ts && git commit -qam 'upload: throttle progress events' && git push -q origin HEAD:demo/upload-progress",
          },
          "14 pass\n0 fail",
          t0 + 20 * min + 70_000,
        ),
        transcriptLineAssistantText(
          "Fix round 2 is addressed and pushed (`d4e5f6a`): progress events are throttled to one per 100 ms and the last one always carries the final size.",
          "demo-review-a6",
          iso(t0 + 20 * min + 100_000),
          MODEL_FABLE,
        ),
        transcriptLineUser(
          "[GitHub] <!--os:review-settled:passed-->\n✅ This session's PR #131 “Upload progress callback” (branch `demo/upload-progress`) passed review after 2 fix rounds, quality 5/5. The review loop is closed; no more findings are coming your way.\n\nWrite a short wrap-up for whoever comes back to this thread cold. Your earlier messages report each round; this one is the current state:\n1. Where things stand: review passed, CI (`gh pr checks 131 --repo acme/acme-todo`), and whether anything still blocks a merge.\n2. What changed across the fix rounds, in a few lines: the shape of the change, not a per-finding replay.\n3. Where to look: https://github.com/acme/acme-todo/pull/131, plus the preview URL if this branch has one.\n4. Anything a person still has to decide or do.\n\nKeep it short. Do not push new commits, re-run the review, or merge (`gh pr merge` is forbidden).",
          "demo-review-u4",
          iso(t0 + 50 * min),
        ),
        ...tool(
          "review",
          7,
          "Bash",
          { command: "gh pr checks 131 --repo acme/acme-todo" },
          "14 pass\n0 pending\n0 fail",
          t0 + 50 * min + 20_000,
        ),
        transcriptLineAssistantText(
          "**PR #131 is ready to merge.** Review passed after two fix rounds and CI is green (14 checks).\n\n**What changed:** `upload()` takes an `onProgress` callback. The count resets at the start of every retry attempt so the bar never runs backwards, and events are throttled to one per 100 ms with the final size always delivered.\n\n**Where to look:** https://github.com/acme/acme-todo/pull/131. Nothing is left for you to decide; merge when convenient.",
          "demo-review-a7",
          iso(t0 + 50 * min + 50_000),
          MODEL_FABLE,
        ),
      ],
    });
  }

  // 10. Waiting on CI after a push: the agent's own pr_checks waits woke it
  //     twice to say "still waiting", then a scheduled check-back found CI
  //     done. The transcript folds those self-started turns into one
  //     "Checked back" row and keeps only the last report visible.
  {
    const t0 = now - 70 * min;
    const wake = (n: number, at: number, trigger: string) =>
      transcriptLineContextInjection(
        `A durable background wait registered by the assistant has completed. This is system context, not a new user message.\n\nTrigger: ${trigger}\n\nContinue with: Inspect the PR checks.`,
        { source: "background-wait", turnId: `demo-ci-turn-${n}` },
        `demo-ci-w${n}`,
        iso(at),
      );
    sessions.push({
      id: "bks-demo-ci",
      engineSessionId: "ses_demo10",
      file: base("bks-demo-ci", "ses_demo10", 70, 20, {
        title: "Merge main into upload retries",
        branch: "demo/upload-retries",
        worktreeDir: repoDir,
        usage: usage(1.12, 28_400, 3_960, 6, iso(now - 20 * min)),
      }),
      lines: [
        transcriptLineUser(
          "Merge the latest main into this branch and get CI green.",
          "demo-ci-u1",
          iso(t0),
        ),
        ...tool(
          "ci",
          1,
          "Bash",
          {
            command:
              "git merge origin/main && bun test && git push origin HEAD:demo/upload-retries",
          },
          "Merge made by the 'ort' strategy.\n42 pass\n0 fail",
          t0 + 60_000,
        ),
        transcriptLineAssistantText(
          "Merged `main` and pushed. Tests pass locally; I'll be woken when CI on PR #133 finishes.",
          "demo-ci-a1",
          iso(t0 + 90_000),
          MODEL_FABLE,
        ),
        wake(
          1,
          t0 + 6 * min,
          "PR acme/acme-todo#133 has failing checks: approval gate.",
        ),
        ...tool(
          "ci",
          2,
          "Bash",
          { command: "gh pr checks 133 --repo acme/acme-todo" },
          "approval gate\taction_required\nunit tests\tpending\nbuild\tpending",
          t0 + 6 * min + 20_000,
        ),
        transcriptLineAssistantText(
          "The failing approval gate only needs a person to approve; nothing is broken. Unit tests and the build are still running.",
          "demo-ci-a2",
          iso(t0 + 6 * min + 40_000),
          MODEL_FABLE,
        ),
        wake(
          2,
          t0 + 8 * min,
          "PR acme/acme-todo#133 has failing checks: approval gate.",
        ),
        ...tool(
          "ci",
          3,
          "Bash",
          { command: "gh pr checks 133 --repo acme/acme-todo" },
          "approval gate\taction_required\nunit tests\tpending\nbuild\tpass",
          t0 + 8 * min + 20_000,
        ),
        transcriptLineAssistantText(
          "Still only the approval gate. Unit tests are running; I'll check back in 30 minutes.",
          "demo-ci-a3",
          iso(t0 + 8 * min + 40_000),
          MODEL_FABLE,
        ),
        transcriptLineUser(
          "[Open Session (scheduled)] <!--os:scheduled-prompt:sched-demo-ci-->\nCheck back on PR #133 and report the final CI result.",
          "demo-ci-u2",
          iso(t0 + 40 * min),
        ),
        ...tool(
          "ci",
          4,
          "Bash",
          { command: "gh pr checks 133 --repo acme/acme-todo" },
          "approval gate\taction_required\nunit tests\tpass\nbuild\tpass",
          t0 + 40 * min + 20_000,
        ),
        transcriptLineAssistantText(
          "**CI on PR #133 is green.** Unit tests and the build passed. The only open check is the approval gate, which needs someone to approve the PR; there is nothing left to fix.",
          "demo-ci-a4",
          iso(t0 + 40 * min + 50_000),
          MODEL_FABLE,
        ),
      ],
    });
  }

  // An HTML render: the agent checks a page with html_preview, then shows it
  // under the turn with html_render. The generator stores the page itself as
  // the session's asset (generate.ts).
  {
    const t0 = now - 32 * min;
    const htmlRender = {
      url: `/api/sessions/${DEMO_RENDER_SESSION_ID}/assets/raw/${DEMO_RENDER_ASSET}`,
      path: DEMO_RENDER_ASSET,
      title: DEMO_RENDER_TITLE,
      height: 360,
      heights: [
        [320, 570],
        [360, 598],
        [390, 618],
        [430, 645],
        [520, 690],
        [640, 320],
        [744, 359],
        [860, 384],
        [1000, 437],
        [1160, 497],
      ],
    };
    sessions.push({
      id: DEMO_RENDER_SESSION_ID,
      engineSessionId: "ses_demorender",
      file: base(DEMO_RENDER_SESSION_ID, "ses_demorender", 32, 29, {
        title: "Will the monitor arm clamp fit my desk?",
        mode: "ask",
        usage: usage(0.21, 9_840, 3_120, 3, iso(now - 29 * min)),
      }),
      lines: [
        transcriptLineUser(
          "I'm ordering a monitor arm with a C-clamp. Will it fit my desk? The top is 38 mm thick, there's a frame rail about 7 cm in from the back edge, and the monitor weighs 6.5 kg.",
          "demo-render-u1",
          iso(t0),
        ),
        transcriptLineAssistantText(
          "I'll check the clamp's specs against your desk and lay it out to scale.",
          "demo-render-a1",
          iso(t0 + 15_000),
          MODEL_FABLE,
        ),
        ...tool(
          "render",
          1,
          "mcp__opensession-html__html_preview",
          { html: MONITOR_FIT_PAGE, width: 744 },
          '{"width":744,"contentHeight":359,"capturedHeight":359}\nConsole: (empty)',
          t0 + 60_000,
        ),
        ...tool(
          "render",
          2,
          "mcp__opensession-html__html_render",
          { html: MONITOR_FIT_PAGE, title: DEMO_RENDER_TITLE, height: 360 },
          JSON.stringify({
            htmlRender,
            message:
              "Shown inline in the session. Do not link to it or describe where it is.",
          }),
          t0 + 90_000,
        ),
        transcriptLineAssistantText(
          "Yes, it fits. 38 mm is mid-range for the 10–85 mm clamp, and the 70 mm of flat edge in front of the rail clears the 60 mm lower pad, so the pad sits fully on the desk. 6.5 kg is inside the arm's 2–9 kg spring. If the rail turns out closer than 6 cm, use the reinforcement plate that comes with the arm.",
          "demo-render-a2",
          iso(t0 + 120_000),
          MODEL_FABLE,
        ),
        transcriptLineUser(
          "What do I need to check under the desk before it arrives?",
          "demo-render-u2",
          iso(t0 + 150_000),
        ),
        // A static ```artifact fence: no script, sized to its document, in
        // the app's theme variables.
        transcriptLineAssistantText(
          [
            "Three measurements, all from the back edge:",
            "",
            "```artifact",
            '<table style="width:100%;border-collapse:collapse;font-size:14px">',
            '<tr style="color:var(--muted-foreground);text-align:left"><th style="padding:8px 0">Check</th><th>Need</th><th>Yours</th></tr>',
            '<tr style="border-top:1px solid var(--border)"><td style="padding:8px 0">Desk thickness</td><td>10–85 mm</td><td style="color:var(--success)">38 mm</td></tr>',
            '<tr style="border-top:1px solid var(--border)"><td style="padding:8px 0">Flat edge before the rail</td><td>60 mm</td><td style="color:var(--success)">70 mm</td></tr>',
            '<tr style="border-top:1px solid var(--border)"><td style="padding:8px 0">Gap behind the desk</td><td>25 mm</td><td style="color:var(--warning)">measure</td></tr>',
            "</table>",
            "```",
            "",
            "The last one is the clamp's spine: the desk needs 25 mm free behind it, so pull it off the wall a little if it sits flush.",
          ].join("\n"),
          "demo-render-a3",
          iso(t0 + 170_000),
          MODEL_FABLE,
        ),
      ],
    });
  }

  // The same render reached from a codemode script through mcp_call: the
  // result is the script's report around the tool's answer, not the answer
  // alone. The turn ends on a screenshot marker.
  {
    const t0 = now - 26 * min;
    const htmlRender = {
      url: `/api/sessions/${DEMO_SCRIPT_RENDER_SESSION_ID}/assets/raw/${DEMO_RENDER_ASSET}`,
      path: DEMO_RENDER_ASSET,
      title: DEMO_RENDER_TITLE,
      height: 360,
      heights: [
        [320, 570],
        [390, 618],
        [744, 359],
        [1160, 497],
      ],
    };
    const script = [
      "const r = await tools.mcp_call({",
      '  name: "opensession-html_html_render",',
      `  arguments: { title: ${JSON.stringify(DEMO_RENDER_TITLE)}, height: 360, html },`,
      "});",
      "return JSON.parse(r);",
    ].join("\n");
    sessions.push({
      id: DEMO_SCRIPT_RENDER_SESSION_ID,
      engineSessionId: "ses_demorenderscript",
      file: base(
        DEMO_SCRIPT_RENDER_SESSION_ID,
        "ses_demorenderscript",
        26,
        24,
        {
          title: "Show the clamp fit from a script",
          mode: "ask",
          usage: usage(0.12, 6_210, 1_980, 2, iso(now - 24 * min)),
        },
      ),
      lines: [
        transcriptLineUser(
          "Lay out the clamp fit to scale, and send me a screenshot too.",
          "demo-rscript-u1",
          iso(t0),
        ),
        ...tool(
          "rscript",
          1,
          "codemode",
          { code: script },
          [
            "Script completed",
            "Wall time 1.8 seconds",
            "Output:",
            JSON.stringify({
              htmlRender,
              message:
                "Shown inline in the session. Do not link to it or describe where it is.",
            }),
            "Console: (empty)",
          ].join("\n"),
          t0 + 60_000,
        ),
        transcriptLineAssistantText(
          "Here is the fit to scale, and the screenshot you asked for:\n\n" +
            `OPENSESSION_IMAGE: ${mediaDir}/retry-after.png\n` +
            "The clamp at your desk's 38 mm\n\n" +
            "The pad sits fully on the desk in front of the rail.",
          "demo-rscript-a1",
          iso(t0 + 90_000),
          MODEL_FABLE,
        ),
      ],
    });
  }

  return sessions;
}

// ── Ask card ────────────────────────────────────────────────────────────────

export function demoAskQuestions() {
  return [
    {
      question: "Which auth approach should acme-todo ship first?",
      header: "Auth provider",
      options: [
        {
          label: "Self-hosted OIDC",
          description:
            "Full control, more ops surface — needs a keyholder rotation story",
        },
        {
          label: "Magic links",
          description:
            "Smallest build, no passwords — email deliverability becomes critical-path",
        },
      ],
      multiSelect: false,
    },
  ];
}

// ── The replayed "running" session's script ─────────────────────────────────

/** One batch of claude-shape lines per step, timestamped at call time so the
 *  stream reads live. Ids are stable per step: each loop starts with an
 *  authoritative replace, so re-appending the same ids is safe. */
export function demoReplayScript(): Array<() => JsonlLine[]> {
  const t = () => new Date().toISOString();
  const step =
    (
      n: number,
      name: string,
      input: unknown,
      output: string,
      isError?: boolean,
    ) =>
    (): JsonlLine[] => {
      const id = `demo-live-t${n}`;
      return [
        transcriptLineToolUse(id, name, input, t()),
        transcriptLineToolResult(id, output, isError, t()),
      ];
    };
  const say = (id: string, text: string) => (): JsonlLine[] => [
    transcriptLineAssistantText(text, id, t(), MODEL_FABLE),
  ];

  return [
    (): JsonlLine[] => [
      transcriptLineUser(
        "Add OpenTelemetry spans around every api-gateway route handler, with the route id as the span name. Start with the hot paths.",
        "demo-live-u1",
        t(),
      ),
    ],
    say(
      "demo-live-a1",
      "Plan: find the route registration choke point, wrap it once instead of editing 40 handlers, then verify a trace end-to-end.",
    ),
    step(
      1,
      "Grep",
      { pattern: "registerRoute\\(", path: "src/gateway/" },
      "src/gateway/router.ts:88\nsrc/gateway/router.ts:132",
    ),
    step(
      2,
      "Read",
      { file_path: "src/gateway/router.ts" },
      "export function registerRoute(id: string, handler: Handler) {\n  routes.set(id, handler);\n}",
    ),
    say(
      "demo-live-a2",
      "`registerRoute` is the single choke point — wrapping the handler there instruments every route at once.",
    ),
    step(
      3,
      "Edit",
      {
        file_path: "src/gateway/router.ts",
        old_string: "routes.set(id, handler);",
        new_string: "routes.set(id, traced(id, handler));",
      },
      "Edited src/gateway/router.ts",
    ),
    step(
      4,
      "Write",
      { file_path: "src/gateway/tracing.ts" },
      "Created src/gateway/tracing.ts (traced() span wrapper, 31 lines)",
    ),
    step(5, "Bash", { command: "bun test src/gateway/" }, "18 pass\n0 fail"),
    step(
      6,
      "Bash",
      { command: "bun run gateway:dev --smoke /health" },
      "error: OTEL_EXPORTER_OTLP_ENDPOINT is not set",
      true,
    ),
    say(
      "demo-live-a3",
      "The smoke run needs an exporter endpoint — defaulting to the console exporter when OTLP is unconfigured, so local dev traces still show up.",
    ),
    step(
      7,
      "Edit",
      {
        file_path: "src/gateway/tracing.ts",
        old_string: "new OTLPTraceExporter()",
        new_string:
          "exporterFromEnv() // OTLP when configured, console otherwise",
      },
      "Edited src/gateway/tracing.ts",
    ),
    step(
      8,
      "Bash",
      { command: "bun run gateway:dev --smoke /health" },
      "span api-gateway:/health 3.1ms ok\nsmoke passed",
    ),
    // A sessions MCP call: the row links to the session it names.
    step(
      9,
      "opensession-sessions_get_session",
      { id: "bks-demo-pr", transcript_lines: 4 },
      '🟢 *Fix flaky upload retry test*  `bks-demo-pr`\n   done · opensession · code · branch demo/fix-flaky-upload · createdBy="Alex" · 2h ago\n   PR open https://github.com/acme/acme-todo/pull/128\n\n*Recent transcript:*\n• tool:Bash: Using bash\n• tool_result: 100 pass 0 fail\n• assistant: Fixed and verified — 100/100 green.',
    ),
    // A suggested task: the agent proposes a follow-up it will not start, and
    // the turn renders it as a card with "Start session".
    step(
      10,
      "opensession-sessions_suggest_task",
      {
        title: "Tag gateway spans with the tenant id",
        description:
          "Every route span now exists but none carries the tenant, so a trace cannot be filtered per customer. Add the attribute where the middleware already resolves the tenant, and cover it with one test.",
        instructions:
          "In src/gateway/router.ts the registerRoute wrapper opens a span per route. Read the tenant id from the request context that src/gateway/tenant.ts resolves in middleware and set it as the `tenant.id` span attribute. Keep the wrapper the single instrumentation point; do not touch individual handlers. Add a test in src/gateway/tracing.test.ts asserting the attribute is present on a /health span. Report the files changed and the test output.",
        repo: "acme-todo",
        mode: "code",
      },
      'Suggested task recorded: "Tag gateway spans with the tenant id". It appears as a card in this session with a "Start session" button; nothing runs until a person presses it.',
    ),
    say(
      "demo-live-a4",
      "Traces verified end-to-end on the hot paths. I left a suggested task for tagging spans with the tenant id; the sampler config is the other follow-up.",
    ),
  ];
}

// ── Stores beyond the session dir ──────────────────────────────────────────────

/** Open issues for the Issues page. One already has the live demo session
 *  so the list shows a running row; the others are still waiting. */
export function demoIssues(now: number) {
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000);
  const issue = (
    number: number,
    title: string,
    body: string,
    opts: {
      hoursAgo: number;
      author: string;
      labels?: string[];
      comments?: number;
      sessionId?: string;
    },
  ) => ({
    repo: DEMO_REPO_ID,
    ghRepo: DEMO_GH_REPO,
    number,
    title,
    url: `https://github.com/${DEMO_GH_REPO}/issues/${number}`,
    body,
    author: opts.author,
    person: null,
    labels: opts.labels ?? [],
    assignees: [],
    comments: opts.comments ?? 0,
    createdAt: at(opts.hoursAgo + 6).toISOString(),
    updatedAt: at(opts.hoursAgo).toISOString(),
    sessionId: opts.sessionId ?? `bks-ghpr-${number}-issue`,
    assigned: (opts.labels ?? []).includes("os"),
  });
  return [
    issue(
      131,
      "Upload retries stall after the third attempt",
      "Large uploads that fail three times stop retrying and the progress bar sits at 92% until the tab is reloaded.\n\n**Steps**\n\n1. Throttle the network to Slow 3G\n2. Upload a 40 MB file\n3. Watch the retry counter\n\nExpected: the upload resumes or reports the failure.",
      {
        hoursAgo: 1,
        author: "kent",
        labels: ["bug", "os"],
        comments: 3,
        sessionId: DEMO_LIVE_SESSION_ID,
      },
    ),
    issue(
      129,
      "Add keyboard shortcut for archiving a todo",
      "`e` should archive the focused todo, matching the shortcut sheet in Settings.",
      { hoursAgo: 9, author: "maya", labels: ["enhancement"], comments: 1 },
    ),
    issue(
      124,
      "Dark mode: due-date chips lose contrast",
      "The amber due-date chip on a dark background is 2.9:1. Needs the tokenized amber, not the raw hex.",
      { hoursAgo: 30, author: "kent", labels: ["design"] },
    ),
    issue(118, "Document the export format", "", {
      hoursAgo: 80,
      author: "sam",
      labels: ["docs"],
      comments: 4,
    }),
  ];
}

export function demoAutomations(now: number) {
  const iso8 = (agoMin: number) => iso(now - agoMin * 60_000);
  return [
    {
      id: "auto-demo-nightly-audit",
      name: "Nightly dependency audit",
      prompt:
        "Audit the dependency tree for new advisories since the last run. Summarize anything actionable in your note; open no PRs.",
      // Deliberately disabled: a live scheduler must never turn demo data
      // into real engine runs. The run history below still renders.
      schedule: "0 3 * * *",
      enabled: false,
      mode: "ask" as const,
      createdBy: "Alex",
      createdAt: iso8(20_000),
      webhookSecret: "demo-not-a-secret",
      lastRunAt: iso8(900),
      lastRunSessionId: "bks-demo-automation-run",
      lastRunStatus: "ok" as const,
      runs: [
        {
          at: iso8(900),
          sessionId: "bks-demo-automation-run",
          trigger: "cron" as const,
          status: "ok" as const,
          durationMs: 184_000,
        },
        {
          at: iso8(2_340),
          sessionId: "bks-demo-automation-run",
          trigger: "manual" as const,
          status: "ok" as const,
          durationMs: 161_000,
        },
        {
          at: iso8(3_780),
          sessionId: "bks-demo-automation-run",
          trigger: "cron" as const,
          status: "error" as const,
          error: "engine start timed out",
          durationMs: 45_000,
        },
      ],
    },
    {
      id: "auto-demo-deploy-note",
      name: "Deploy notes on release webhook",
      prompt:
        "A release webhook fired. Read the release payload, summarize user-facing changes in two sentences, and file the summary as a note.",
      // Webhook-triggered (empty schedule): safe to leave enabled — nothing
      // posts demo webhooks.
      schedule: "",
      enabled: true,
      mode: "ask" as const,
      createdBy: "Sam",
      createdAt: iso8(10_000),
      webhookSecret: "demo-not-a-secret-either",
      lastRunAt: iso8(4_200),
      lastRunStatus: "ok" as const,
      runs: [
        {
          at: iso8(4_200),
          trigger: "webhook" as const,
          status: "ok" as const,
          durationMs: 92_000,
        },
      ],
    },
  ];
}

export function demoGoal(now: number, goalsDir: string) {
  const id = "goal-demo-flake-burndown";
  return {
    goal: {
      id,
      name: "Flaky-test burndown",
      mission:
        "Each wake: pick the flakiest test on CI, reproduce it, and either fix it or file a precise repro note. Stop when the flake rate is under 0.1%.",
      // Paused + far-future wake, belt and braces: the goal ticker must never
      // wake demo data into a real engine run.
      status: "paused" as const,
      pauseReason: "Demo dataset — never runs",
      mode: "ask" as const,
      nextWakeAt: "2099-01-01T00:00:00.000Z",
      minWakeMinutes: 240,
      wakeCount: 2,
      lastRunAt: iso(now - 3_000 * 60_000),
      lastRunStatus: "ok",
      stateFile: `${goalsDir}/${id}.ledger.md`,
      createdBy: "Alex",
      createdAt: iso(now - 6_000 * 60_000),
    },
    ledger: [
      "# Ledger — Flaky-test burndown",
      "",
      `## ${iso(now - 4_400 * 60_000)}`,
      "",
      "Baseline measured: 14 tests above 1% flake rate. Top offender:",
      "upload retry test (2.6%). Queued it first.",
      "",
      `## ${iso(now - 3_000 * 60_000)}`,
      "",
      "Upload retry flake root-caused to an off-by-one retry bound; fix",
      "landed via the fix-flaky-upload session. 13 to go.",
      "",
    ].join("\n"),
  };
}

/** One audit day-file's lines, spanning the main event kinds the viewer knows
 *  (significant + NOISY_KINDS — audit.ts / routes/system.ts). */
export function demoAuditLines(now: number): Array<Record<string, unknown>> {
  const at = (agoMin: number) => iso(now - agoMin * 60_000);
  const turn = (
    agoMin: number,
    kind: string,
    extra: Record<string, unknown>,
  ) => ({
    time: at(agoMin),
    service: "opensession",
    msg: "claude_turn_event",
    provider: "pi",
    turn_id: "demo-turn-1",
    run_key: "ses_demo01",
    session_id: "bks-demo-pr",
    run_kind: "prompt",
    mode: "code",
    claude_session_id: "ses_demo01",
    model: MODEL_FABLE,
    kind,
    ...extra,
  });
  return [
    {
      time: at(180),
      service: "opensession",
      msg: "user_prompt",
      session_id: "bks-demo-pr",
      user: "Alex",
      text_bytes: 143,
    },
    turn(178, "tool_use", {
      direction: "out",
      tool_name: "Bash",
      tool_use_id: "demo-pr-t1",
      text_sha256: "0000demo",
      text_bytes: 52,
    }),
    turn(177, "tool_result", {
      direction: "in",
      tool_name: "Bash",
      tool_use_id: "demo-pr-t1",
      is_error: false,
      text_sha256: "0001demo",
      text_bytes: 130,
    }),
    {
      time: at(176),
      service: "opensession",
      msg: "assistant_text",
      session_id: "bks-demo-pr",
      model: MODEL_FABLE,
      text_bytes: 210,
    },
    {
      time: at(175),
      service: "opensession",
      msg: "permission_decision",
      session_id: "bks-demo-pr",
      tool_name: "Edit",
      decision: "allow",
      rule: "worktree-write",
    },
    {
      time: at(172),
      service: "opensession",
      msg: "result",
      session_id: "bks-demo-pr",
      outcome: "success",
      duration_ms: 412_000,
      turns: 9,
    },
    {
      time: at(60),
      service: "opensession",
      msg: "run_state_transition",
      session_id: "bks-demo-scratch",
      from: "running",
      to: "idle",
      event: "turn_end",
    },
  ];
}

// ── PR caches ───────────────────────────────────────────────────────────────

export function demoPrInfo(now: number, ghRepo: string, sessionId: string) {
  const url = `https://github.com/${ghRepo || "acme/acme-todo"}/pull/${DEMO_PR_NUMBER}`;
  return {
    url,
    state: "OPEN" as const,
    number: DEMO_PR_NUMBER,
    title: "Fix flaky upload retry (off-by-one in retry bound)",
    isDraft: false,
    additions: 9,
    deletions: 3,
    changedFiles: 2,
    reviewDecision: "APPROVED",
    author: "acme-demo-bot",
    createdAt: iso(now - 160 * 60_000),
    updatedAt: iso(now - 40 * 60_000),
    checks: { total: 5, passed: 5, failed: 0, pending: 0 },
    headRefOid: "demo0000000000000000000000000000000000d1",
    mergeable: "MERGEABLE",
    reviewRequested: [],
    reviewedBy: [],
    assignees: ["acme-demo-bot"],
    sessionRef: sessionId,
  };
}

export function demoPrDetails(now: number, ghRepo: string) {
  const info = demoPrInfo(now, ghRepo, "bks-demo-pr");
  return {
    number: info.number,
    title: info.title,
    url: info.url,
    state: "OPEN" as const,
    isDraft: false,
    baseRefName: "main",
    headRefName: DEMO_BRANCH,
    headRefOid: info.headRefOid,
    additions: info.additions,
    deletions: info.deletions,
    changedFiles: info.changedFiles,
    reviewDecision: "APPROVED",
    author: "acme-demo-bot",
    body: [
      "The retry loop ran `attempt < max - 1`, skipping the final attempt and",
      "flaking under packet loss (~1 in 40 CI runs).",
      "",
      "- Fix the bound (`< max`)",
      "- Verified with `--rerun-each 100`: 100/100 green",
    ].join("\n"),
    checks: [
      {
        name: "test",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "CI",
      },
      {
        name: "typecheck",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "CI",
      },
      {
        name: "lint",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "CI",
      },
      {
        name: "build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "CI",
      },
      {
        name: "smoke",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "CI",
      },
    ],
    comments: [
      {
        author: "sam-reviews",
        body: "Nice catch — worth a comment on the loop bound so the off-by-one can't sneak back in.",
        createdAt: iso(now - 90 * 60_000),
      },
    ],
    commits: [
      {
        oid: info.headRefOid,
        messageHeadline: "fix: honor the full retry budget in uploadChunk",
        author: "acme-demo-bot",
      },
    ],
    files: [
      { path: "src/upload.ts", additions: 4, deletions: 3 },
      { path: "src/upload.test.ts", additions: 5, deletions: 0 },
    ],
    reviewers: [{ login: "sam-reviews", state: "APPROVED" as const }],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    staging: null,
  };
}

/**
 * The PR's unified patch, exactly as `gh pr diff` would return it — the Review
 * page's "Files changed" tab renders GitHub's patch, not the local worktree
 * diff, so without this the demo review page shows "GitHub's pull request API
 * is unavailable right now". Line numbers match DEMO_REPO_FILES, and the
 * +9/-3 across two files matches demoPrInfo's counts.
 */
export function demoPrPatch(): string {
  return [
    "diff --git a/src/upload.ts b/src/upload.ts",
    "index 7c0f1a2..9b3d4e5 100644",
    "--- a/src/upload.ts",
    "+++ b/src/upload.ts",
    "@@ -7,8 +7,7 @@ export async function uploadChunk(",
    "   opts: UploadOpts = {},",
    " ): Promise<void> {",
    "   const max = opts.retries ?? 3;",
    "-  // BUG: `<` skips the final attempt — flaky under packet loss.",
    "-  for (let attempt = 0; attempt < max - 1; attempt++) {",
    "+  for (let attempt = 0; attempt < max; attempt++) {",
    "     if (await tryPut(chunk)) return;",
    "   }",
    "   throw new Error(`upload failed after ${max} attempts`);",
    "diff --git a/src/upload.test.ts b/src/upload.test.ts",
    "index 2a1b3c4..5d6e7f8 100644",
    "--- a/src/upload.test.ts",
    "+++ b/src/upload.test.ts",
    '@@ -3,4 +3,11 @@ import { uploadChunk } from "./upload";',
    " ",
    ' it("retries up to the configured limit", async () => {',
    "   await uploadChunk(new Uint8Array(8), { retries: 3 });",
    "-});",
    "+});",
    "+",
    '+it("uses the full retry budget (regression: off-by-one)", async () => {',
    "+  let calls = 0;",
    "+  fakePut(() => ++calls === 3);",
    "+  await uploadChunk(new Uint8Array(8), { retries: 3 });",
    "+  expect(calls).toBe(3);",
    "+});",
    "",
  ].join("\n");
}

/** Shape of pr-info's diff cache entry for the demo PR. */
export function demoPrDiff(now: number, ghRepo: string) {
  return {
    number: DEMO_PR_NUMBER,
    headRefOid: demoPrInfo(now, ghRepo, "bks-demo-pr").headRefOid,
    patch: demoPrPatch(),
  };
}
