/**
 * Freshness gate for the generated capability catalogs.
 *
 * Regenerates docs/generated/*.md into a temp dir — through the real CLI, in a
 * subprocess, so it exercises the hermetic environment the generator sets up —
 * and fails when the committed copies differ. A catalog nobody regenerates is
 * worse than no catalog, so this is the thing that makes them trustworthy.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GENERATOR = join(REPO_ROOT, "scripts/gen-catalogs.ts");
const CATALOGS = ["mcp-tools.md", "engines.md"];

test("committed catalogs match the generator output", () => {
  const out = mkdtempSync(join(tmpdir(), "gen-catalogs-check-"));
  try {
    const proc = Bun.spawnSync([process.execPath, GENERATOR, "--out", out], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `bun scripts/gen-catalogs.ts failed (exit ${proc.exitCode}):\n` +
          proc.stderr.toString(),
      );
    }
    for (const name of CATALOGS) {
      const committed = join(REPO_ROOT, "docs/generated", name);
      const fresh = readFileSync(join(out, name), "utf-8");
      if (!existsSync(committed)) {
        throw new Error(
          `docs/generated/${name} is missing — run: bun scripts/gen-catalogs.ts`,
        );
      }
      if (readFileSync(committed, "utf-8") !== fresh) {
        throw new Error(
          `docs/generated/${name} is stale (the MCP servers, their wiring, the ` +
            `engines or the model registry changed) — run: bun scripts/gen-catalogs.ts`,
        );
      }
    }
    expect(CATALOGS.length).toBe(2);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 180_000);
