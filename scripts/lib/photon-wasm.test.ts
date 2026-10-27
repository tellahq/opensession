/**
 * The compiled release must ship Photon's wasm beside the executable, or Pi
 * replaces every image in a turn with "[Image omitted ...]".
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import sharp from "sharp";
import { PHOTON_WASM_FILENAME } from "../../packages/core/opensession-server/src/server/photon-wasm";
import { resolvePhotonWasm, stagePhotonWasm } from "./photon-wasm";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

describe("photon wasm staging", () => {
  test("resolves the wasm of the Photon version Pi depends on", () => {
    const wasm = resolvePhotonWasm();
    expect(wasm.endsWith(PHOTON_WASM_FILENAME)).toBe(true);
    expect([...readFileSync(wasm).subarray(0, 4)]).toEqual(WASM_MAGIC);

    const pi = Bun.resolveSync(
      "@earendil-works/pi-coding-agent",
      join(REPO_ROOT, "packages", "core", "opensession-server"),
    );
    const piPackage = JSON.parse(
      readFileSync(join(dirname(pi), "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const photonPackage = JSON.parse(
      readFileSync(join(dirname(wasm), "package.json"), "utf8"),
    ) as { version: string };
    expect(piPackage.dependencies["@silvia-odwyer/photon-node"]).toContain(
      photonPackage.version,
    );
  });

  test("stages the wasm beside the executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "photon-stage-"));
    try {
      const staged = stagePhotonWasm(dir);
      expect(staged).toBe(join(dir, PHOTON_WASM_FILENAME));
      expect(
        readFileSync(staged).equals(readFileSync(resolvePhotonWasm())),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("build-compile stages the wasm in both bare and artefact mode", () => {
    const source = readFileSync(
      join(REPO_ROOT, "scripts", "build-compile.ts"),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("async function stageExecutableSidecars"),
    );
    expect(body).toContain("stagePhotonWasm(exeDir)");
    expect(source).toContain(
      "await stageExecutableSidecars(dirname(outfile));",
    );
    expect(source).toContain("await stageExecutableSidecars(stage);");
    // Worker sidecars and the wasm travel together; a direct worker build in
    // either mode would skip the wasm again.
    expect(source.match(/await buildWorkerSidecars\(/g)).toHaveLength(1);
  });

  test("a compiled binary resizes images only with the staged wasm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photon-compiled-"));
    try {
      // Bun bakes Photon's absolute package path into the binary, and on
      // the build host that path still holds the wasm. Compile against a
      // throwaway copy and delete it, so the binary has to use the same
      // fallback a real install does.
      const photonCopy = join(dir, "photon-node");
      cpSync(dirname(resolvePhotonWasm()), photonCopy, { recursive: true });
      const exe = join(dir, "bin", "photon-smoke");
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "photon-wasm-smoke-entry.ts")],
        compile: { outfile: exe },
        plugins: [
          {
            name: "photon-copy",
            setup(builder) {
              builder.onResolve(
                { filter: /^@silvia-odwyer\/photon-node$/ },
                () => ({ path: join(photonCopy, "photon_rs.js") }),
              );
            },
          },
        ],
      });
      expect(build.success).toBe(true);
      rmSync(photonCopy, { recursive: true, force: true });

      const png = join(dir, "input.png");
      writeFileSync(
        png,
        await sharp({
          create: {
            width: 8,
            height: 8,
            channels: 3,
            background: "#336699",
          },
        })
          .png()
          .toBuffer(),
      );
      const run = async (): Promise<unknown> => {
        const proc = Bun.spawn([exe, png], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        return JSON.parse(out.trim());
      };

      expect(await run()).toBeNull();
      stagePhotonWasm(dirname(exe));
      expect(await run()).toEqual({ width: 2, height: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
