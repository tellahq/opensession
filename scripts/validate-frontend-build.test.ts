import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFrontendBuild } from "./validate-frontend-build";

function fixture(meta: object, assets: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "opensession-frontend-validate-"));
  writeFileSync(join(dir, ".bundle-meta.json"), JSON.stringify(meta));
  for (const asset of assets) {
    mkdirSync(join(dir, asset, ".."), { recursive: true });
    writeFileSync(join(dir, asset), asset);
  }
  return dir;
}

describe("validateFrontendBuild", () => {
  test("accepts a complete bundle for the exact source hash", () => {
    const dir = fixture(
      { inputsHash: "source-one", assets: ["App-a.js", "global-a.css"] },
      ["App-a.js", "global-a.css"],
    );
    try {
      expect(validateFrontendBuild(dir, "source-one")).toEqual({
        assets: ["App-a.js", "global-a.css"],
        inputsHash: "source-one",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects stale metadata and missing assets", () => {
    const stale = fixture({ inputsHash: "old", assets: ["App-a.js"] }, [
      "App-a.js",
    ]);
    const incomplete = fixture({
      inputsHash: "source-one",
      assets: ["missing.js"],
    });
    try {
      expect(() => validateFrontendBuild(stale, "source-one")).toThrow(
        "input hash mismatch",
      );
      expect(() => validateFrontendBuild(incomplete, "source-one")).toThrow(
        "bundle is incomplete",
      );
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(incomplete, { recursive: true, force: true });
    }
  });

  test("rejects missing or empty metadata", () => {
    const empty = fixture({ inputsHash: "source-one", assets: [] });
    const missing = mkdtempSync(
      join(tmpdir(), "opensession-frontend-validate-missing-"),
    );
    try {
      expect(() => validateFrontendBuild(empty, "source-one")).toThrow(
        "has no assets",
      );
      expect(() => validateFrontendBuild(missing, "source-one")).toThrow(
        "metadata is missing or invalid",
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(missing, { recursive: true, force: true });
    }
  });
});
