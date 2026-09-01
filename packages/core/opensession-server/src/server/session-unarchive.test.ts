import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type HumanTurnUnarchiveDeps,
  unarchiveForHumanTurn,
} from "./session-unarchive";

function recorder(registryIds: string[] = []) {
  const archived: Array<[string, boolean]> = [];
  const files: string[] = [];
  const registry = new Set(registryIds);
  let invalidations = 0;
  const deps: HumanTurnUnarchiveDeps = {
    isArchivedId(id) {
      return registry.has(id);
    },
    setArchived(id, value) {
      archived.push([id, value]);
    },
    async clearSessionFileArchive(id) {
      files.push(id);
      return true;
    },
    invalidateSessionsCache() {
      invalidations++;
    },
  };
  return { archived, files, deps, invalidations: () => invalidations };
}

const sessionsRouteSource = readFileSync(
  new URL("./routes/sessions.ts", import.meta.url),
  "utf8",
);

describe("unarchiveForHumanTurn", () => {
  test("clears every archive identity before accepting a turn", async () => {
    const calls = recorder();
    expect(
      await unarchiveForHumanTurn(
        {
          id: "os-current",
          aliasIds: ["os-old", "os-current"],
          archived: true,
        },
        calls.deps,
      ),
    ).toBe(true);
    expect(calls.archived).toEqual([
      ["os-current", false],
      ["os-old", false],
    ]);
    expect(calls.files).toEqual(["os-current"]);
    expect(calls.invalidations()).toBe(1);
  });

  test("catches archive registry state newer than the session cache", async () => {
    const calls = recorder(["os-stale"]);
    expect(
      await unarchiveForHumanTurn(
        { id: "os-stale", archived: false },
        calls.deps,
      ),
    ).toBe(true);
    expect(calls.archived).toEqual([["os-stale", false]]);
    expect(calls.files).toEqual(["os-stale"]);
    expect(calls.invalidations()).toBe(1);
  });

  test("invalidates the cache after clearing file archive state", async () => {
    let finishClear = () => {};
    const clearing = new Promise<void>((resolve) => {
      finishClear = resolve;
    });
    let invalidations = 0;
    const deps: HumanTurnUnarchiveDeps = {
      isArchivedId: () => true,
      setArchived: () => {},
      clearSessionFileArchive: async () => {
        await clearing;
        return true;
      },
      invalidateSessionsCache: () => {
        invalidations++;
      },
    };

    const unarchiving = unarchiveForHumanTurn(
      { id: "os-plain", archived: true },
      deps,
    );
    expect(invalidations).toBe(0);
    finishClear();
    expect(await unarchiving).toBe(true);
    expect(invalidations).toBe(1);
  });

  test("reactivates accepted prompts from the durable REST outbox", () => {
    const routeStart = sessionsRouteSource.indexOf(
      "// Deliver a follow-up prompt to an existing session.",
    );
    const routeEnd = sessionsRouteSource.indexOf(
      "// Durable lifecycle and metadata changes",
      routeStart,
    );
    const promptRoute = sessionsRouteSource.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(promptRoute).toContain(
      'if (session && result.status !== "handled")',
    );
    expect(promptRoute).toContain("await unarchiveForHumanTurn(session);");
  });

  test("leaves an active session untouched", async () => {
    const calls = recorder();
    expect(
      await unarchiveForHumanTurn(
        { id: "os-live", archived: false },
        calls.deps,
      ),
    ).toBe(false);
    expect(calls.archived).toEqual([]);
    expect(calls.files).toEqual([]);
    expect(calls.invalidations()).toBe(0);
  });
});
