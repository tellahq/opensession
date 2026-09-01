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
  transcriptLineRunnerNotice,
  transcriptLineToolResult,
  transcriptLineToolUse,
  transcriptLineUser,
} from "../transcript-persistence";
import type { NativeSessionFile } from "../types";

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

const MODEL_FABLE = "pi/anthropic/claude-fable-5-1";
const MODEL_SONNET = "pi/anthropic/claude-sonnet-5";
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
}): DemoSessionFixture[] {
  const { now, worktreeDir, repoDir } = opts;
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
        transcriptLineAssistantText(
          "Fixed and verified — 100/100 green. The loop now honors the configured retry budget. I committed the change on `demo/fix-flaky-upload` and opened a PR with the regression note in the description.",
          "demo-pr-a3",
          iso(t0 + 170_000),
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
          "Renamed to `retryBackoffMs` and documented it in the README options table alongside `retries`.",
          "demo-steered-a1",
          iso(t0 + 120_000),
          MODEL_SONNET,
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
    say(
      "demo-live-a4",
      "Traces verified end-to-end on the hot paths. Next loop: tag spans with tenant id and wire the sampler config.",
    ),
  ];
}

// ── Stores beyond the session dir ──────────────────────────────────────────────

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
