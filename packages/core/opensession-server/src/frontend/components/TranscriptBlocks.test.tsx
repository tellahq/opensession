import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../lib/types";

// A sibling test may already have installed a partial `window`. Fill in this
// file's browser surface without replacing it or depending on test order.
Object.assign(
  ((globalThis as unknown as { window?: Record<string, unknown> }).window ??=
    {}),
  {
    addEventListener: () => {},
    matchMedia: () => ({ matches: false }),
  },
);
Object.assign(
  ((
    globalThis as unknown as { document?: Record<string, unknown> }
  ).document ??= {}),
  {
    documentElement: { dataset: {}, style: {} },
    querySelector: () => null,
  },
);
Object.assign(
  ((
    globalThis as unknown as { localStorage?: Record<string, unknown> }
  ).localStorage ??= {}),
  {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
);

const { TranscriptBlocks } = await import("./TranscriptBlocks");

/** The two transcript preferences as the browser store holds them: whether a
 *  turn's work shows, and whether that includes its tool calls. Absent is the
 *  default (work "running", tool calls "folded"); an old single value in the
 *  work key still answers both. */
function setTurnPrefs(work: string | null, tools: string | null = null) {
  (
    globalThis.localStorage as { getItem: (key: string) => string | null }
  ).getItem = (key) =>
    key === "opensession-turn-activity"
      ? work
      : key === "opensession-tool-calls"
        ? tools
        : null;
}

const entries: TranscriptEntry[] = [
  {
    id: "merged-notice",
    type: "user",
    content:
      '[GitHub] PR #5606 "Improve the toggle" was merged into main by Kent.',
    timestamp: "2026-08-11T12:50:45Z",
    notice: { kind: "system", title: "PR merged", tone: "info" },
  },
  {
    id: "merged-answer",
    type: "assistant",
    content: "PR #5606 is merged into main by Kent.",
    timestamp: "2026-08-11T12:50:56Z",
  },
  {
    id: "deployment-notice",
    type: "user",
    content: "Deployment finished for PR #5606.",
    timestamp: "2026-08-11T12:56:31Z",
    notice: { kind: "system", title: "Deployment finished", tone: "info" },
  },
];

describe("TranscriptBlocks shipped change action", () => {
  test("places the Slack composer after the merged response", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={entries}
        slackShare={{
          prNumber: 5606,
          sessionId: "session-1",
          defaultMessage: "We updated the toggle style in Tella.",
          screenshot: "/tmp/toggle-after.png",
          status: "idle",
          onShare: () => {},
        }}
      />,
    );
    expect(html.indexOf("PR #5606 is merged")).toBeLessThan(
      html.indexOf("Send to Slack"),
    );
    expect(html.indexOf("Send to Slack")).toBeLessThan(
      html.indexOf("Deployment finished"),
    );
    expect(html).toContain("We updated the toggle style in Tella.");
    expect(html).toContain("Send to Slack");
    expect(html).toContain('data-brand="slack"');
    expect(html).toContain("%2Ftmp%2Ftoggle-after.png");
    expect(html).toContain('aria-label="Open screenshot preview"');
    expect(html).toContain('aria-label="Remove screenshot"');
    expect(html).toContain("group/overlay-action");
    expect(html).toContain("group-hover/overlay-action:opacity-100");
    expect(html).toContain("bg-white");
    expect(html).toContain('aria-label="Add images"');
    expect(html).toContain('aria-label="Slack channel"');
    expect(html).toContain("border-line bg-surface");
    // The channel picker is the app's own select (ui/select), not a bare
    // <select> with an overlaid chevron.
    expect(html).toContain('role="combobox"');
    expect(html).toContain("rounded-[var(--composer-radius)]");
    expect(html).toContain("smooth-shadow-ring-soft");
    expect(html).not.toContain("rounded-xl bg-panel p-4");
  });

  test("finds the PR in the short merge wording too", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={entries.map((e) =>
          e.id === "merged-notice"
            ? {
                ...e,
                content:
                  "[GitHub] PR #5606 merged by Kent. Deploying. No action needed.",
              }
            : e,
        )}
        slackShare={{
          prNumber: 5606,
          sessionId: "session-1",
          defaultMessage: "We updated the toggle style in Tella.",
          status: "idle",
          onShare: () => {},
        }}
      />,
    );
    expect(html).toContain("Send to Slack");
  });

  test("keeps image attachment explicit when no screenshot exists", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={entries}
        slackShare={{
          prNumber: 5606,
          sessionId: "session-1",
          defaultMessage: "Background names are now visible in tooltips.",
          status: "idle",
          onShare: () => {},
        }}
      />,
    );
    expect(html).toContain('aria-label="Add images"');
    expect(html).not.toContain("Capture screenshot");
    expect(html).not.toContain("Capturing screenshot");
  });

  test("confirms the send and offers another message", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={entries}
        slackShare={{
          prNumber: 5606,
          sessionId: "session-1",
          defaultMessage: "We updated the toggle style in Tella.",
          status: "idle",
          onShare: () => {},
          sent: { channelName: "chat" },
        }}
      />,
    );
    expect(html).toContain("Sent to");
    expect(html).toContain("#chat");
    expect(html).toContain("Send another");
    expect(html).not.toContain('aria-label="Slack message"');
  });

  test("does not show the action for a different merged PR", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={entries}
        slackShare={{
          prNumber: 5607,
          sessionId: "session-1",
          defaultMessage: "We shipped another update.",
          status: "idle",
          onShare: () => {},
        }}
      />,
    );
    expect(html).not.toContain("Send to Slack");
  });
});

describe("TranscriptBlocks sent message actions", () => {
  test("offers edit and send again only on the current viewer's messages", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        owner="Anonymous"
        onEditMessage={() => {}}
        entries={[
          {
            id: "mine",
            type: "user",
            content: "Fix the typo",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "theirs",
            type: "user",
            content: "A teammate's message",
            timestamp: "2026-08-12T12:01:00Z",
            sender: "Ada",
          },
        ]}
      />,
    );
    expect(html.match(/aria-label="Edit and send again"/g)).toHaveLength(1);
  });

  test("does not animate a sent message when delivery settles", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "pending-message",
            type: "user",
            content: "Keep the handoff still",
            timestamp: "2026-08-12T12:00:00Z",
          },
        ]}
        pendingDeliveryIds={["pending-message"]}
      />,
    );
    expect(html).toContain("opacity-70");
    expect(html).not.toContain("opacity-70 transition-opacity");
  });

  test("reserves action clearance before the durable row arrives", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[]}
        onEditMessage={() => {}}
        optimisticEntries={[
          {
            id: "outbox-client-prompt",
            type: "user",
            content: "Keep this row still",
            timestamp: "2026-08-12T12:00:00Z",
          },
        ]}
      />,
    );
    const rowClass = html.match(
      /class="([^"]+)"[^>]*data-eid="outbox-client-prompt"/,
    )?.[1];
    expect(rowClass?.split(" ")).toContain("mb-8.75");
  });
});

describe("TranscriptBlocks compact tool runs", () => {
  const toolEntries: TranscriptEntry[] = [
    {
      id: "prompt",
      type: "user",
      content: "Check the repository",
      timestamp: "2026-08-13T06:00:00Z",
    },
    {
      id: "bash",
      type: "tool_use",
      toolUseId: "bash-call",
      toolName: "bash",
      toolInput: { command: "git status" },
      content: "Using bash",
      timestamp: "2026-08-13T06:00:01Z",
    },
    {
      id: "bash-result",
      type: "tool_result",
      toolUseId: "bash-call",
      content: "clean",
      timestamp: "2026-08-13T06:00:02Z",
    },
    {
      id: "read",
      type: "tool_use",
      toolUseId: "read-call",
      toolName: "read",
      toolInput: { filePath: "/tmp/package.json" },
      content: "Using read",
      timestamp: "2026-08-13T06:00:03Z",
    },
    {
      id: "read-result",
      type: "tool_result",
      toolUseId: "read-call",
      content: "{}",
      timestamp: "2026-08-13T06:00:04Z",
    },
  ];

  /** A second routine call and its result. Grouping starts at two, so a run
   *  that has to stay folded needs one of these beside the pair above. */
  const bashCall = (n: number, command: string): TranscriptEntry[] => [
    {
      id: `bash-${n}`,
      type: "tool_use",
      toolUseId: `bash-call-${n}`,
      toolName: "bash",
      toolInput: { command },
      content: "Using bash",
      timestamp: `2026-08-13T06:01:0${n}.000Z`,
    },
    {
      id: `bash-result-${n}`,
      type: "tool_result",
      toolUseId: `bash-call-${n}`,
      content: "ok",
      timestamp: `2026-08-13T06:01:0${n}.500Z`,
    },
  ];

  test("keeps tool-only live work to one summary row by default", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks live entries={toolEntries} />,
    );

    // The Working row already owns the count. Until the agent writes a real
    // update, a second grouped-step row would only repeat the same information.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Working</span>");
    expect(html).toContain("2 steps</span>");
    expect(html).not.toContain('data-tool-run="true"');
    expect(html).not.toContain("Show 2 grouped steps");
    expect(html).not.toContain("git status");
    expect(html).not.toContain("package.json");
  });

  test("opens tool-only work directly without repeating its group", () => {
    setTurnPrefs("open", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks live entries={toolEntries} />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(">Working</span>");
    expect(html).toContain("2 steps</span>");
    expect(html).not.toContain('data-tool-run="true"');
    expect(html).not.toContain("Show 2 grouped steps");
    expect(html).toContain("git status");
    expect(html).toContain("package.json");
    setTurnPrefs(null);
  });

  test("keeps a lone live call behind its Working row", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks live entries={toolEntries.slice(0, 3)} />,
    );

    expect(html).not.toContain('data-tool-run="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Working</span>");
    expect(html).toContain("1 step</span>");
    expect(html).not.toContain("git status");
  });

  test("folds a settled lone call into its Worked group", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          ...toolEntries.slice(0, 3),
          {
            id: "answer",
            type: "assistant",
            content: "The repository is clean.",
            timestamp: "2026-08-13T06:00:03Z",
          },
        ]}
      />,
    );

    expect(html).toContain(">Worked</span>");
    expect(html).not.toContain("git status");
    expect(html).toContain("The repository is clean.");
  });

  test("lets a worker report split work without leaving tool calls bare", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          ...toolEntries.slice(0, 3),
          {
            id: "worker-report",
            type: "user",
            content:
              "[worker os-worker] <!--os:worker-report-->\nFound the relevant file.",
            timestamp: "2026-08-13T06:00:02.500Z",
          },
          ...toolEntries.slice(3),
          {
            id: "answer",
            type: "assistant",
            content: "Finished both checks.",
            timestamp: "2026-08-13T06:00:05Z",
          },
        ]}
      />,
    );

    expect(html.match(/>Worked<\/span>/g)).toHaveLength(2);
    expect(html.indexOf(">Worked</span>")).toBeLessThan(
      html.indexOf("Worker report"),
    );
    expect(html.indexOf("Worker report")).toBeLessThan(
      html.lastIndexOf(">Worked</span>"),
    );
    expect(html).not.toContain("git status");
    expect(html).not.toContain("package.json");
    expect(html).toContain("Finished both checks.");
  });

  test("does not split work on a delivery row that renders nothing", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          ...toolEntries.slice(0, 3),
          {
            id: "empty-delivery",
            type: "user",
            content: "",
            timestamp: "2026-08-13T06:00:02.500Z",
            sender: "auto-continue",
          },
          ...toolEntries.slice(3),
          {
            id: "grouped-answer",
            type: "assistant",
            content: "Finished both checks.",
            timestamp: "2026-08-13T06:00:05Z",
          },
        ]}
      />,
    );

    expect(html.match(/>Worked<\/span>/g)).toHaveLength(1);
    expect(html).toContain("2 steps");
    expect(html).not.toContain("1 step");
  });

  test("folds edits into the run and counts their lines on the row", () => {
    setTurnPrefs(null);
    const edit = (n: number, path: string): TranscriptEntry[] => [
      {
        id: `edit-${n}`,
        type: "tool_use",
        toolUseId: `edit-call-${n}`,
        toolName: "edit",
        toolInput: { filePath: path, oldString: "old", newString: "new" },
        content: "Using edit",
        timestamp: `2026-08-13T06:00:0${n}.000Z`,
      },
      {
        id: `edit-result-${n}`,
        type: "tool_result",
        toolUseId: `edit-call-${n}`,
        content: "updated",
        timestamp: `2026-08-13T06:00:0${n}.500Z`,
      },
    ];
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          {
            id: "prompt",
            type: "user",
            content: "Rework the button",
            timestamp: "2026-08-13T06:00:00Z",
          },
          ...edit(1, "/tmp/button.tsx"),
          ...edit(2, "/tmp/button.tsx"),
          ...edit(3, "/tmp/other.tsx"),
          ...bashCall(1, "bun test"),
        ]}
      />,
    );

    // The one Working row carries both the total and the lines moved. The
    // individual calls stay behind that row until someone opens it.
    expect(html).not.toContain('data-tool-run="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("4 steps");
    expect(html).toContain("+3");
    expect(html).toContain("-3");
    expect(html).not.toContain("Show 4 grouped steps");
    expect(html).not.toContain('data-eid="edit-1"');
  });

  test("keeps server-derived code totals on the one Working row", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          {
            id: "prompt",
            type: "user",
            content: "Implement it",
            timestamp: "2026-08-13T06:00:00Z",
          },
          {
            id: "remote-edit",
            type: "tool_use",
            toolUseId: "remote-edit-call",
            toolName: "remote_code_change",
            toolInput: {},
            content: "Editing",
            timestamp: "2026-08-13T06:00:01Z",
            presentation: {
              canonical: "Edit",
              name: "Edit",
              family: "edit",
              detail: { kind: "none" },
              lineStats: { additions: 400, deletions: 23 },
            },
          },
        ]}
      />,
    );

    expect(html).toContain(">Working</span>");
    expect(html).toContain("1 step</span>");
    expect(html).toContain("+400");
    expect(html).toContain("-23");
    expect(html).not.toContain('data-tool-run="true"');
  });

  test("shows every call in place under the always-expanded preference", () => {
    setTurnPrefs("expanded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks live entries={toolEntries} />,
    );

    // Nothing to disclose, so no grouped row and no indent under one.
    expect(html).not.toContain('data-tool-run="true"');
    expect(html).not.toContain('class="ml-3"');
    expect(html).toContain("git status");
    expect(html).toContain("package.json");
    setTurnPrefs(null);
  });

  test("keeps intermediate messages and tool runs in one worker", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          ...toolEntries,
          {
            id: "note",
            type: "assistant",
            content: "The repository is clean.",
            timestamp: "2026-08-13T06:00:05Z",
          },
          ...bashCall(1, "bun test"),
          ...bashCall(2, "git diff"),
        ]}
      />,
    );

    expect(html).toContain("The repository is clean.");
    expect(html).toContain('data-narration=""');
    expect(html.match(/>Working<\/span>/g)).toHaveLength(1);
    expect(html.match(/data-tool-run="true"/g)).toHaveLength(2);
    expect(html).not.toContain("git status");
    expect(html).not.toContain("bun test");
    expect(html).not.toContain("git diff");
  });

  test("keeps incidental media status without repeating failures on the compact row", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          {
            id: "prompt",
            type: "user",
            content: "Verify it",
            timestamp: "2026-08-13T06:00:00Z",
          },
          {
            id: "bash",
            type: "tool_use",
            toolUseId: "bash-call",
            toolName: "bash",
            toolInput: { command: "bun test" },
            content: "Using bash",
            timestamp: "2026-08-13T06:00:01Z",
          },
          {
            id: "bash-result",
            type: "tool_result",
            toolUseId: "bash-call",
            content: "failed",
            isError: true,
            timestamp: "2026-08-13T06:00:02Z",
          },
          {
            id: "read",
            type: "tool_use",
            toolUseId: "read-call",
            toolName: "read",
            toolInput: { filePath: "/tmp/after.png" },
            content: "Using read",
            timestamp: "2026-08-13T06:00:03Z",
          },
          {
            id: "read-result",
            type: "tool_result",
            toolUseId: "read-call",
            content: "Image read successfully",
            images: ["/media?path=after.png"],
            timestamp: "2026-08-13T06:00:04Z",
          },
        ]}
      />,
    );

    expect(html).not.toContain("1 failed");
    expect(html).not.toContain("failed step");
    expect(html).toContain("1 image");
    expect(html).toContain("1 media");
  });

  test("keeps featured media and subagents as direct rows", () => {
    setTurnPrefs("expanded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          {
            id: "prompt",
            type: "user",
            content: "Show it",
            timestamp: "2026-08-13T06:00:00Z",
          },
          {
            id: "shot",
            type: "tool_use",
            toolUseId: "shot-call",
            toolName: "read",
            toolInput: { filePath: "/tmp/after.png" },
            content: "Using read",
            timestamp: "2026-08-13T06:00:01Z",
          },
          {
            id: "shot-result",
            type: "tool_result",
            toolUseId: "shot-call",
            content: "Image read successfully",
            images: ["/media?path=after.png"],
            featuredMedia: ["/media?path=after.png"],
            timestamp: "2026-08-13T06:00:02Z",
          },
          {
            id: "worker",
            type: "tool_use",
            toolUseId: "worker-call",
            toolName: "task",
            toolInput: { description: "Review it" },
            content: "Using task",
            timestamp: "2026-08-13T06:00:03Z",
          },
        ]}
      />,
    );

    expect(html).not.toContain('data-tool-run="true"');
    expect(html).toContain("after.png");
    expect(html).toContain("task");
    setTurnPrefs(null);
  });
});

describe("TranscriptBlocks turn work and tool call preferences", () => {
  /** A turn that narrates between its steps, so the two preferences have
   *  something to disagree about: notes to keep and calls to fold. */
  const narratedTurn: TranscriptEntry[] = [
    {
      id: "prompt",
      type: "user",
      content: "Check the repository",
      timestamp: "2026-08-19T06:00:00Z",
    },
    {
      id: "bash",
      type: "tool_use",
      toolUseId: "bash-call",
      toolName: "bash",
      toolInput: { command: "git status" },
      content: "Using bash",
      timestamp: "2026-08-19T06:00:01Z",
    },
    {
      id: "bash-result",
      type: "tool_result",
      toolUseId: "bash-call",
      content: "clean",
      timestamp: "2026-08-19T06:00:02Z",
    },
    {
      id: "read",
      type: "tool_use",
      toolUseId: "read-call",
      toolName: "read",
      toolInput: { filePath: "/tmp/package.json" },
      content: "Using read",
      timestamp: "2026-08-19T06:00:03Z",
    },
    {
      id: "read-result",
      type: "tool_result",
      toolUseId: "read-call",
      content: "{}",
      timestamp: "2026-08-19T06:00:04Z",
    },
    {
      id: "note",
      type: "assistant",
      content: "The repository is clean.",
      timestamp: "2026-08-19T06:00:05Z",
    },
    {
      id: "answer",
      type: "assistant",
      content: "All good.",
      timestamp: "2026-08-19T06:00:06Z",
    },
  ];
  // A live message remains inside the work only after another step follows it.
  // Until then it is the visible streaming tail outside the disclosure.
  const liveNarratedTurn: TranscriptEntry[] = [
    ...narratedTurn.slice(0, -1),
    {
      id: "verify",
      type: "tool_use",
      toolUseId: "verify-call",
      toolName: "bash",
      toolInput: { command: "bun test" },
      content: "Using bash",
      timestamp: "2026-08-19T06:00:06Z",
    },
    {
      id: "verify-result",
      type: "tool_result",
      toolUseId: "verify-call",
      content: "ok",
      timestamp: "2026-08-19T06:00:07Z",
    },
  ];

  test("keeps grouped calls folded inside open narrated work", () => {
    setTurnPrefs("open", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks entries={narratedTurn} />,
    );

    expect(html).toContain("The repository is clean.");
    expect(html).toContain('data-tool-run="true"');
    expect(html).not.toContain("git status");
    expect(html).not.toContain("package.json");
    setTurnPrefs(null);
  });

  test("opens grouped calls independently of the step timing", () => {
    setTurnPrefs("running", "open");
    const html = renderToStaticMarkup(
      <TranscriptBlocks live entries={liveNarratedTurn} />,
    );

    expect(html).not.toContain('data-tool-run="true"');
    expect(html).toContain("git status");
    expect(html).toContain("package.json");
    setTurnPrefs(null);
  });

  test("reads the old always-expanded preference as both controls open", () => {
    setTurnPrefs("expanded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks entries={narratedTurn} />,
    );

    expect(html).toContain("The repository is clean.");
    expect(html).not.toContain('data-tool-run="true"');
    expect(html).toContain("git status");
    setTurnPrefs(null);
  });

  test("folds intermediate narration but never the final output", () => {
    setTurnPrefs("folded", "open");
    const html = renderToStaticMarkup(
      <TranscriptBlocks entries={narratedTurn} />,
    );

    expect(html.match(/>Worked<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain("The repository is clean.");
    expect(html).not.toContain("git status");
    expect(html).toContain("All good.");
    setTurnPrefs(null);
  });

  test("shows narration while working and folds it when the turn settles", () => {
    setTurnPrefs("running", "folded");
    const running = renderToStaticMarkup(
      <TranscriptBlocks live entries={liveNarratedTurn} />,
    );
    expect(running.match(/>Working<\/span>/g)).toHaveLength(1);
    expect(running).toContain("The repository is clean.");
    expect(running).toContain('data-narration=""');
    expect(running).toContain('data-tool-run="true"');
    expect(running).not.toContain("git status");
    expect(running).toContain("bun test");

    const settled = renderToStaticMarkup(
      <TranscriptBlocks entries={narratedTurn} />,
    );
    expect(settled).not.toContain("The repository is clean.");
    expect(settled).toContain("All good.");
    expect(settled).not.toContain("git status");
    setTurnPrefs(null);
  });

  test("keeps a title-shaped final output outside the fold", () => {
    setTurnPrefs("folded", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          ...narratedTurn.slice(0, -1),
          {
            id: "bold-answer",
            type: "assistant",
            content: "**All good**",
            timestamp: "2026-08-19T06:00:06Z",
          },
        ]}
      />,
    );

    expect(html).toContain("<strong>All good</strong>");
    expect(html).not.toContain("The repository is clean.");
    setTurnPrefs(null);
  });

  test("keeps completed output visible across a background wake", () => {
    setTurnPrefs("folded", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "prompt",
            type: "user",
            content: "Ship it",
            timestamp: "2026-08-19T06:00:00Z",
          },
          {
            id: "first-tool",
            type: "tool_use",
            toolUseId: "first-call",
            toolName: "bash",
            toolInput: { command: "bun test" },
            content: "Using bash",
            timestamp: "2026-08-19T06:00:01Z",
          },
          {
            id: "status",
            type: "assistant",
            content: "Implemented and committed. Deployment is running.",
            timestamp: "2026-08-19T06:00:02Z",
          },
          {
            id: "wait-boundary",
            type: "user",
            content: "",
            timestamp: "2026-08-19T06:01:30Z",
            turnBoundary: true,
          },
          {
            id: "verify-tool",
            type: "tool_use",
            toolUseId: "verify-call",
            toolName: "bash",
            toolInput: { command: "curl /health" },
            content: "Using bash",
            timestamp: "2026-08-19T06:01:31Z",
          },
          {
            id: "final",
            type: "assistant",
            content: "Deployment verified.",
            timestamp: "2026-08-19T06:01:32Z",
          },
        ]}
      />,
    );

    expect(html).toContain("Implemented and committed. Deployment is running.");
    expect(html).toContain("Deployment verified.");
    expect(html.match(/>Worked<\/span>/g)).toHaveLength(2);
    expect(html).not.toContain("wait-boundary");
    setTurnPrefs(null);
  });

  test("coalesces consecutive reasoning revisions into their latest visible step", () => {
    const entries: TranscriptEntry[] = [
      {
        id: "prompt",
        type: "user",
        content: "Check it",
        timestamp: "2026-08-28T05:00:00Z",
      },
      {
        id: "reasoning-1",
        type: "assistant",
        content:
          "**Inspecting the current state**\n\nThe first probe found an older release.",
        isReasoning: true,
        timestamp: "2026-08-28T05:00:01Z",
      },
      {
        id: "reasoning-2",
        type: "assistant",
        content: "**Checking deployment status**",
        isReasoning: true,
        timestamp: "2026-08-28T05:00:02Z",
      },
      {
        id: "tool",
        type: "tool_use",
        toolUseId: "tool-call",
        toolName: "bash",
        toolInput: { command: "git status" },
        content: "Using bash",
        timestamp: "2026-08-28T05:00:03Z",
      },
      {
        id: "reasoning-3",
        type: "assistant",
        content: "**Verifying the release**",
        isReasoning: true,
        timestamp: "2026-08-28T05:00:04Z",
      },
      {
        id: "answer",
        type: "assistant",
        content: "Done.",
        timestamp: "2026-08-28T05:00:05Z",
      },
    ];
    setTurnPrefs("open", "folded");
    const html = renderToStaticMarkup(<TranscriptBlocks entries={entries} />);

    expect(html.match(/data-reasoning=""/g)).toHaveLength(2);
    expect(html).not.toContain("Inspecting the current state");
    expect(html).toContain("The first probe found an older release.");
    expect(html).toContain("Checking deployment status");
    expect(html).toContain("Verifying the release");
    setTurnPrefs(null);
  });

  test("repairs fragmented reasoning inside open work", () => {
    const fragmented = [
      "The",
      "rule",
      "has",
      "10",
      "specificity",
      "bridges",
      "but",
      "the",
      "formatter",
      "split",
      "them",
      "across",
      "many",
      "summary",
      "parts",
      ".",
    ].join("\n\n");
    const entries: TranscriptEntry[] = [
      {
        id: "prompt",
        type: "user",
        content: "Check it",
        timestamp: "2026-08-28T05:30:00Z",
      },
      {
        id: "reasoning",
        type: "assistant",
        content: fragmented,
        isReasoning: true,
        timestamp: "2026-08-28T05:30:01Z",
      },
      {
        id: "tool",
        type: "tool_use",
        toolUseId: "tool-call",
        toolName: "bash",
        toolInput: { command: "git status" },
        content: "Using bash",
        timestamp: "2026-08-28T05:30:02Z",
      },
      {
        id: "answer",
        type: "assistant",
        content: "Done.",
        timestamp: "2026-08-28T05:30:03Z",
      },
    ];
    setTurnPrefs("open", "folded");
    const html = renderToStaticMarkup(<TranscriptBlocks entries={entries} />);

    expect(html).toContain(
      "The rule has 10 specificity bridges but the formatter split them across many summary parts.",
    );
    expect(html).not.toContain("<br>");
    setTurnPrefs(null);
  });

  test("keeps reasoning quiet inside one work disclosure", () => {
    const entries: TranscriptEntry[] = [
      {
        id: "prompt",
        type: "user",
        content: "Check it",
        timestamp: "2026-08-28T06:00:00Z",
      },
      {
        id: "reasoning",
        type: "assistant",
        content: "**Checking deployment status**\n\n**Inspecting the release**",
        isReasoning: true,
        timestamp: "2026-08-28T06:00:01Z",
      },
      {
        id: "tool",
        type: "tool_use",
        toolUseId: "tool-call",
        toolName: "bash",
        toolInput: { command: "git status" },
        content: "Using bash",
        timestamp: "2026-08-28T06:00:02Z",
      },
      {
        id: "legacy-reasoning",
        type: "assistant",
        content: "**Verifying the release**",
        timestamp: "2026-08-28T06:00:03Z",
      },
      {
        id: "tool-2",
        type: "tool_use",
        toolUseId: "tool-call-2",
        toolName: "bash",
        toolInput: { command: "git diff" },
        content: "Using bash",
        timestamp: "2026-08-28T06:00:04Z",
      },
      {
        id: "answer",
        type: "assistant",
        content: "Done.",
        timestamp: "2026-08-28T06:00:05Z",
      },
    ];
    setTurnPrefs("folded", "folded");
    const folded = renderToStaticMarkup(<TranscriptBlocks entries={entries} />);
    expect(folded.match(/>Worked<\/span>/g)).toHaveLength(1);
    expect(folded).toContain("2 steps");
    expect(folded).not.toContain("Checking deployment status");

    setTurnPrefs("open", "folded");
    const html = renderToStaticMarkup(<TranscriptBlocks entries={entries} />);
    expect(html.match(/data-reasoning=""/g)).toHaveLength(2);
    expect(html).not.toContain("Checking deployment status");
    expect(html).toContain("Inspecting the release");
    expect(html).toContain("Verifying the release");
    expect(html).not.toContain("<strong>Checking deployment status</strong>");
    expect(html).not.toContain("<strong>Inspecting the release</strong>");
    expect(html).not.toContain("<strong>Verifying the release</strong>");

    setTurnPrefs("running", "folded");
    const running = renderToStaticMarkup(
      <TranscriptBlocks live entries={entries} />,
    );
    expect(running).toContain('aria-expanded="true"');
    expect(running).toContain('data-text-shimmer=""');

    const proseReasoning = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          {
            id: "prompt-2",
            type: "user",
            content: "Check it",
            timestamp: "2026-08-28T07:00:00Z",
          },
          {
            id: "reasoning-2",
            type: "assistant",
            content: "I should inspect the current state first.",
            isReasoning: true,
            timestamp: "2026-08-28T07:00:01Z",
          },
          {
            id: "tool-3",
            type: "tool_use",
            toolUseId: "tool-call-3",
            toolName: "read",
            toolInput: { path: "README.md" },
            content: "Using read",
            timestamp: "2026-08-28T07:00:02Z",
          },
        ]}
      />,
    );
    expect(proseReasoning.match(/>Thinking<\/span>/g)).toHaveLength(2);
    expect(proseReasoning).toContain(
      "I should inspect the current state first.",
    );
    expect(proseReasoning).toContain('data-text-shimmer=""');
    setTurnPrefs(null);
  });
});

describe("TranscriptBlocks featured media outlives the fold", () => {
  /** A settled turn: one routine call, then a step that surfaced media. */
  const turn = (result: Partial<TranscriptEntry>): TranscriptEntry[] => [
    {
      id: "prompt",
      type: "user",
      content: "Show me",
      timestamp: "2026-08-15T06:00:00Z",
    },
    {
      id: "bash",
      type: "tool_use",
      toolUseId: "bash-call",
      toolName: "bash",
      toolInput: { command: "bun run capture" },
      content: "Using bash",
      timestamp: "2026-08-15T06:00:01Z",
    },
    {
      id: "bash-result",
      type: "tool_result",
      toolUseId: "bash-call",
      content: "captured",
      timestamp: "2026-08-15T06:00:02Z",
    },
    {
      id: "shot",
      type: "tool_use",
      toolUseId: "shot-call",
      toolName: "read",
      toolInput: { filePath: "/tmp/shot.png" },
      content: "Using read",
      timestamp: "2026-08-15T06:00:03Z",
    },
    {
      id: "shot-result",
      type: "tool_result",
      toolUseId: "shot-call",
      content: "Image read successfully",
      timestamp: "2026-08-15T06:00:04Z",
      ...result,
    },
    {
      id: "answer",
      type: "assistant",
      content: "Here it is.",
      timestamp: "2026-08-15T06:00:05Z",
    },
  ];

  test("keeps a marked screenshot on screen once the turn settles", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={turn({
          images: ["/media?path=featured.png"],
          featuredMedia: ["/media?path=featured.png"],
        })}
      />,
    );

    // The work is folded: no step rows, no command.
    expect(html).toContain("Worked");
    expect(html).not.toContain("bun run capture");
    // The picture the agent asked to show is not work, so it stays.
    expect(html).toContain('src="/media?path=featured.png"');
    expect(html).toContain("md-image");
  });

  test("leaves media the turn merely touched inside the fold", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={turn({ images: ["/media?path=incidental.png"] })}
      />,
    );

    // A Read of a PNG attaches its image without featuring it. Forty of
    // those in a verification loop must not land on the page.
    expect(html).toContain("Worked");
    expect(html).not.toContain("incidental.png");
  });

  test("shows a featured video with its player", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={turn({
          videos: ["/media?path=demo.mp4"],
          featuredMedia: ["/media?path=demo.mp4"],
        })}
      />,
    );

    expect(html).toContain('src="/media?path=demo.mp4"');
    expect(html).toContain("md-video");
  });

  test("renders one tile for a loop that captured to the same path twice", () => {
    setTurnPrefs(null);
    const shot = (n: number): TranscriptEntry[] => [
      {
        id: `shot-${n}`,
        type: "tool_use",
        toolUseId: `shot-call-${n}`,
        toolName: "bash",
        toolInput: { command: "bun run capture" },
        content: "Using bash",
        timestamp: `2026-08-15T06:0${n}:00Z`,
      },
      {
        id: `shot-result-${n}`,
        type: "tool_result",
        toolUseId: `shot-call-${n}`,
        content: "OPENSESSION_IMAGE: /tmp/after.png",
        images: ["/media?path=after.png"],
        featuredMedia: ["/media?path=after.png"],
        timestamp: `2026-08-15T06:0${n}:01Z`,
      },
    ];
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "prompt",
            type: "user",
            content: "Iterate",
            timestamp: "2026-08-15T06:00:00Z",
          },
          ...shot(1),
          ...shot(2),
          {
            id: "answer",
            type: "assistant",
            content: "Done.",
            timestamp: "2026-08-15T06:03:00Z",
          },
        ]}
      />,
    );

    expect(html.match(/src="\/media\?path=after\.png"/g)).toHaveLength(1);
  });

  test("does not repeat the media that its own open row is already showing", () => {
    setTurnPrefs("expanded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={turn({
          images: ["/media?path=featured.png"],
          featuredMedia: ["/media?path=featured.png"],
        })}
      />,
    );

    expect(html).toContain("bun run capture");
    expect(html.match(/src="\/media\?path=featured\.png"/g)).toHaveLength(1);
    setTurnPrefs(null);
  });
});

describe("TranscriptBlocks review loops", () => {
  test("folds review tools but leaves model output and a following user request visible", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "review",
            type: "user",
            content:
              "[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #42 was just reviewed and is not merge-ready.",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "fix",
            type: "assistant",
            content: "Fixed the review finding.",
            timestamp: "2026-08-12T12:01:00Z",
          },
          {
            id: "human",
            type: "user",
            content: "Please also update the empty state.",
            timestamp: "2026-08-12T12:02:00Z",
          },
        ]}
        reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
      />,
    );
    expect(html).toContain("Review loop");
    expect(html).toContain("PR #42");
    expect(html).toContain("Fixed the review finding.");
    expect(html).toContain("Please also update the empty state.");
    expect(html).not.toContain("Review outcome");
    expect(html).not.toContain("Ready to merge");
  });

  test("shows a passed state on the final settled review loop", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "review",
            type: "user",
            content:
              "[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #42 was just reviewed and is not merge-ready.",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "fix",
            type: "assistant",
            content: "Fixed the review finding.",
            timestamp: "2026-08-12T12:01:00Z",
          },
        ]}
        reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
      />,
    );
    expect(html).toContain('aria-label="Review loop, Ready to merge, PR #42"');
    expect(html).toContain("Review loop");
    expect(html).toContain("Ready to merge");
    expect(html).not.toContain("5/5");
    expect(html).not.toContain("8 checks passed");
    expect(html).not.toContain("border-l border-line pl-3");
  });

  test("keeps the verdict when a legacy user-shaped status notice follows", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "review",
            type: "user",
            content: "[GitHub] <!--os:review-handoff-->\nReview PR #42",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "fix",
            type: "assistant",
            content: "Fixed the review finding.",
            timestamp: "2026-08-12T12:01:00Z",
          },
          {
            id: "deploy",
            type: "user",
            content: "[GitHub] Deployment finished for PR #42.",
            timestamp: "2026-08-12T12:02:00Z",
          },
        ]}
        reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
      />,
    );

    expect(html).toContain('aria-label="Review loop, Ready to merge, PR #42"');
    expect(html).toContain("Ready to merge");
  });

  test("opens to icon-led review steps and a final checked result", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        reviewLoopsOpen
        entries={[
          {
            id: "review",
            type: "user",
            content: "[GitHub] <!--os:review-handoff-->\nReview PR #42",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "read",
            type: "tool_use",
            toolUseId: "read-call",
            toolName: "Read",
            toolInput: { filePath: "/tmp/report.txt" },
            content: "Using Read",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "read-result",
            type: "tool_result",
            toolUseId: "read-call",
            content: "ok",
            timestamp: "2026-08-12T12:00:02Z",
          },
          {
            id: "read2",
            type: "tool_use",
            toolUseId: "read-call-2",
            toolName: "Read",
            toolInput: { filePath: "/tmp/notes.txt" },
            content: "Using Read",
            timestamp: "2026-08-12T12:00:03Z",
          },
          {
            id: "read2-result",
            type: "tool_result",
            toolUseId: "read-call-2",
            content: "ok",
            timestamp: "2026-08-12T12:00:04Z",
          },
        ]}
        reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-tool-run="true"');
    expect(html).toContain(">2 steps<");
    expect(html).not.toContain("report.txt");
    expect(html).toContain('aria-label="Review passed"');
    expect(html).toContain("M4.75 12C4.75 7.99594");
    expect(html).toContain("M9.75 12.75L10.1837 13.6744");
    expect(html).toContain("text-faint");
    expect(html).toContain("1 round · 5/5 · 8 checks passed");
    expect(html).toContain("mt-0.5 pl-2");
    expect(html).toContain(
      "flex size-[22px] flex-none self-center items-center justify-center",
    );
    expect(html).toContain("-translate-y-px");
    expect(html).not.toContain(">Worked<");
  });

  test("shows progress while a loop is still fixing feedback", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          {
            id: "review",
            type: "user",
            content:
              "[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #42 was just reviewed and is not merge-ready.",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "fix",
            type: "assistant",
            content: "Fixing the review finding.",
            timestamp: "2026-08-12T12:01:00Z",
          },
        ]}
        reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
      />,
    );
    expect(html).toContain("Working");
    expect(html).toContain('aria-label="Review in progress"');
    expect(html).not.toContain('aria-label="Review passed"');
  });

  test("shows pending review facts without a running spinner after the worker settles", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "review",
            type: "user",
            content: "[GitHub] <!--os:review-handoff-->\nReview PR #42",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "fix",
            type: "assistant",
            content: "Waiting for checks.",
            timestamp: "2026-08-12T12:01:00Z",
          },
        ]}
        reviewResult={{ status: "pending", checksPassed: 7 }}
      />,
    );
    expect(html).toContain("Working");
    expect(html).not.toContain('aria-label="Review in progress"');
  });

  test("shows a failed state when review findings remain", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          {
            id: "review",
            type: "user",
            content: "[GitHub] <!--os:review-handoff-->\nReview PR #42",
            timestamp: "2026-08-12T12:00:00Z",
          },
          {
            id: "fix",
            type: "assistant",
            content: "Could not resolve the finding.",
            timestamp: "2026-08-12T12:01:00Z",
          },
        ]}
        reviewResult={{
          status: "failed",
          confidence: 2,
          blocking: 1,
          checksFailed: 1,
        }}
      />,
    );
    expect(html).toContain('aria-label="Review loop, Needs changes, PR #42"');
    expect(html).toContain("Needs changes");
    expect(html).not.toContain("1 blocking");
    expect(html).not.toContain("1 check failed");
  });
});

describe("TranscriptBlocks virtual-list fallback", () => {
  /** A review loop that swallows `absorbed` agent answers, then `tail` turns. */
  function transcriptWithReviewLoop(
    absorbed: number,
    tail: number,
  ): TranscriptEntry[] {
    const at = (minute: number) =>
      `2026-08-12T${String(12 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`;
    const built: TranscriptEntry[] = [
      {
        id: "handoff",
        type: "user",
        content: "[GitHub] <!--os:review-handoff-->\nReview PR #42",
        timestamp: at(0),
      },
    ];
    // Absorbed by the loop: agent answers, none of them a human turn.
    for (let i = 0; i < absorbed; i++)
      built.push({
        id: `loop-answer-${i}`,
        type: "assistant",
        content: `Fixed finding ${i}.`,
        timestamp: at(1 + i),
      });
    // A human turn ends the loop, then ordinary exchanges after it.
    for (let i = 0; i < tail; i++)
      built.push({
        id: `tail-${i}`,
        type: i % 2 === 0 ? "user" : "assistant",
        content: `Tail message ${i}.`,
        timestamp: at(20 + i),
      });
    return built;
  }

  test("renders every row when measurement is unavailable", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks entries={transcriptWithReviewLoop(10, 30)} />,
    );
    expect(html).toContain('aria-label="Review loop, 1 round, PR #42"');
    expect(html).toContain("Tail message 29.");
    expect(html).not.toContain("data-virtual-transcript");
  });
});

describe("TranscriptBlocks indexed ranges", () => {
  const indexRow = (
    seq: number,
    role: "user" | "assistant" | "tool_use" | "tool_result" | "review_handoff",
    extra: Record<string, unknown> = {},
  ) => ({
    id: `indexed-${seq}`,
    seq,
    changeSeq: seq,
    timestampMs: Date.parse(`2026-08-12T12:00:0${seq}Z`),
    role,
    contentLength: 24,
    ...extra,
  });

  test("keeps unloaded history out of the transcript until it hydrates", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "user"),
          indexRow(2, "assistant"),
          indexRow(3, "user"),
        ]}
        entries={[
          {
            id: "indexed-3",
            seq: 3,
            changeSeq: 3,
            type: "user",
            content: "Newest prompt",
            timestamp: "2026-08-12T12:00:03Z",
          },
        ]}
      />,
    );
    expect(html).not.toContain("Loading messages");
    expect(html).toContain("Newest prompt");
  });

  test("keeps a message that arrived mid-turn below the turn it interrupted", () => {
    // The interrupting message is stamped 09:56:47, while the turn it landed in
    // the middle of kept emitting tool rows until 09:56:52. Its range is newer by
    // seq and older by time, so only the seq spine orders these two correctly.
    const ms = (clock: string) => Date.parse(`2026-08-21T09:56:${clock}Z`);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "user", { timestampMs: ms("28.274") }),
          indexRow(2, "tool_use", { timestampMs: ms("52.223") }),
          indexRow(3, "tool_result", { timestampMs: ms("52.269") }),
          indexRow(4, "user", { timestampMs: ms("47.472") }),
        ]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "user",
            content: "First question",
            timestamp: "2026-08-21T09:56:28.274Z",
          },
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "tool_use",
            toolName: "grep",
            toolInput: { pattern: "filterMcpServers" },
            content: "Using grep",
            timestamp: "2026-08-21T09:56:52.223Z",
          },
          {
            id: "indexed-3",
            seq: 3,
            changeSeq: 3,
            type: "tool_result",
            toolUseId: "indexed-2",
            content: "runner-shared.ts",
            timestamp: "2026-08-21T09:56:52.269Z",
          },
          {
            id: "indexed-4",
            seq: 4,
            changeSeq: 4,
            type: "user",
            content: "Second question",
            timestamp: "2026-08-21T09:56:47.472Z",
          },
        ]}
      />,
    );
    expect(html.indexOf("First question")).toBeLessThan(
      html.indexOf("Second question"),
    );
  });

  test("places an optimistic prompt before later tools despite clock skew", () => {
    setTurnPrefs("open", "open");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[indexRow(1, "assistant"), indexRow(2, "tool_use")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "assistant",
            content: "Earlier answer",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "tool_use",
            toolName: "bash",
            toolInput: { command: "git status" },
            content: "Using bash",
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
        optimisticEntries={[
          {
            id: "outbox-prompt",
            type: "user",
            content: "Question before tools",
            // Browser clock is eight seconds ahead of the server.
            timestamp: "2026-08-12T12:00:10Z",
            optimisticAfterEntryId: "indexed-1",
            optimisticAfterSeq: 1,
          },
        ]}
      />,
    );
    expect(html.indexOf("Question before tools")).toBeLessThan(
      html.indexOf("git status"),
    );
    setTurnPrefs(null);
  });

  test("keeps live assistant output below its optimistic prompt across a model switch", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        transcriptIndex={[indexRow(1, "assistant")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "assistant",
            content: "Earlier answer",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "model-switch",
            type: "system",
            content: "Switched model",
            timestamp: "2026-08-12T12:00:09Z",
          },
          {
            id: "live-assistant",
            type: "assistant",
            content: "Later assistant output",
            // The server clock is behind the browser that sent the prompt.
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
        optimisticEntries={[
          {
            id: "outbox-prompt",
            type: "user",
            content: "Does this work?",
            timestamp: "2026-08-12T12:00:10Z",
            optimisticAfterEntryId: "model-switch",
            optimisticAfterSeq: 1,
          },
        ]}
      />,
    );
    expect(html.indexOf("Does this work?")).toBeLessThan(
      html.indexOf("Later assistant output"),
    );
  });

  test("keeps a partial opening range visible while its prefix hydrates", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[indexRow(1, "user"), indexRow(2, "assistant")]}
        entries={[
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "assistant",
            content: "Visible tail answer",
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Visible tail answer");
    expect(html).not.toContain("Loading messages");
  });

  test("keeps live tool frames inside their indexed work group", () => {
    setTurnPrefs(null);
    const at = (seq: number) => `2026-08-12T12:00:0${seq}Z`;
    const tool = (seq: number, durable = true): TranscriptEntry => ({
      id: `indexed-${seq}`,
      type: "tool_use",
      toolUseId: `call-${seq}`,
      toolName: "bash",
      toolInput: { command: `check ${seq}` },
      content: "Using bash",
      timestamp: at(seq),
      ...(durable ? { seq, changeSeq: seq } : {}),
    });
    const result = (
      seq: number,
      toolSeq: number,
      durable = true,
    ): TranscriptEntry => ({
      id: `indexed-${seq}`,
      type: "tool_result",
      toolUseId: `call-${toolSeq}`,
      content: "ok",
      timestamp: at(seq),
      ...(durable ? { seq, changeSeq: seq } : {}),
    });
    const baseIndex = [
      indexRow(1, "user"),
      indexRow(2, "tool_use"),
      indexRow(3, "tool_result"),
      indexRow(4, "tool_use"),
      indexRow(5, "tool_result"),
    ];
    const fullIndex = [
      ...baseIndex,
      indexRow(6, "tool_use"),
      indexRow(7, "tool_result"),
    ];
    const baseEntries: TranscriptEntry[] = [
      {
        id: "indexed-1",
        seq: 1,
        changeSeq: 1,
        type: "user",
        content: "Inspect the session",
        timestamp: at(1),
      },
      tool(2),
      result(3, 2),
      tool(4),
      result(5, 4),
    ];
    const liveTool = tool(6, false);
    const liveResult = result(7, 6, false);
    const scenarios = [
      { index: baseIndex, entries: [...baseEntries, liveTool, liveResult] },
      {
        index: [...baseIndex, indexRow(6, "tool_use")],
        entries: [
          ...baseEntries,
          { ...liveTool, seq: 6, changeSeq: 6 },
          liveResult,
        ],
      },
      // The index and payload state updates can render in either order.
      { index: fullIndex, entries: [...baseEntries, liveTool, liveResult] },
      {
        index: fullIndex,
        entries: [
          ...baseEntries,
          { ...liveTool, seq: 6, changeSeq: 6 },
          { ...liveResult, seq: 7, changeSeq: 7 },
        ],
      },
    ];

    for (const scenario of scenarios) {
      const html = renderToStaticMarkup(
        <TranscriptBlocks
          live
          transcriptIndex={scenario.index}
          entries={scenario.entries}
        />,
      );
      expect(html).toContain(">Working</span>");
      expect(html).not.toContain(">Worked</span>");
      expect(html).toContain("3 steps");
      expect(html).toContain('data-eid="indexed-6#turn"');
    }
  });

  test("keeps live tools grouped when unindexed narration precedes them", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        transcriptIndex={[indexRow(1, "user")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "user",
            content: "Inspect the settings",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "live-narration",
            type: "assistant",
            content: "I’ll inspect the relevant files first.",
            timestamp: "2026-08-12T12:00:02Z",
          },
          {
            id: "live-tool-1",
            type: "tool_use",
            toolUseId: "call-1",
            toolName: "read",
            toolInput: { filePath: "settings.ts" },
            content: "Using read",
            timestamp: "2026-08-12T12:00:03Z",
          },
          {
            id: "live-result-1",
            type: "tool_result",
            toolUseId: "call-1",
            content: "first",
            timestamp: "2026-08-12T12:00:04Z",
          },
          {
            id: "live-tool-2",
            type: "tool_use",
            toolUseId: "call-2",
            toolName: "read",
            toolInput: { filePath: "routes.ts" },
            content: "Using read",
            timestamp: "2026-08-12T12:00:05Z",
          },
          {
            id: "live-result-2",
            type: "tool_result",
            toolUseId: "call-2",
            content: "second",
            timestamp: "2026-08-12T12:00:06Z",
          },
        ]}
      />,
    );

    expect(html.match(/>Working<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain(">Worked</span>");
    expect(html).toContain("2 steps");
    expect(html).toContain("I’ll inspect the relevant files first.");
  });

  test("keeps a note inside its loaded conversation range", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[indexRow(1, "user"), indexRow(2, "assistant")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "user",
            content: "Question before note",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "assistant",
            content: "Answer after note",
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
        notes={[
          {
            id: "middle-note",
            user: "Kent",
            text: "Note in between",
            ts: Date.parse("2026-08-12T12:00:01.500Z"),
          },
        ]}
      />,
    );
    expect(html.indexOf("Question before note")).toBeLessThan(
      html.indexOf("Note in between"),
    );
    expect(html.indexOf("Note in between")).toBeLessThan(
      html.indexOf("Answer after note"),
    );
  });

  test("drops an unloaded review loop until its payload hydrates", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "review_handoff", { reviewPrNumber: 42 }),
          indexRow(2, "assistant"),
        ]}
        entries={[]}
      />,
    );
    expect(html).not.toContain("PR #42");

    const hydrated = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "review_handoff", { reviewPrNumber: 42 }),
          indexRow(2, "assistant"),
        ]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "system",
            content: "Starting review of PR #42",
            timestamp: "2026-08-12T12:00:01Z",
            notice: {
              kind: "review-handoff",
              title: "Reviewing PR #42",
              tone: "info",
            },
          },
        ]}
      />,
    );
    expect(hydrated).toContain("PR #42");
  });

  test("does not let a model switch materialize an unloaded review loop", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "review_handoff", { reviewPrNumber: 42 }),
          indexRow(2, "assistant"),
          indexRow(3, "user"),
        ]}
        entries={[
          {
            id: "model-switch",
            type: "system",
            content: "Switched model inside old review work",
            timestamp: "2026-08-12T12:00:02.500Z",
          },
          {
            id: "indexed-3",
            seq: 3,
            changeSeq: 3,
            type: "user",
            content: "Loaded tail",
            timestamp: "2026-08-12T12:00:03Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Loaded tail");
    expect(html).not.toContain("PR #42");
    expect(html).not.toContain("Switched model inside old review work");
  });

  test("grows around unloaded middle history while loaded neighbors keep order", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "user"),
          indexRow(2, "assistant"),
          indexRow(3, "user"),
          indexRow(4, "assistant"),
          indexRow(5, "user"),
          indexRow(6, "assistant"),
        ]}
        entries={[
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "assistant",
            content: "Early answer",
            timestamp: "2026-08-12T12:00:02Z",
          },
          {
            id: "indexed-6",
            seq: 6,
            changeSeq: 6,
            type: "assistant",
            content: "Late answer",
            timestamp: "2026-08-12T12:00:06Z",
          },
        ]}
      />,
    );
    expect(html).not.toContain("Loading messages");
    expect(html.indexOf("Early answer")).toBeLessThan(
      html.indexOf("Late answer"),
    );
  });
});
