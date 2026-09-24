import { describe, expect, test } from "bun:test";
import {
  INTERNAL_MCP_CAPABILITIES,
  renderInternalMcpCapabilities,
} from "./mcp-capabilities";
import { MCP_SERVER_CATALOG } from "./mcp-catalog";

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
    // a manual.
    expect(note.length).toBeLessThan(6_850);
  });

  test("is empty when nothing internal is mounted", () => {
    expect(renderInternalMcpCapabilities(undefined)).toBe("");
    expect(renderInternalMcpCapabilities({})).toBe("");
    expect(renderInternalMcpCapabilities({ external: {} })).toBe("");
  });
});
