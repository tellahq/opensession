import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assetToolPath,
  canonicalToolName,
  mcpLabelParts,
  mcpServerDisplayName,
  mcpToolDisplayName,
  parseMcpTool,
  PathSummary,
  pathSummaryParts,
  toolDurationMs,
  toolDisplayName,
  toolFamily,
  toolLineStats,
  toolSummary,
  unwrapMcpDispatcher,
  visibleResultContent,
} from "./ToolCallBlock";

const roots = [
  { dir: "/home/user/projects/opensession" },
  { dir: "/home/user/worktrees/fusion-x", label: "tella-fusion" },
];

// The engine emits lowercase ids with camelCase inputs; transcripts from the
// Claude-SDK era use "Read"/"file_path". Both have to render the same.
test("pi and Claude-SDK file reads summarize identically", () => {
  const path = "/home/user/projects/opensession/package.json";
  expect(
    toolSummary("read", { filePath: path, limit: 40 }, "Using read", roots),
  ).toBe("package.json");
  expect(toolSummary("Read", { file_path: path }, "Using Read", roots)).toBe(
    "package.json",
  );
  // The engine actually in use spells it `path`, and a row that misses the
  // spelling falls back to the useless "Using read".
  expect(toolSummary("read", { path, limit: 40 }, "Using read", roots)).toBe(
    "package.json",
  );
  expect(
    toolSummary("write", { path, content: "x\n" }, "Using write", roots),
  ).toBe("package.json");
  expect(toolFamily("read")).toBe("file");
  expect(canonicalToolName("read")).toBe("Read");
});

test("an edit row names its file and counts its lines in every spelling", () => {
  const path = "/home/user/projects/opensession/src/a.ts";
  const edits = [{ oldText: "one\ntwo", newText: "one\nupdated\nthree" }];
  expect(toolSummary("edit", { path, edits }, "Using edit", roots)).toBe(
    "src/a.ts",
  );
  expect(toolLineStats("edit", { path, edits })).toEqual({
    additions: 3,
    deletions: 2,
  });
});

test("paths render relative to the session's worktrees", () => {
  expect(
    toolSummary(
      "read",
      { filePath: "/home/user/worktrees/fusion-x/src/App.res" },
      "",
      roots,
    ),
  ).toBe("tella-fusion:src/App.res");
  // Outside every worktree, only $HOME collapses.
  expect(
    toolSummary("read", { filePath: "/home/user/notes.md" }, "", roots),
  ).toBe("~/notes.md");
  expect(toolSummary("read", { filePath: "/etc/hosts" }, "", roots)).toBe(
    "/etc/hosts",
  );
  // No roots (evidence pane, previews outside a session), absolute, tidied.
  expect(
    toolSummary("read", { filePath: "/home/user/projects/x/a.ts" }, ""),
  ).toBe("~/projects/x/a.ts");
});

test("path summaries truncate the complete left-aligned path", () => {
  expect(
    pathSummaryParts("packages/core/protocol/src/tool-presentation.ts"),
  ).toEqual({
    directory: "packages/core/protocol/src",
    separator: "/",
    filename: "tool-presentation.ts",
  });
  expect(pathSummaryParts("/etc/hosts")).toEqual({
    directory: "/etc",
    separator: "/",
    filename: "hosts",
  });
  expect(pathSummaryParts("package.json")).toEqual({
    directory: "",
    separator: "",
    filename: "package.json",
  });

  const markup = renderToStaticMarkup(
    createElement(PathSummary, {
      path: "packages/core/protocol/src/tool-presentation.ts",
    }),
  );
  expect(markup).toContain("truncate");
  expect(markup).not.toContain("w-full");
});

test("bash, grep, find and glob summaries drop their plumbing", () => {
  expect(
    toolSummary(
      "bash",
      { command: "ls -la", workdir: "/tmp", timeout: 5 },
      "",
      roots,
    ),
  ).toBe("ls -la");
  expect(toolSummary("exec_command", { cmd: "git status" }, "", roots)).toBe(
    "git status",
  );
  expect(
    toolSummary(
      "bash",
      { command: "cd ~/scratch/thinking-status && grep -n foo a.ts | head" },
      "",
      roots,
    ),
  ).toBe("grep -n foo a.ts | head");
  expect(
    toolSummary(
      "bash",
      { command: "cd '/tmp/my dir'; bun test\nbun run check" },
      "",
      roots,
    ),
  ).toBe("bun test ⏎ bun run check");
  expect(toolSummary("bash", { command: "cd /tmp/scratch" }, "", roots)).toBe(
    "cd /tmp/scratch",
  );
  expect(toolSummary("bash", { command: "cdparanoia && ls" }, "", roots)).toBe(
    "cdparanoia && ls",
  );
  expect(
    toolSummary(
      "grep",
      {
        pattern: "foo",
        path: "/home/user/projects/opensession/src",
        include: "*.ts",
      },
      "",
      roots,
    ),
  ).toBe("/foo/ src");
  expect(
    toolSummary(
      "find",
      {
        pattern: "**/*website*.ts",
        path: "/home/user/projects/opensession/scripts",
        limit: 100,
      },
      "",
      roots,
    ),
  ).toBe("**/*website*.ts scripts");
  expect(canonicalToolName("find")).toBe("Find");
  expect(toolFamily("find")).toBe("find");
  // A directory listing is a search, not an unknown tool: left in `other` it
  // read as a standalone row and split the run of steps around it.
  expect(canonicalToolName("ls")).toBe("Glob");
  expect(toolFamily("ls")).toBe("find");
  expect(toolDisplayName("ls")).toBe("ls");
  expect(canonicalToolName("web_search")).toBe("WebSearch");
  expect(toolFamily("web_fetch")).toBe("web");
  expect(toolFamily("notebook_edit")).toBe("file");
  expect(toolFamily("str_replace_editor")).toBe("edit");
  expect(toolFamily("TaskUpdate")).toBe("checklist");
  // A glob with no path used to render a stray trailing space.
  expect(toolSummary("glob", { pattern: "**/*.tsx" }, "", roots)).toBe(
    "**/*.tsx",
  );
});

test("codex patch bodies name the files they touch", () => {
  const patchText =
    "*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** Add File: src/b.ts\n+y\n";
  expect(
    toolSummary("apply_patch", { patchText }, "Using apply_patch", roots),
  ).toBe("src/a.ts  ·  src/b.ts");
  expect(toolFamily("apply_patch")).toBe("edit");
  expect(toolLineStats("apply_patch", { patchText })).toEqual({
    additions: 2,
    deletions: 0,
  });
});

test("edit rows report added and removed lines", () => {
  expect(
    toolLineStats("edit", {
      oldString: "one\ntwo\nthree",
      newString: "one\nupdated\nthree\nfour\nfive",
    }),
  ).toEqual({ additions: 5, deletions: 3 });

  expect(
    toolLineStats("multiedit", {
      edits: [
        { old_string: "old", new_string: "new\nextra" },
        { old_string: "remove", new_string: "replace" },
      ],
    }),
  ).toEqual({ additions: 3, deletions: 2 });
});

test("todo writes summarize as progress, not raw JSON", () => {
  expect(
    toolSummary(
      "todowrite",
      {
        todos: [
          { content: "one", status: "completed" },
          { content: "two", status: "in_progress" },
          { content: "three", status: "pending" },
        ],
      },
      "",
      roots,
    ),
  ).toBe("two  ·  1/3 done");
});

test("MCP tools parse in both the mcp__ and flattened forms", () => {
  expect(parseMcpTool("mcp__linear__list_issues")).toEqual({
    server: "linear",
    tool: "list_issues",
  });
  expect(parseMcpTool("grafana_query_loki_logs")).toEqual({
    server: "grafana",
    tool: "query_loki_logs",
  });
  expect(parseMcpTool("opensession-sessions_get_session")).toEqual({
    server: "opensession-sessions",
    tool: "get_session",
  });
  // Native tools that happen to contain an underscore are not MCP calls.
  expect(parseMcpTool("apply_patch")).toBeNull();
  expect(parseMcpTool("exec_command")).toBeNull();
  expect(parseMcpTool("read")).toBeNull();
});

test("Open Session MCP labels read as a hierarchy", () => {
  expect(mcpServerDisplayName("opensession-portals")).toBe(
    "Open Session Portals",
  );
  expect(mcpToolDisplayName("start_portal")).toBe("Start portal");
  expect(mcpLabelParts("opensession-workflows", "workflow_status")).toEqual([
    "Open Session",
    "Workflows",
    "Status",
  ]);
  expect(mcpLabelParts("opensession-sessions", "get_session")).toEqual([
    "Open Session",
    "Sessions",
    "Get",
  ]);
  expect(
    mcpLabelParts("opensession-connected-services", "list_connected_services"),
  ).toEqual(["Open Session", "Connected Services", "List"]);
  expect(mcpLabelParts("screen-studio", "start_recording")).toEqual([
    "Screen Studio",
    "Start recording",
  ]);
  expect(toolDisplayName("opensession-portals_start_portal")).toBe(
    "Open Session · Portals · Start",
  );
  expect(
    toolSummary(
      "opensession-portals_start_portal",
      {},
      "Using opensession-portals_start_portal",
    ),
  ).toBe("");
});

test("pi's MCP dispatcher renders the call inside its envelope", () => {
  const dispatched = {
    name: "opensession-workflows_workflow_status",
    arguments: { runId: "run-1" },
  };
  expect(unwrapMcpDispatcher("mcp_call", dispatched)).toEqual({
    toolName: "opensession-workflows_workflow_status",
    input: { runId: "run-1" },
  });
  expect(toolSummary("mcp_call", dispatched, "Using mcp_call")).toBe(
    "runId: run-1",
  );
});

test("an assets call reads as the file it names, not its contents", () => {
  const write = {
    path: "viz/index.html",
    content: "<!doctype html>\n<html><body>a whole artifact…</body></html>",
  };
  expect(toolSummary("opensession-assets_write_asset", write, "", roots)).toBe(
    "viz/index.html",
  );
  expect(assetToolPath("opensession-assets_write_asset", write)).toBe(
    "viz/index.html",
  );
  // Only this server's path-taking calls; a listing names nothing, and
  // another server's `path` is not an asset.
  expect(assetToolPath("opensession-assets_list_assets", {})).toBe("");
  expect(assetToolPath("opensession-todos_add_todo", { path: "a.md" })).toBe(
    "",
  );
});

test("the run-rpc session key stays out of MCP summaries", () => {
  expect(
    toolSummary(
      "opensession-sessions_get_session",
      { __bks_oc_session: "ses_123", id: "bks-1" },
      "",
      roots,
    ),
  ).toBe("id: bks-1");
});

test("tool duration uses the result timestamp or a live clock", () => {
  const entry = {
    id: "call",
    type: "tool_use" as const,
    content: "",
    timestamp: "2026-07-29T10:00:00.000Z",
  };
  const result = {
    id: "result",
    type: "tool_result" as const,
    content: "",
    timestamp: "2026-07-29T10:00:12.500Z",
  };

  expect(toolDurationMs(entry, result)).toBe(12_500);
  expect(
    toolDurationMs(entry, undefined, Date.parse("2026-07-29T10:01:00.000Z")),
  ).toBe(60_000);
  expect(toolDurationMs(entry)).toBeNull();
});

test("image reads show the image without the redundant engine acknowledgement", () => {
  expect(visibleResultContent("Image read successfully", true, false)).toBe("");
  expect(visibleResultContent("Image read successfully.", true, false)).toBe(
    "",
  );
  expect(visibleResultContent("Image is 1600 x 900", true, false)).toBe(
    "Image is 1600 x 900",
  );
  expect(visibleResultContent("Image read successfully", true, true)).toBe(
    "Image read successfully",
  );
});
