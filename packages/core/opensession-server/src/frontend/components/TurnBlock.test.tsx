import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../lib/types";

// A sibling test may already have installed partial browser globals. Fill in
// this file's browser APIs without depending on test order.
const windowShim = globalThis.window ?? {};
Object.assign(windowShim, {
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false }),
});
const documentShim = globalThis.document ?? {};
Object.assign(documentShim, {
  documentElement: { dataset: {}, style: {} },
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
});
const localStorageShim = globalThis.localStorage ?? {};
Object.assign(localStorageShim, {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
Object.assign(globalThis, {
  window: windowShim,
  document: documentShim,
  localStorage: localStorageShim,
});

const { ToolSection } = await import("./TurnBlock");
const { ToolCallBlock } = await import("./ToolCallBlock");

function toolUse<T>(
  id: string,
  toolName: string,
  toolInput: T,
): TranscriptEntry {
  return {
    id,
    type: "tool_use",
    content: "",
    timestamp: "2026-08-17T09:00:00.000Z",
    toolName,
    toolUseId: `use-${id}`,
    toolInput,
  };
}

function result(
  forId: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id: `res-${forId}`,
    type: "tool_result",
    content: "done",
    timestamp: "2026-08-17T09:00:01.000Z",
    toolUseId: `use-${forId}`,
    ...extra,
  };
}

function edit(id: string, oldString: string, newString: string) {
  return toolUse(id, "Edit", {
    file_path: "src/x.ts",
    old_string: oldString,
    new_string: newString,
  });
}

function render(
  items: TranscriptEntry[],
  toolResults: Map<string, TranscriptEntry>,
  live = false,
) {
  return renderToStaticMarkup(
    React.createElement(ToolSection, {
      items,
      toolResults,
      live,
      expandAll: false,
    }),
  );
}

// The grouped row's numbers are cached per run, keyed on the run's last entry,
// so these all read through the cache: the point of each case is that a hit is
// only taken when nothing the row reports has moved.
describe("grouped tool run row", () => {
  test("reports the run's steps, tools and line counts", () => {
    const items = [
      toolUse("a", "Bash", { command: "ls" }),
      edit("b", "x", "y\nz"),
    ];
    const html = render(items, new Map());

    expect(html).toContain("2 step");
    expect(html).toContain("Bash · Edit");
    expect(html).toContain("+2");
    expect(html).toContain("-1");
  });

  test("keeps find inside one uninterrupted run of steps", () => {
    const items = [
      toolUse("before", "read", { path: "src/App.tsx" }),
      toolUse("find", "find", { pattern: "**/*website*.ts", path: "scripts" }),
      toolUse("after", "bash", { command: "bun test" }),
    ];
    const html = render(items, new Map());

    expect(html.match(/data-tool-run="true"/g)).toHaveLength(1);
    expect(html).toContain("3 steps");
    expect(html).toContain("Read · Find · Bash");
    expect(html).not.toContain("**/*website*.ts");
  });

  test("keeps a directory listing inside the run around it", () => {
    const items = [
      toolUse("grep", "grep", { pattern: "tab", path: "src" }),
      toolUse("ls", "ls", { path: "src/frontend" }),
      toolUse("after", "grep", { pattern: "pane-header", path: "src" }),
    ];
    const html = render(items, new Map());

    expect(html.match(/data-tool-run="true"/g)).toHaveLength(1);
    expect(html).toContain("3 steps");
  });

  test("keeps skills and checklist updates inside routine steps", () => {
    const items = [
      toolUse("before", "read", { path: "src/App.tsx" }),
      toolUse("skill", "skill", { skill: "better-ui" }),
      toolUse("task-create", "TaskCreate", { subject: "Verify the worker" }),
      toolUse("task-update", "TaskUpdate", {
        taskId: "1",
        status: "in_progress",
      }),
      toolUse("plan", "todowrite", {
        todos: [{ content: "Verify the worker", status: "in_progress" }],
      }),
      toolUse("after", "bash", { command: "bun test" }),
    ];
    const html = render(items, new Map());

    expect(html.match(/data-tool-run="true"/g)).toHaveLength(1);
    expect(html).toContain("6 steps");
    expect(html).toContain(
      "Read · Skill · TaskCreate · TaskUpdate · TodoWrite · Bash",
    );
    expect(html).not.toContain("better-ui");
    expect(html).not.toContain("Verify the worker");
  });

  test("keeps ListAgents inside routine steps", () => {
    const items = [
      toolUse("before", "read", { path: "src/App.tsx" }),
      toolUse("agents", "ListAgents", {}),
      toolUse("after", "bash", { command: "bun test" }),
    ];
    const toolResults = new Map([
      ["use-agents", result("agents", { isError: true })],
    ]);
    const html = render(items, toolResults);

    expect(html.match(/data-tool-run="true"/g)).toHaveLength(1);
    expect(html).toContain("3 steps");
    expect(html).toContain("Read · ListAgents · Bash");
  });

  test("groups consecutive MCP calls as routine work", () => {
    const items = [
      toolUse("send-a", "opensession-sessions_send_to_session", {
        id: "os-a",
        message: "First update",
      }),
      toolUse("send-b", "opensession-sessions_send_to_session", {
        id: "os-b",
        message: "Second update",
      }),
    ];
    const html = render(items, new Map());

    expect(html).toContain('data-tool-run="true"');
    expect(html).toContain("2 steps");
    expect(html).toContain("opensession-sessions_send_to_session ×2");
  });

  test("keeps asset-writing MCP calls directly accessible", () => {
    const items = [
      toolUse("asset-a", "opensession-assets_write_asset", {
        path: "report/index.html",
        content: "<h1>Report</h1>",
      }),
      toolUse("asset-b", "opensession-assets_write_asset", {
        path: "report/data.json",
        content: "{}",
      }),
    ];
    const html = render(items, new Map());

    expect(html).not.toContain('data-tool-run="true"');
    expect(html).toContain("report/index.html");
    expect(html).toContain("report/data.json");
  });

  test("does not repeat a failed result on the grouped row", () => {
    const items = [
      toolUse("fail-a", "Bash", { command: "ls" }),
      toolUse("fail-b", "Bash", { command: "false" }),
    ];
    const withError = new Map([
      ["use-fail-b", result("fail-b", { isError: true })],
    ]);
    const html = render(items, withError);

    // The individual step still carries its quiet Error state when opened.
    // Repeating a failure count on the folded row made routine failures feel
    // like a turn-level alert.
    expect(html).not.toContain("failed");
    expect(html).not.toContain("text-red/80");
  });

  test("keeps an individual failed step neutral", () => {
    const entry = toolUse("quiet-failure", "Bash", { command: "false" });
    const html = renderToStaticMarkup(
      React.createElement(ToolCallBlock, {
        entry,
        result: result("quiet-failure", {
          content: "Command exited with status 1",
          isError: true,
          featuredMedia: ["detail"],
        }),
      }),
    );

    expect(html).toContain(">Error<");
    expect(html).toContain("h-[var(--collapsible-panel-height)]");
    // The expanded detail names the failure. A trailing × looked like a close
    // button and repeated the same state on the summary row.
    expect(html).not.toContain('d="M17.25 6.75L6.75 17.25"');
    expect(html).not.toContain("text-red/70");
    expect(html).not.toContain("text-red/80");
    expect(html).not.toContain("border-red/25");
  });

  test("picks up media a result carries for an unchanged run", () => {
    const items = [
      toolUse("media-a", "Bash", { command: "ls" }),
      toolUse("media-b", "Read", { file_path: "shot.png" }),
    ];
    expect(render(items, new Map())).not.toContain("image");

    const withImage = new Map([
      [
        "use-media-b",
        result("media-b", { images: ["/media?path=/tmp/a.png"] }),
      ],
    ]);

    expect(render(items, withImage)).toContain("1 image");
  });

  test("re-derives when an earlier call is replaced but the last one stands", () => {
    // mergeTranscriptEntries replaces an entry rather than mutating it, and a
    // call earlier in the run can be replaced while the last one is untouched.
    // That is the case a cache keyed on the last entry alone would get wrong.
    const last = edit("keep", "a", "b");
    // One line each way per edit, so the run stands at +2/-2 to start with.
    const before = [edit("grow", "one", "two"), last];
    expect(render(before, new Map())).toContain(">+2<");

    // The replaced call now writes three lines instead of one.
    const after = [edit("grow", "one", "two\nthree\nfour"), last];
    const html = render(after, new Map());

    expect(html).toContain(">+4<");
    expect(html).toContain(">-2<");
  });

  test("counts a step with no result as running only while live", () => {
    const items = [
      toolUse("live-a", "Bash", { command: "sleep 1" }),
      toolUse("live-b", "Bash", { command: "sleep 2" }),
    ];

    expect(render(items, new Map(), false)).not.toContain("running");
    expect(render(items, new Map(), true)).toContain("running");
  });

  test("renders identically for identical inputs", () => {
    const items = [
      toolUse("same-a", "Bash", { command: "ls" }),
      edit("same-b", "x", "y"),
    ];
    const results = new Map([["use-same-a", result("same-a")]]);

    expect(render(items, results)).toBe(render(items, results));
  });
});
