/**
 * The catalog's DECLARED wiring against the real one.
 *
 * scripts/gen-catalogs.test.ts proves the committed catalog matches what the
 * servers expose; this proves the catalog still lists the right servers. A new
 * interactive server is the drift that matters most — it hands a capability to
 * every session — so it fails here until it is catalogued.
 */
import { describe, expect, test } from "bun:test";
import { MCP_SERVER_CATALOG, catalogFor, type McpServerCatalogEntry } from "./mcp-catalog";
import { interactiveMcpServers } from "./interactive-mcp";
import { ENGINE_IDS } from "./engine/engines-config";
import { ENGINE_NOTES } from "../../../../../scripts/gen-catalogs";

const SESSION_ID = "os-00000000-0000-7000-0000-000000000000";

function find(name: string): McpServerCatalogEntry | undefined {
  return MCP_SERVER_CATALOG.find((e) => e.name === name);
}

function wiredInteractive(): string[] {
  return Object.keys(interactiveMcpServers("You", SESSION_ID, "all"));
}

describe("MCP server catalog", () => {
  test("server names are unique", () => {
    const names = MCP_SERVER_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every server interactive runs carry is catalogued", () => {
    const wired = wiredInteractive();
    expect(wired.length).toBeGreaterThan(10);
    const missing = wired.filter((n) => !find(n)?.runClasses.includes("interactive"));
    expect(missing).toEqual([]);
  });

  test("every catalogued interactive server is wired, or says why not", () => {
    const wired = new Set(wiredInteractive());
    // A catalogued interactive server this build does not carry must be
    // conditional (a dev instance withholds self-deploy; a repo can opt out of
    // papercuts). An unexplained absence means the catalog is out of date.
    const unexplained = catalogFor("interactive")
      .filter((e) => e.runClasses.includes("interactive"))
      .filter((e) => !wired.has(e.name) && !e.condition)
      .map((e) => e.name);
    expect(unexplained).toEqual([]);
  });

  test("an unwired entry names no wiring, and a wired one names some", () => {
    for (const e of MCP_SERVER_CATALOG) {
      if (e.runClasses.includes("unwired")) expect(e.wiring).toEqual([]);
      else expect(e.wiring.length).toBeGreaterThan(0);
    }
  });
});

describe("engine catalog", () => {
  test("every engine id is described", () => {
    const missing = [...ENGINE_IDS, "fake"].filter((id) => !ENGINE_NOTES[id]);
    expect(missing).toEqual([]);
  });
});
