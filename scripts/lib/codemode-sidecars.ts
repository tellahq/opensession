/**
 * Stage Pi codemode's QuickJS wasm and worker beside a compiled `opensession`
 * executable (see packages/core/opensession-server/src/server/codemode-runtime.ts).
 *
 * Both are resolved through Pi (`@earendil-works/pi-coding-agent` →
 * `@earendil-works/pi-codemode` → `quickjs-wasi`), so the staged copies always
 * match the versions Pi depends on, under any node_modules layout.
 */

import { copyFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  CODEMODE_WORKER_FILENAME,
  QUICKJS_WASM_FILENAME,
} from "../../packages/core/opensession-server/src/server/codemode-runtime";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SERVER_PACKAGE = join(
  REPO_ROOT,
  "packages",
  "core",
  "opensession-server",
);

export function resolveCodemodeSources(fromDir: string = SERVER_PACKAGE): {
  wasm: string;
  worker: string;
} {
  const pi = Bun.resolveSync("@earendil-works/pi-coding-agent", fromDir);
  const worker = Bun.resolveSync(
    "@earendil-works/pi-codemode/worker",
    dirname(pi),
  );
  const wasm = Bun.resolveSync("quickjs-wasi/quickjs.wasm", dirname(worker));
  for (const path of [worker, wasm])
    if (!existsSync(path)) throw new Error(`codemode source missing: ${path}`);
  return { wasm, worker };
}

/** Copy the wasm and bundle the worker into `destDir`, the executable's
 * directory. The worker receives the compiled wasm module from Pi, so it is
 * self-contained once bundled. */
export async function stageCodemodeSidecars(
  destDir: string,
  sources = resolveCodemodeSources(),
): Promise<{ wasm: string; worker: string }> {
  const wasm = join(destDir, QUICKJS_WASM_FILENAME);
  copyFileSync(sources.wasm, wasm);
  const worker = join(destDir, CODEMODE_WORKER_FILENAME);
  const build = await Bun.build({
    entrypoints: [sources.worker],
    target: "bun",
  });
  if (!build.success || build.outputs.length !== 1)
    throw new Error(
      `codemode worker build failed: ${build.logs.map(String).join("\n")}`,
    );
  await Bun.write(worker, build.outputs[0]!);
  return { wasm, worker };
}
