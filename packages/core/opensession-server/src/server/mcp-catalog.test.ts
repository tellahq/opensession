/**
 * The catalog's DECLARED wiring against the real one.
 *
 * scripts/gen-catalogs.test.ts proves the committed catalog matches what the
 * servers expose; this proves the catalog still lists the right servers. The
 * interactive and complete automation sets both fail here until new wiring is
 * catalogued.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  MCP_SERVER_CATALOG,
  catalogFor,
  type McpServerCatalogEntry,
} from "./mcp-catalog";
import { interactiveMcpServers } from "./interactive-mcp";
const ENGINE_IDS = ["pi"] as const;
import { ENGINE_NOTES } from "../../../../../scripts/gen-catalogs";

const SESSION_ID = "os-00000000-0000-7000-0000-000000000000";

function find(name: string): McpServerCatalogEntry | undefined {
  return MCP_SERVER_CATALOG.find((e) => e.name === name);
}

function wiredInteractive(): string[] {
  return Object.keys(interactiveMcpServers("You", SESSION_ID));
}

/** Read the two object literals that compose the complete automation surface.
 * This checks the existing wiring without importing automations.ts, whose store
 * path is initialized at module load. */
function wiredAutomation(): string[] {
  const source = readFileSync(
    resolve(import.meta.dir, "automations.ts"),
    "utf-8",
  );
  const section = (startMarker: string, endMarker: string): string => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0)
      throw new Error(`automation wiring marker missing: ${startMarker}`);
    return source.slice(start, end);
  };
  const wiring = [
    section(
      "export function selfImproveMcpServers(",
      "/** selfImproveMcpServers for a session file",
    ),
    section(
      "export function automationBaselineMcpServers(",
      "/** The automation-bar servers rebuilt for run-rpc's FALLBACK path",
    ),
    section(
      "function automationRunInProcessMcp(",
      "/**\n * automationRunInProcessMcp for a session file",
    ),
  ].join("\n");
  return [...wiring.matchAll(/"(opensession-[a-z-]+)"\s*:/g)].map(
    (match) => match[1]!,
  );
}

function wiredGoal(): string[] {
  const source = readFileSync(
    resolve(import.meta.dir, "goal-runner.ts"),
    "utf-8",
  );
  const start = source.indexOf("function goalMcpServers(");
  const end = source.indexOf("\n}\n\nfunction buildGoalWakePrompt", start);
  if (start < 0 || end < 0) throw new Error("goal wiring markers missing");
  return [
    ...source.slice(start, end).matchAll(/"(opensession-[a-z-]+)"\s*:/g),
  ].map((match) => match[1]!);
}

describe("MCP server catalog", () => {
  test("server names are unique", () => {
    const names = MCP_SERVER_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every server interactive runs carry is catalogued", () => {
    const wired = wiredInteractive();
    expect(wired.length).toBeGreaterThan(10);
    const missing = wired.filter(
      (n) => !find(n)?.runClasses.includes("interactive"),
    );
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

  test("complete automation wiring matches the catalog", () => {
    const wired = wiredAutomation();
    expect([...new Set(wired)].sort()).toEqual(
      catalogFor("automation")
        .map((entry) => entry.name)
        .sort(),
    );
  });

  test("complete goal wiring matches the catalog", () => {
    expect(wiredGoal().sort()).toEqual(
      catalogFor("goal")
        .map((entry) => entry.name)
        .sort(),
    );
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
