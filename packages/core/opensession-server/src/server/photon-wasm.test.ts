import { describe, expect, test } from "bun:test";
import {
  checkPhotonWasm,
  PHOTON_WASM_FILENAME,
  photonWasmFallbackPaths,
} from "./photon-wasm";

describe("checkPhotonWasm", () => {
  const execPath = "/opt/opensession/releases/v1/opensession";
  const cwd = "/srv/work";

  test("mirrors Pi's fallback order", () => {
    expect(photonWasmFallbackPaths(execPath, cwd)).toEqual([
      `/opt/opensession/releases/v1/${PHOTON_WASM_FILENAME}`,
      `/opt/opensession/releases/v1/photon/${PHOTON_WASM_FILENAME}`,
      `/srv/work/${PHOTON_WASM_FILENAME}`,
    ]);
  });

  test("stays quiet when any fallback path has the wasm", async () => {
    const warnings: string[] = [];
    const found = await checkPhotonWasm({
      execPath,
      cwd,
      exists: async (path) => path.startsWith("/srv/work/"),
      warn: (message) => warnings.push(message),
    });
    expect(found).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("warns once with every path it tried when the wasm is missing", async () => {
    const warnings: string[] = [];
    const found = await checkPhotonWasm({
      execPath,
      cwd,
      exists: async () => false,
      warn: (message) => warnings.push(message),
    });
    expect(found).toBe(false);
    expect(warnings).toHaveLength(1);
    for (const path of photonWasmFallbackPaths(execPath, cwd))
      expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain("images will be omitted");
  });
});
