import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  CODEMODE_WORKER_FILENAME,
  QUICKJS_WASM_FILENAME,
} from "../../packages/core/opensession-server/src/server/codemode-runtime";
import {
  resolveCodemodeSources,
  stageCodemodeSidecars,
} from "./codemode-sidecars";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("codemode sidecars", () => {
  test("resolve Pi's own QuickJS wasm and worker", () => {
    const { wasm, worker } = resolveCodemodeSources();
    expect(wasm.endsWith("quickjs-wasi/quickjs.wasm")).toBe(true);
    expect(worker).toContain("pi-codemode");
  });

  test("build-compile stages them with the other executable sidecars", () => {
    const source = readFileSync(
      join(REPO_ROOT, "scripts", "build-compile.ts"),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("async function stageExecutableSidecars"),
    );
    expect(body).toContain("stageCodemodeSidecars(exeDir)");
  });

  test("a compiled binary runs codemode only with the staged sidecars, from any folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemode-compiled-"));
    try {
      const exe = join(dir, "bin", "codemode-smoke");
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "codemode-smoke-entry.ts")],
        compile: { outfile: exe },
        external: ["*.html"],
      });
      expect(build.success).toBe(true);
      const run = async () => {
        // Never the release directory: Pi's own lookup searched the working
        // folder, which is how a manual copy there hid the bug.
        const proc = Bun.spawn([exe], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, OPENSESSION_STATE_DIR: join(dir, "state") },
        });
        const out =
          (await new Response(proc.stdout).text()) +
          (await new Response(proc.stderr).text());
        return { code: await proc.exited, out };
      };

      const missing = await run();
      expect(missing.code).toBe(1);

      const staged = await stageCodemodeSidecars(dirname(exe));
      expect(staged.wasm).toBe(join(dirname(exe), QUICKJS_WASM_FILENAME));
      expect(existsSync(join(dirname(exe), CODEMODE_WORKER_FILENAME))).toBe(
        true,
      );
      const ok = await run();
      expect(ok.out).toContain("Script completed");
      expect(ok.out).toContain("42");
      expect(ok.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
