import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Request ingress must never rebuild the multi-thousand-session index on Bun's
 * JS thread. The async lookups read canonical native sessions directly and
 * make alias or external-session misses use the cooperative cache scan.
 */
describe("request-safe session lookups", () => {
  test("HTTP and WebSocket handlers do not call synchronous session scans", () => {
    const routesDir = import.meta.dir;
    const files = readdirSync(routesDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(routesDir, name));
    files.push(join(routesDir, "..", "ws-handlers.ts"));

    const forbidden = /\b(?:findSession|getCachedSessions|sessionIdsFor)\s*\(/g;
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(forbidden)].map(
        (match) =>
          `${file.slice(routesDir.length + 1)}:${source.slice(0, match.index).split("\n").length} ${match[0]}`,
      );
    });

    expect(violations).toEqual([]);
  });
});
