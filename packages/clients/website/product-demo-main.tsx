import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type {
  TranscriptEntry,
  UnifiedSession,
} from "../../core/opensession-server/src/frontend/lib/types";
import openSessionMarkAsset from "../mac/build/icon-512.png";
import tellaMarkAsset from "../../core/opensession-server/src/frontend/tella-icon.png";
import { assetUrl } from "./asset-url";

const openSessionMark = assetUrl(openSessionMarkAsset);
const tellaMark = assetUrl(tellaMarkAsset);

/**
 * Fixture clocks are relative to page load, not fixed dates: a hard-coded
 * `runStartedAt` made the sidebar's live ticker read "195h 12m" a week after
 * the fixtures were written.
 */
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const now = minutesAgo(0);
const activeSessionId = "bks-demo-presence";
const deskSessionId = "bks-demo-desk";
/** Optional capture-only state used by scripts/capture-announcement-features.ts.
 *  The ordinary landing demo has no query string and keeps its current state. */
const featureShot = new URLSearchParams(location.search).get("feature");
const sessionsShot = featureShot === "sessions";
const demoRepo = sessionsShot ? "tella-fusion" : "opensession";
const organizationMark = sessionsShot ? tellaMark : openSessionMark;

const sessions: UnifiedSession[] = [
  {
    id: activeSessionId,
    claudeSessionId: "demo-presence",
    source: "opensession",
    branch: sessionsShot
      ? "kent/system-audio-waveform"
      : "kent/workspace-presence",
    worktreeDir: sessionsShot
      ? "/workspace/tella-fusion"
      : "/workspace/opensession",
    startedBy: "Grant",
    title: sessionsShot
      ? "Strengthen system audio waveform visibility"
      : "Add multiplayer workspace presence",
    lastActivity: minutesAgo(4),
    createdAt: minutesAgo(38),
    isRunning: false,
    transcriptPath: "/demo/transcript.jsonl",
    mode: "code",
    repo: demoRepo,
    workspaceId: "project-presence",
    model: "anthropic/claude-fable-5-1",
    effort: "medium",
    ...(sessionsShot
      ? {
          prUrl: "https://github.com/tellahq/tella-fusion/pull/5750",
          prState: "OPEN" as const,
          prNumber: 5750,
          prTitle: "Strengthen system audio waveform visibility",
          prMergeable: "MERGEABLE",
          prChecks: { total: 49, passed: 49, failed: 0, pending: 0 },
          prReviewDecision: "APPROVED",
        }
      : {}),
    ...(featureShot === "walkthroughs"
      ? {
          walkthrough: {
            summary:
              "## What changed\n\nWorkspace presence is now visible at a glance. The sidebar rolls everyone viewing a session into a compact facepile, while the session header shows who is collaborating with you.",
            shots: [
              {
                before: "/demo/workspace-presence-before.webp",
                after: "/demo/workspace-presence-after.webp",
                caption: "Workspace presence in the sidebar and session header",
              },
            ],
            publishedAt: minutesAgo(3),
            publishedBy: "Kent",
            publishedEntryId: "entry-14",
          },
        }
      : {}),
    usage: {
      costUsd: 0.6,
      inputTokens: 18420,
      outputTokens: 3290,
      cacheReadTokens: 12600,
      cacheCreationTokens: 0,
      contextTokens: 23110,
      contextWindow: 200000,
      turns: 4,
      updatedAt: now,
    },
  },
  {
    id: "bks-demo-checkout",
    claudeSessionId: "demo-checkout",
    source: "opensession",
    branch: "kent/checkout-recovery",
    worktreeDir: "/workspace/checkout",
    startedBy: "Grant",
    title: "Review checkout recovery",
    lastActivity: minutesAgo(1),
    createdAt: minutesAgo(52),
    isRunning: true,
    runStartedAt: minutesAgo(2),
    transcriptPath: "/demo/checkout.jsonl",
    mode: "code",
    repo: demoRepo,
    workspaceId: "project-checkout",
    model: "anthropic/claude-opus-5",
  },
  {
    id: "bks-demo-mobile",
    claudeSessionId: "demo-mobile",
    source: "opensession",
    branch: "kent/mobile-navigation",
    worktreeDir: "/workspace/mobile",
    startedBy: "Grant",
    title: "Improve mobile navigation",
    lastActivity: minutesAgo(9),
    createdAt: minutesAgo(74),
    isRunning: false,
    transcriptPath: "/demo/mobile.jsonl",
    mode: "code",
    repo: demoRepo,
    workspaceId: "project-mobile",
    model: "anthropic/claude-sonnet-5",
    waitingForInput: true,
  },
  {
    id: "bks-demo-shortcuts",
    claudeSessionId: "demo-shortcuts",
    source: "opensession",
    branch: "kent/keyboard-shortcuts",
    worktreeDir: "/workspace/shortcuts",
    startedBy: "Grant",
    title: "Ship keyboard shortcuts",
    lastActivity: minutesAgo(21),
    createdAt: minutesAgo(96),
    isRunning: false,
    transcriptPath: "/demo/shortcuts.jsonl",
    mode: "code",
    repo: demoRepo,
    workspaceId: "project-shortcuts",
    model: "anthropic/claude-fable-5-1",
    prUrl: "https://github.com/tellahq/opensession/pull/1842",
    prState: "OPEN",
    prNumber: 1842,
    prTitle: "Ship keyboard shortcuts",
    prChecks: { total: 8, passed: 8, failed: 0, pending: 0 },
    prReviewDecision: "APPROVED",
  },
  {
    id: "bks-demo-search",
    claudeSessionId: "demo-search",
    source: "opensession",
    branch: "kent/faster-session-search",
    worktreeDir: "/workspace/search",
    startedBy: "Grant",
    title: "Make session search instant",
    lastActivity: minutesAgo(1),
    createdAt: minutesAgo(129),
    isRunning: true,
    runStartedAt: minutesAgo(5),
    transcriptPath: "/demo/search.jsonl",
    mode: "code",
    repo: demoRepo,
    workspaceId: "project-search",
    model: "anthropic/claude-opus-5",
  },
  {
    id: "bks-demo-release",
    claudeSessionId: "demo-release",
    source: "opensession",
    branch: "kent/release-notes",
    worktreeDir: "/workspace/release",
    startedBy: "Grant",
    title: "Draft the weekly release notes",
    lastActivity: minutesAgo(47),
    createdAt: minutesAgo(163),
    isRunning: false,
    transcriptPath: "/demo/release.jsonl",
    mode: "ask",
    repo: demoRepo,
    workspaceId: "project-release",
    model: "anthropic/claude-fable-5-1",
  },
  ...(
    [
      [
        "import-csv",
        "Import contacts from a CSV",
        63,
        214,
        "anthropic/claude-opus-5",
      ],
      [
        "billing-webhooks",
        "Retry failed billing webhooks",
        88,
        240,
        "openai/gpt-5.6-sol",
      ],
      [
        "onboarding-empty",
        "Rewrite the onboarding empty states",
        104,
        268,
        "anthropic/claude-sonnet-5",
      ],
      [
        "flaky-e2e",
        "Track down the flaky end-to-end test",
        132,
        310,
        "anthropic/claude-opus-5",
      ],
      [
        "audit-log",
        "Add an audit log to settings",
        176,
        384,
        "openai/gpt-5.6-terra",
      ],
      [
        "image-uploads",
        "Speed up image uploads",
        214,
        430,
        "anthropic/claude-sonnet-5",
      ],
      [
        "dark-mode-charts",
        "Fix chart colours in dark mode",
        268,
        502,
        "openai/gpt-5.6-sol",
      ],
      [
        "stale-invites",
        "Expire stale team invites",
        322,
        590,
        "anthropic/claude-opus-5",
      ],
      [
        "search-ranking",
        "Tune search ranking for short queries",
        358,
        640,
        "openai/gpt-5.6-sol",
      ],
      [
        "mobile-keyboard",
        "Stop the keyboard covering the composer",
        402,
        705,
        "anthropic/claude-sonnet-5",
      ],
      [
        "seat-billing",
        "Prorate seats when a teammate leaves",
        448,
        760,
        "anthropic/claude-opus-5",
      ],
      [
        "slow-migration",
        "Split the slow migration into batches",
        512,
        828,
        "openai/gpt-5.6-terra",
      ],
      [
        "sso-errors",
        "Explain SSO errors in plain language",
        566,
        902,
        "anthropic/claude-sonnet-5",
      ],
      [
        "webhook-docs",
        "Document the webhook payloads",
        624,
        980,
        "openai/gpt-5.6-sol",
      ],
      [
        "retry-backoff",
        "Back off retries after a rate limit",
        690,
        1050,
        "anthropic/claude-opus-5",
      ],
      [
        "export-csv",
        "Export a workspace to CSV",
        754,
        1128,
        "openai/gpt-5.6-sol",
      ],
    ] as const
  ).map(([slug, title, activeMinutes, createdMinutes, model]) => ({
    id: `bks-demo-${slug}`,
    claudeSessionId: `demo-${slug}`,
    source: "opensession" as const,
    branch: `kent/${slug}`,
    worktreeDir: `/workspace/${slug}`,
    startedBy: "Grant",
    title,
    lastActivity: minutesAgo(activeMinutes),
    createdAt: minutesAgo(createdMinutes),
    isRunning: false,
    transcriptPath: `/demo/${slug}.jsonl`,
    mode: "code" as const,
    repo: demoRepo,
    workspaceId: `project-${slug}`,
    model,
  })),
];

/**
 * What the team shipped, for the feed. The demo's repo is a shared checkout,
 * which in the product ships straight to the default branch rather than
 * through pull requests, so this is commits: one row per shipped thing, from
 * five different people over three days, which is the window the feed opens
 * on.
 *
 * Titles are deliberately not the sidebar's: those are work in flight, and a
 * session that is still open has not shipped anything yet.
 */
const shippedCommits = (
  [
    [
      "louise",
      "Louise de Sadeleer",
      "Keep the composer draft when a session switches",
      96,
      31,
      25,
    ],
    [
      "jaap",
      "Jaap Frolich",
      "Batch transcript writes behind one flush",
      240,
      118,
      96,
    ],
    [
      "kent",
      "Kent de Bruin",
      "Cache repo icons so the sidebar stops flashing",
      58,
      12,
      187,
    ],
    [
      "michiel",
      "Michiel Westerbeek",
      "Give the run banner a real elapsed clock",
      64,
      22,
      291,
    ],
    [
      "grant",
      "Grant Shaddick",
      "Sign preview links with a short-lived token",
      148,
      57,
      448,
    ],
    [
      "michiel",
      "Michiel Westerbeek",
      "Round the session rows to match the panel",
      41,
      38,
      1495,
    ],
    [
      "louise",
      "Louise de Sadeleer",
      "Show who else is reading a session",
      203,
      64,
      1602,
    ],
    [
      "kent",
      "Kent de Bruin",
      "Stop the sidebar jumping to the top on rename",
      27,
      9,
      1744,
    ],
    [
      "jaap",
      "Jaap Frolich",
      "Move the diff parser off the main thread",
      312,
      140,
      1860,
    ],
    [
      "grant",
      "Grant Shaddick",
      "Add a health check to the deploy workflow",
      72,
      5,
      1938,
    ],
    [
      "louise",
      "Louise de Sadeleer",
      "Name the model in the composer footer",
      33,
      11,
      2905,
    ],
    [
      "jaap",
      "Jaap Frolich",
      "Drop the duplicate presence broadcast",
      18,
      96,
      3050,
    ],
    [
      "kent",
      "Kent de Bruin",
      "Write the archive filter into the URL",
      88,
      26,
      3180,
    ],
    [
      "michiel",
      "Michiel Westerbeek",
      "Tighten the empty state on the reviews page",
      52,
      18,
      3295,
    ],
  ] as const
).map(([person, author, title, additions, deletions, minutes], index) => ({
  repo: demoRepo,
  // Only the first seven characters are ever shown, but the row is keyed on
  // the whole thing, so they have to differ past that.
  sha: `${(0xc0ffee + index * 0x9e3779b).toString(16).padStart(7, "0")}${"a3f7b21c9d40e85f6a1b2c3d4e5f6071".slice(index)}`,
  title,
  author,
  person,
  committedAt: minutesAgo(minutes),
  additions,
  deletions,
}));

/** Rows carrying activity you have not looked at yet: bold, in the product's
 *  own unread weight. */
const unreadSessionIds = new Set([
  "bks-demo-checkout",
  "bks-demo-search",
  "bks-demo-import-csv",
  "bks-demo-billing-webhooks",
  "bks-demo-flaky-e2e",
]);

const demoPresence = [
  { user: "Kent", sessionId: activeSessionId },
  { user: "Michiel", sessionId: activeSessionId },
  { user: "Jaap", sessionId: activeSessionId },
  { user: "Louise", sessionId: "bks-demo-checkout" },
];

const automations = [
  {
    id: "review-stale-prs",
    name: "Review stale pull requests",
    prompt:
      "Review pull requests with no activity for three days. Summarize blockers, request the right reviewer, and publish a report with anything that needs attention.",
    schedule: "0 9 * * 1-5",
    mode: "ask",
    enabled: true,
    createdBy: "Kent",
    createdAt: minutesAgo(18_400),
    lastRunAt: minutesAgo(42),
    lastRunSessionId: "bks-demo-release",
    lastRunStatus: "ok",
    lastTrigger: "cron",
    nextRunAt: minutesAgo(-1_080),
    model: "anthropic/claude-fable-5-1",
    runs: [1, 2, 3, 4, 5, 7, 8].map((days) => ({
      at: minutesAgo(days * 1_440),
      sessionId: `demo-pr-review-${days}`,
      trigger: "cron",
      status: "ok",
      durationMs: 184_000,
    })),
  },
  {
    id: "support-patterns",
    name: "Find patterns in support",
    prompt:
      "Analyze this week's support conversations. Group recurring requests, note changes in sentiment, and publish the strongest product signals.",
    schedule: "0 8 * * 1",
    mode: "ask",
    enabled: true,
    createdBy: "Louise",
    createdAt: minutesAgo(42_000),
    lastRunAt: minutesAgo(1_520),
    lastRunSessionId: "bks-demo-search",
    lastRunStatus: "ok",
    lastTrigger: "cron",
    nextRunAt: minutesAgo(-8_640),
    model: "anthropic/claude-opus-5",
    runs: [2, 9, 16, 23].map((days) => ({
      at: minutesAgo(days * 1_440),
      sessionId: `demo-support-patterns-${days}`,
      trigger: "cron",
      status: "ok",
      durationMs: 312_000,
    })),
  },
  {
    id: "security-monitor",
    name: "Monitor security advisories",
    prompt:
      "Check our dependencies and infrastructure providers for new security advisories. Open a code session for actionable fixes.",
    schedule: "0 */6 * * *",
    mode: "code",
    enabled: true,
    createdBy: "Grant",
    createdAt: minutesAgo(61_000),
    lastRunAt: minutesAgo(96),
    lastRunSessionId: "bks-demo-audit-log",
    lastRunStatus: "running",
    lastTrigger: "cron",
    nextRunAt: minutesAgo(-264),
    isRunning: true,
    model: "anthropic/claude-fable-5-1",
    runs: [1, 3, 4, 6, 7].map((days, index) => ({
      at: minutesAgo(days * 1_440),
      sessionId: `demo-security-${days}`,
      trigger: "cron",
      status: index === 0 ? "running" : "ok",
      durationMs: 228_000,
    })),
  },
  {
    id: "product-docs",
    name: "Keep product docs current",
    prompt:
      "Compare recently shipped changes with product documentation. Update anything stale and open a pull request with the edits.",
    schedule: "0 16 * * 5",
    mode: "code",
    enabled: true,
    createdBy: "Michiel",
    createdAt: minutesAgo(72_000),
    lastRunAt: minutesAgo(4_380),
    lastRunSessionId: "bks-demo-webhook-docs",
    lastRunStatus: "ok",
    lastTrigger: "cron",
    nextRunAt: minutesAgo(-4_260),
    model: "anthropic/claude-opus-5",
    runs: [3, 10, 17, 24].map((days) => ({
      at: minutesAgo(days * 1_440),
      sessionId: `demo-product-docs-${days}`,
      trigger: "cron",
      status: "ok",
      durationMs: 402_000,
    })),
  },
];

const transcripts: Record<string, TranscriptEntry[]> = {
  [deskSessionId]: [
    {
      id: "desk-entry-1",
      type: "user",
      content: "What’s being worked on right now?",
      timestamp: minutesAgo(8),
      seq: 1,
      changeSeq: 1,
    },
    {
      id: "desk-entry-2",
      type: "assistant",
      content:
        "Three things need your attention:\n\n- **Review checkout recovery** is still running.\n- **Improve mobile navigation** is waiting for your input.\n- **Ship keyboard shortcuts** passed every check and is ready to review.\n\nI can follow up on any of these or start a new session for you.",
      timestamp: minutesAgo(7),
      model: "anthropic/claude-fable-5-1",
      seq: 2,
      changeSeq: 2,
    },
  ],
  [activeSessionId]: [
    {
      id: "entry-1",
      type: "user",
      content:
        "Add multiplayer presence to project workspaces. Have a focused agent cover the tests, then open a pull request.",
      timestamp: minutesAgo(38),
      seq: 1,
      changeSeq: 1,
    },
    {
      id: "entry-2",
      type: "assistant",
      content:
        "I found the existing presence channel and workspace header. I’m wiring those together while a focused worker adds coverage.",
      timestamp: minutesAgo(37),
      model: "anthropic/claude-fable-5-1",
      seq: 2,
      changeSeq: 2,
    },
    {
      id: "entry-3",
      type: "tool_use",
      content: "",
      timestamp: minutesAgo(37),
      toolName: "functions.task",
      toolInput: {
        description: "Add presence coverage",
        prompt: "Add focused tests for workspace presence.",
        subagent_type: "worker",
      },
      toolUseId: "tool-1",
      seq: 3,
      changeSeq: 3,
    },
    {
      id: "entry-4",
      type: "tool_result",
      content: "Presence tests added. 16 tests pass.",
      timestamp: minutesAgo(35),
      toolName: "functions.task",
      toolUseId: "tool-1",
      agentId: "agent-demo-tests",
      seq: 4,
      changeSeq: 4,
    },
    {
      id: "entry-5",
      type: "tool_use",
      content: "",
      timestamp: minutesAgo(34),
      toolName: "read",
      toolInput: { filePath: "/workspace/opensession/src/server/ws-hub.ts" },
      toolUseId: "tool-2",
      seq: 5,
      changeSeq: 5,
    },
    {
      id: "entry-6",
      type: "tool_result",
      content:
        "Read 412 lines. Presence is broadcast per session; workspaces have no channel of their own yet.",
      timestamp: minutesAgo(34),
      toolName: "read",
      toolUseId: "tool-2",
      seq: 6,
      changeSeq: 6,
    },
    {
      id: "entry-7",
      type: "assistant",
      content:
        "A workspace is just the sessions inside it, so presence can fold up rather than get its own channel. I'll roll each session's viewers into the workspace row and de-duplicate whoever is in two at once.",
      timestamp: minutesAgo(33),
      model: "anthropic/claude-fable-5-1",
      seq: 7,
      changeSeq: 7,
    },
    {
      id: "entry-8",
      type: "tool_use",
      content: "",
      timestamp: minutesAgo(31),
      toolName: "edit",
      toolInput: {
        filePath: "/workspace/opensession/src/frontend/components/Sidebar.tsx",
        oldString: "const viewers = sessionViewers(row.sessions[0]);",
        newString:
          "const viewers = workspaceViewers(row.sessions, currentUser);",
      },
      toolUseId: "tool-3",
      seq: 8,
      changeSeq: 8,
    },
    {
      id: "entry-9",
      type: "tool_result",
      content: "Edited Sidebar.tsx: 1 replacement.",
      timestamp: minutesAgo(31),
      toolName: "edit",
      toolUseId: "tool-3",
      seq: 9,
      changeSeq: 9,
    },
    {
      id: "entry-10",
      type: "user",
      content:
        "Overlap the faces when more than one person is in the same workspace.",
      timestamp: minutesAgo(28),
      seq: 10,
      changeSeq: 10,
    },
    {
      id: "entry-11",
      type: "assistant",
      content:
        "Done. The face on top carries a 2px ring in the row's own colour, so the pile reads as a stack on every row state instead of a row of separate avatars.",
      timestamp: minutesAgo(26),
      model: "anthropic/claude-fable-5-1",
      seq: 11,
      changeSeq: 11,
    },
    {
      id: "entry-12",
      type: "tool_use",
      content: "",
      timestamp: minutesAgo(22),
      toolName: "bash",
      toolInput: {
        command: "bun test src/frontend/components/Sidebar.test.tsx",
      },
      toolUseId: "tool-4",
      seq: 12,
      changeSeq: 12,
    },
    {
      id: "entry-13",
      type: "tool_result",
      content: "34 pass, 0 fail. Ran 34 tests across 1 file. [1.42s]",
      timestamp: minutesAgo(21),
      toolName: "bash",
      toolUseId: "tool-4",
      seq: 13,
      changeSeq: 13,
    },
    {
      id: "entry-14",
      type: "assistant",
      content:
        "Presence now appears in every shared workspace, and the pull request is up.\n\n- **Sidebar** rolls each session's viewers into the workspace row, deduplicated\n- **Faces overlap** with a ring in the row's colour, so a stack stays legible on hover and selection\n- **Tests** cover the roll-up and the self-suppression rule\n\nThe phone layout uses the same facepile, with a separate touch target so every teammate stays easy to open.\n\nPull request #1842 is ready for review.",
      timestamp: minutesAgo(4),
      model: "anthropic/claude-fable-5-1",
      seq: 14,
      changeSeq: 14,
    },
  ],
};

if (sessionsShot) {
  transcripts[activeSessionId] = [
    {
      id: "session-shot-1",
      type: "user",
      content:
        "Explore a few treatments for muted system audio. Keep removed audio quiet, but make the selected waveform easy to spot in light and dark mode.",
      timestamp: minutesAgo(24),
      seq: 1,
      changeSeq: 1,
    },
    {
      id: "session-shot-2",
      type: "assistant",
      content:
        "I compared four treatments against the existing cut-audio state. Darker teal keeps the selection distinct without making removed audio look active.",
      images: ["/demo/audio-waveform-options.svg"],
      timestamp: minutesAgo(12),
      model: "anthropic/claude-fable-5-1",
      seq: 2,
      changeSeq: 2,
    },
    {
      id: "session-shot-3",
      type: "assistant",
      content:
        "Shipped the darker teal treatment. All 49 checks pass, the automated review found no issues, and pull request #5750 is ready to merge.",
      timestamp: minutesAgo(4),
      model: "anthropic/claude-fable-5-1",
      seq: 3,
      changeSeq: 3,
    },
  ];
}

for (const session of sessions.slice(1)) {
  transcripts[session.id] = [
    {
      id: `${session.id}-1`,
      type: "user",
      content: `Take ownership of “${session.title}” and leave the work ready for review.`,
      timestamp: session.createdAt,
      seq: 1,
      changeSeq: 1,
    },
    {
      id: `${session.id}-2`,
      type: "assistant",
      content:
        "I’ve mapped the relevant code paths and started the focused implementation. The current state is visible in the workspace panel.",
      timestamp: session.lastActivity,
      model: session.model,
      seq: 2,
      changeSeq: 2,
    },
  ];
}

const projects = sessions.map((session, index) => ({
  id: session.workspaceId!,
  name: session.title.replace(/^(Add|Review|Improve|Ship) /, ""),
  repo: demoRepo,
  createdBy: session.startedBy || "Grant",
  createdAt: session.createdAt,
  order: index,
}));

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });

const responseFor = (url: URL, method: string): Response => {
  const path = url.pathname.replace(/^\/(opensession|backstage)/, "");
  if (path === "/api/sessions")
    return json(sessions, { headers: { ETag: '"demo-v1"' } });
  if (path === "/api/desk/ensure" && method === "POST")
    return json({
      sessionId: deskSessionId,
      clearedAt: null,
      session: { model: "anthropic/claude-fable-5-1", effort: "low" },
    });
  if (path === "/api/auth/status")
    return json({
      required: false,
      authenticated: true,
      local: true,
      name: "Grant Shaddick",
      organizationName: sessionsShot ? "Tella" : "Open Session",
    });
  if (path === "/api/people")
    return json({
      people: [
        { name: "Kent", fullName: "Kent de Bruin", github: "kentdebruin" },
        {
          name: "Michiel",
          fullName: "Michiel Westerbeek",
          github: "happylinks",
        },
        { name: "Jaap", fullName: "Jaap Frolich", github: "jfrolich" },
        { name: "Grant", fullName: "Grant Shaddick", github: "9ranty" },
        {
          name: "Louise",
          fullName: "Louise de Sadeleer",
          github: "louisedesadeleer",
        },
      ],
    });
  if (path === "/api/projects") return json({ projects });
  if (path === "/api/repos")
    return json({
      repos: [
        {
          id: demoRepo,
          label: sessionsShot ? "tella-fusion" : "Open Session",
          ghRepo: sessionsShot ? "tellahq/tella-fusion" : "tellahq/opensession",
          defaultBranch: "main",
          sharedCheckout: !sessionsShot,
          default: true,
        },
      ],
    });
  if (path === "/api/models")
    return json({
      default: "anthropic/claude-fable-5-1",
      models: [
        {
          id: "anthropic/claude-fable-5-1",
          provider: "pi",
          label: "Claude Fable 5.1",
          aliases: [],
          efforts: ["medium", "high"],
        },
        {
          id: "anthropic/claude-opus-5",
          provider: "pi",
          label: "Claude Opus 5",
          aliases: [],
          efforts: ["high"],
        },
      ],
    });
  if (path === "/api/open-prs") return json({ prs: [] });
  // The feed reads both: merged pull requests, and commits from repos that
  // ship without them. This one is the second kind.
  if (path === "/api/recent-prs") return json({ prs: [] });
  if (path === "/api/recent-commits")
    return json({ commits: shippedCommits, days: 3, hasMore: false });
  if (path === "/api/feeds") return json({ feeds: [] });
  if (path === "/api/todos") return json({ todos: [] });
  if (path === "/api/pins") return json({ pins: [] });
  // The demo account is an established teammate, not a first-run one: without
  // this the readiness check fails and Home replaces itself with the
  // onboarding card.
  if (path === "/api/onboarding/status")
    return json({
      hasOwnSessions: true,
      admin: false,
      preparedRepo: {
        id: demoRepo,
        label: sessionsShot ? "tella-fusion" : "Open Session",
        defaultBranch: "main",
      },
      capabilities: {
        task: { ready: true, blocker: null },
        changes: { ready: true, blocker: null },
      },
    });
  if (sessionsShot && /^\/api\/sessions\/[^/]+\/pr$/.test(path))
    return json({
      number: 5750,
      title: "Strengthen system audio waveform visibility",
      url: "https://github.com/tellahq/tella-fusion/pull/5750",
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "kent/system-audio-waveform",
      headRefOid: "b94d41d3f2a",
      additions: 132,
      deletions: 63,
      changedFiles: 3,
      reviewDecision: "APPROVED",
      author: "kentdebruin",
      body: "Makes muted system audio easier to distinguish across themes.",
      checks: Array.from({ length: 49 }, (_, index) => ({
        name: `Check ${index + 1}`,
        status: "COMPLETED",
        conclusion: "SUCCESS",
      })),
      comments: [],
      commits: [
        {
          oid: "b94d41d3f2a",
          messageHeadline: "Strengthen system audio waveform visibility",
          author: "Kent de Bruin",
          authoredDate: minutesAgo(8),
        },
      ],
      files: [
        { path: "src/editor/audio/Waveform.tsx", additions: 68, deletions: 31 },
        { path: "src/editor/audio/colors.ts", additions: 42, deletions: 22 },
        {
          path: "src/editor/audio/Waveform.test.tsx",
          additions: 22,
          deletions: 10,
        },
      ],
      reviewers: [],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      osReview: {
        verdict: "approve",
        confidence: 5,
        findings: 0,
        blocking: 0,
        stale: false,
        at: minutesAgo(5),
      },
    });
  if (sessionsShot && /^\/api\/sessions\/[^/]+\/git-status$/.test(path))
    return json({
      branch: "kent/system-audio-waveform",
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      behindBase: 0,
      baseBranch: "main",
      uncommittedFiles: 0,
      sharedCheckout: false,
    });
  if (sessionsShot && /^\/api\/workspaces\/[^/]+\/overview$/.test(path))
    return json({
      prompt: {
        content: transcripts[activeSessionId][0]?.content || "",
        sessionId: activeSessionId,
        at: transcripts[activeSessionId][0]?.timestamp,
      },
      lastMessage: {
        content: transcripts[activeSessionId][2]?.content || "",
        sessionId: activeSessionId,
        at: transcripts[activeSessionId][2]?.timestamp,
      },
      media: [],
      commits: [
        {
          sha: "b94d41d3f2a",
          title: "Strengthen system audio waveform visibility",
          filesChanged: 3,
          additions: 132,
          deletions: 63,
        },
      ],
    });
  if (path === "/api/ui-prefs") return json({ prefs: {} });
  if (path === "/api/lanes") return json({ lanes: {} });
  if (path === "/api/reads") return json({ reads: {} });
  if (path === "/api/automations") return json(automations);
  if (
    path === "/api/claude-accounts" ||
    path === "/api/codex-accounts" ||
    path === "/api/xai-accounts"
  )
    return json({ accounts: [] });
  if (/^\/api\/sessions\/[^/]+\/assets$/.test(path))
    return json({ dir: "/demo/assets", files: [] });
  if (/^\/api\/sessions\/[^/]+\/reports$/.test(path))
    return json({ reports: [] });
  if (/^\/api\/sessions\/[^/]+\/workflows$/.test(path))
    return json({ runs: [] });
  if (/^\/api\/sessions\/[^/]+\/subagents$/.test(path))
    return json({
      subagents: path.includes(activeSessionId)
        ? [
            {
              id: "agent-demo-tests",
              toolUseId: "tool-1",
              agentType: "worker",
              label: "Add presence coverage",
              status: "done",
              startedAt: Date.parse(minutesAgo(37)),
              endedAt: Date.parse(minutesAgo(35)),
              model: "anthropic/claude-sonnet-5",
              tokensOut: 1840,
              source: "pi",
            },
            {
              id: "agent-demo-review",
              agentType: "oracle",
              label: "Review the implementation",
              status: "running",
              startedAt: Date.parse(minutesAgo(35)),
              model: "anthropic/claude-fable-5-1",
              source: "pi",
            },
          ]
        : [],
      sessionRunning: path.includes(activeSessionId),
    });
  if (method !== "GET") return json({ ok: true });
  return json({ error: `No demo fixture for ${path}` }, { status: 404 });
};

(window as typeof window & { fetch: typeof fetch }).fetch = (async (
  input,
  init,
) => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin || !url.pathname.includes("/api/")) {
    throw new Error(
      `The product preview blocked a network request to ${url.href}`,
    );
  }
  return responseFor(
    url,
    init?.method || (input instanceof Request ? input.method : "GET"),
  );
}) as typeof fetch;

class DemoWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = DemoWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(_url: string | URL) {
    super();
    queueMicrotask(() => {
      this.readyState = DemoWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  private emit(body: unknown, delay = 0) {
    window.setTimeout(() => {
      this.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify(body) }),
      );
    }, delay);
  }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.type === "ping") {
      this.emit({ type: "pong" });
      return;
    }
    if (message.type === "watch") {
      const entries = transcripts[message.sessionId] || [];
      // The fixture serves one complete, in-memory transcript. Legacy mode is
      // intentional here: seq mode also requires a separately paged transcript
      // index, which would add machinery without making this small demo richer.
      this.emit({
        type: "transcript_init",
        sessionId: message.sessionId,
        entries,
        truncated: false,
      });
      this.emit(
        {
          type: "presence",
          sessionId: message.sessionId,
          viewers: ["Kent", "Michiel", "Jaap"],
        },
        80,
      );
      return;
    }
    if (message.type === "prompt") {
      const timestamp = new Date().toISOString();
      const userEntry: TranscriptEntry = {
        id: `demo-user-${Date.now()}`,
        type: "user",
        content: message.content,
        timestamp,
      };
      const assistantEntry: TranscriptEntry = {
        id: `demo-assistant-${Date.now()}`,
        type: "assistant",
        content:
          "This is a deterministic product preview, so the real coding agent is not contacted. In Open Session, this prompt would start a live run here.",
        timestamp,
        model: "anthropic/claude-fable-5-1",
      };
      this.emit({
        type: "transcript_append",
        sessionId: message.sessionId,
        entries: [userEntry],
      });
      this.emit(
        {
          type: "session_status",
          sessionId: message.sessionId,
          isRunning: true,
        },
        60,
      );
      this.emit(
        { type: "stream_start", sessionId: message.sessionId, by: "Grant" },
        120,
      );
      this.emit(
        {
          type: "stream_text",
          sessionId: message.sessionId,
          text: assistantEntry.content,
        },
        260,
      );
      this.emit(
        {
          type: "transcript_append",
          sessionId: message.sessionId,
          entries: [assistantEntry],
        },
        900,
      );
      this.emit({ type: "stream_done", sessionId: message.sessionId }, 920);
      this.emit(
        {
          type: "session_status",
          sessionId: message.sessionId,
          isRunning: false,
        },
        940,
      );
    }
  }

  close() {
    this.readyState = DemoWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
}

Object.defineProperty(window, "WebSocket", {
  value: DemoWebSocket,
  configurable: true,
});
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = DemoEventSource.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(_url: string | URL) {
    super();
  }

  close() {}
}
Object.defineProperty(window, "EventSource", {
  value: DemoEventSource,
  configurable: true,
});
Object.assign(window, {
  __OPENSESSION_DEMO__: true,
  __OPENSESSION_INSTANCE__: {
    productName: sessionsShot ? "Tella" : "Open Session",
    productMark: sessionsShot ? "T" : "OS",
    // The composer's placeholder reads "Ask <persona>", so the demo's agent is
    // named for what a visitor should type rather than for a character nobody
    // on the page has been introduced to.
    personaName: "your agent",
    defaultRepoId: demoRepo,
  },
});
// Render the Mac desktop shell: `wco` is the window-controls-overlay state the
// Electron app runs in, so the sidebar's first row becomes the titlebar and
// clears space for the traffic lights that product-demo.html draws.
document.documentElement.dataset.platform = "mac";
document.documentElement.classList.add("wco");

localStorage.setItem("opensession-user", "Grant");
localStorage.setItem("opensession-last-session", activeSessionId);
// The restore is per-user: without the matching owner the demo opens Home
// instead of the session it was written to show.
localStorage.setItem("opensession-last-session-user", "Grant");
localStorage.setItem("opensession-panel-open", "false");
// The workspace summary card is open by default in the product, and it paints
// over the transcript for the frames before the header is measured. That flash
// is what a screenshot catches, so the demo starts with the card put away.
localStorage.setItem(
  "opensession-workspace-summary-open",
  sessionsShot ? "true" : "false",
);
localStorage.setItem("opensession-panel-tab", "workflows");
localStorage.setItem("opensession-sidebar-collapsed", "0");
localStorage.setItem("opensession-sidebar-w", "300");
if (featureShot === "automations") {
  // The capture route is state inside the fixture app. Keeping the query string
  // lets a screenshot identify why it differs from the ordinary landing demo.
  history.replaceState(null, "", "/automations?feature=automations");
}
// One repo, so the sidebar resolves its "auto" grouping to the plain inbox
// straight away instead of painting repo bands until /api/repos answers.
localStorage.setItem("opensession-repo-count", "1");
// Read marks, so a few rows carry the unread weight. A row only counts as
// unread once it HAS a mark that its activity has since passed, so every other
// session is marked at its own last activity rather than left unmarked.
localStorage.setItem(
  "opensession-reads:grant",
  JSON.stringify(
    Object.fromEntries(
      sessions.map((session) => [
        session.id,
        unreadSessionIds.has(session.id)
          ? minutesAgo(600)
          : session.lastActivity,
      ]),
    ),
  ),
);
localStorage.setItem(
  "opensession-sidebar-hidden-tools",
  JSON.stringify([
    "tasks",
    "reports",
    "catchup",
    "supporttinder",
    "analytics",
    "desk",
  ]),
);

// Two marks the app asks the server for and this page has to answer itself:
// the repo icon, and the phone top bar's app icon, which was rendering as a
// broken-image tile for every visitor narrow enough to get the phone layout.
//
// Matched on `*=` rather than `$=`: the app cache-busts that icon
// (`/mac-app-icon.png?v=7` in useOrganizationIcon.ts), and a suffix match
// cannot see past a query string, so the tile silently came back broken the
// day the `?v=` was added. Anything ending in the file name still matches.
const repoMarkObserver = new MutationObserver(() => {
  if (sessionsShot) {
    for (const label of document.querySelectorAll("span")) {
      if (label.textContent?.trim() === "Open Session")
        label.textContent = "Tella";
    }
  }
  for (const image of document.querySelectorAll<HTMLImageElement>(
    `img[src*="/repo-icon/${demoRepo}.png"], img[src*="/mac-app-icon.png"]`,
  )) {
    if (image.src !== new URL(organizationMark, location.href).href) {
      image.src = organizationMark;
    }
  }
});
repoMarkObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// A preview is a picture you can touch, not the product with an empty database
// behind it. These controls all reach somewhere the fixtures cannot follow, so
// they stay where they are, because they are part of what the product looks
// like, and do nothing:
//
//   Settings      a real page, and a dead end with no account to configure
//   Dictate       asks the visitor's own browser for a microphone
//   Archived      a real page with nothing archived to show
//   A pull request chip  routes through a workspace the fixture never defines,
//                        so it lands on "Workspace not found"
//
// Captured on the way down so it beats the app's own handler, and on click
// rather than pointer-events so a keyboard Enter is covered too. Worth walking
// again whenever the app grows a surface the demo has no data for.
const inertInDemo = [
  '[aria-label="Open settings"]',
  '[aria-label="Dictate"]',
  '[title="View archived sessions"]',
  'a[href^="/pr/"]',
].join(", ");

document.addEventListener(
  "click",
  (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest?.(inertInDemo)) return;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);

const [{ App }, { TooltipProvider }] = await Promise.all([
  import("../../core/opensession-server/src/frontend/App"),
  import("../../core/opensession-server/src/frontend/ui/tooltip"),
]);

function ProductDemoApp() {
  useEffect(() => {
    window.requestAnimationFrame(() => {
      window.parent.postMessage(
        { type: "opensession-demo-ready" },
        window.location.origin,
      );
    });
  }, []);

  return (
    <TooltipProvider>
      <App serviceWorker={false} initialTeamViewing={demoPresence} />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<ProductDemoApp />);
