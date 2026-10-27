import { describe, expect, test } from "bun:test";
import {
  INTERNAL_MCP_CAPABILITIES,
  renderInternalMcpCapabilities,
} from "./mcp-capabilities";
import { MCP_SERVER_CATALOG } from "./mcp-catalog";
import { createSessionsMcpServer } from "../agents/slack/sessions-tools";

describe("internal MCP capability metadata", () => {
  test("covers the complete server catalog", () => {
    expect(Object.keys(INTERNAL_MCP_CAPABILITIES).sort()).toEqual(
      MCP_SERVER_CATALOG.map((entry) => entry.name).sort(),
    );
  });
});

describe("renderInternalMcpCapabilities", () => {
  test("names only the servers this run carries, with their guidance", () => {
    const note = renderInternalMcpCapabilities({
      "opensession-runners": {},
      "opensession-sessions": {},
      external: {},
    });

    expect(note).toStartWith("## Tools\n");
    expect(note).toContain("`mcp_search`");
    expect(note).toContain("`mcp_call`");
    expect(note).toContain(
      "- `opensession-runners`: " +
        INTERNAL_MCP_CAPABILITIES["opensession-runners"].guidance,
    );
    // The tool a run cannot discover by searching: it must be named here.
    expect(note).toContain("`suggest_task`");
    expect(note).not.toContain("`opensession-memory`");
    expect(note).not.toContain("external");
  });

  test("renders in catalog order whatever order the mount map has", () => {
    const names = Object.keys(INTERNAL_MCP_CAPABILITIES);
    const reversed = Object.fromEntries(
      [...names].reverse().map((name) => [name, {}]),
    );
    const note = renderInternalMcpCapabilities(reversed);
    const rendered = note
      .split("\n")
      .filter((line) => line.startsWith("- `"))
      .map((line) => line.match(/^- `([^`]+)`/)?.[1]);

    expect(rendered).toEqual(names);
    // Same bytes for the same shape: the prompt prefix stays cacheable.
    expect(note).toBe(
      renderInternalMcpCapabilities(
        Object.fromEntries(names.map((name) => [name, {}])),
      ),
    );
    // Every server mounted at once is the ceiling; keep it a section, not
    // a manual. Raised from 7,300 for opensession-local-folders, whose
    // per-turn note names its tools instead, and from 7,500 for
    // opensession-html, one more server at the usual ~150 chars, and from
    // 7,700 for the ~100-char rule to link child sessions in a report, and
    // from 7,800 for opensession-gpu.
    expect(note.length).toBeLessThan(7_900);
  });

  test("is empty when nothing internal is mounted", () => {
    expect(renderInternalMcpCapabilities(undefined)).toBe("");
    expect(renderInternalMcpCapabilities({})).toBe("");
    expect(renderInternalMcpCapabilities({ external: {} })).toBe("");
  });
});

describe("opensession-sessions guidance follows the mounted shape", () => {
  const guidanceFor = (shape: Parameters<typeof createSessionsMcpServer>[0]) =>
    renderInternalMcpCapabilities({
      "opensession-sessions": createSessionsMcpServer({
        currentSessionId: "os-caller",
        ...shape,
      }),
    });

  test("the full control set keeps the shared text", () => {
    const full = INTERNAL_MCP_CAPABILITIES["opensession-sessions"].guidance;
    expect(guidanceFor({ createdBy: "Alex", isAdmin: true })).toContain(full);
    // A person's turn in an automation-owned session carries the full set.
    expect(
      guidanceFor({ createdBy: "Alex", isAdmin: true, humanResume: true }),
    ).toContain(full);
    // Not built yet (a lazy entry) or a bare stub: the shared text.
    expect(
      renderInternalMcpCapabilities({ "opensession-sessions": {} }),
    ).toContain(full);
  });

  test.each([
    [
      "a self-improving automation",
      {
        createdBy: "Ticket triage (automation)",
        isAdmin: false,
        automationSelf: true,
      },
      "`spawn_task`",
    ],
    [
      "the wake of a person's wait",
      { createdBy: "Alex", isAdmin: false, waitContinuation: true },
      "`task_status`",
    ],
  ])("%s is not sent after tools it lacks", (_label, shape, names) => {
    const note = guidanceFor(shape);
    expect(note).not.toContain("send_to_session");
    expect(note).not.toContain("create_session");
    expect(note).toContain(names);
    if (!("automationSelf" in shape)) expect(note).not.toContain("spawn_task");
  });
});
