import { dirname, join } from "node:path";
import type { PiSdk } from "./pi-runtime-binding";

/**
 * Pi's codemode tool runs scripts in a QuickJS wasm VM inside a worker
 * thread. Pi finds both through its package directory (`quickjs-wasi` and
 * `@earendil-works/pi-codemode`), or, in Pi's own compiled binary, at paths
 * of its own layout. Neither exists inside the `opensession` executable, so
 * the compiled release ships both beside the binary
 * (scripts/lib/codemode-sidecars.ts) and points Pi at them here, through two
 * setters the Pi patch exports (patches/@earendil-works%2Fpi-coding-agent*).
 */
export const QUICKJS_WASM_FILENAME = "quickjs.wasm";
export const CODEMODE_WORKER_FILENAME = "codemode-worker.js";

export function codemodeSidecarPaths(execPath: string = process.execPath): {
  wasm: string;
  worker: string;
} {
  const dir = dirname(execPath);
  return {
    wasm: join(dir, QUICKJS_WASM_FILENAME),
    worker: join(dir, CODEMODE_WORKER_FILENAME),
  };
}

/** Point Pi's codemode at the files shipped beside a compiled executable.
 * Call before the first codemode script runs; source installs keep Pi's own
 * package resolution. */
export function useCompiledCodemodeSidecars(
  sdk: Pick<PiSdk, "setEmbeddedQuickJSWasmPath" | "setCodemodeWorkerSpecifier">,
  execPath: string = process.execPath,
): { wasm: string; worker: string } {
  const paths = codemodeSidecarPaths(execPath);
  sdk.setEmbeddedQuickJSWasmPath(paths.wasm);
  sdk.setCodemodeWorkerSpecifier(paths.worker);
  return paths;
}

/** Pi reports a missing sidecar only when a script runs, as a failed tool
 * call. Say so once at load, with the fix. Returns whether both exist. */
export async function checkCodemodeSidecars(
  opts: {
    execPath?: string;
    exists?: (path: string) => Promise<boolean>;
    warn?: (message: string) => void;
  } = {},
): Promise<boolean> {
  const exists = opts.exists ?? ((path: string) => Bun.file(path).exists());
  const paths = codemodeSidecarPaths(opts.execPath);
  const missing: string[] = [];
  for (const path of [paths.wasm, paths.worker])
    if (!(await exists(path))) missing.push(path);
  if (!missing.length) return true;
  (opts.warn ?? console.warn)(
    `[pi] codemode is unavailable: ${missing.join(", ")} not found. ` +
      "Reinstall the release, which ships both beside the binary.",
  );
  return false;
}

/** `opensession codemode-smoke`: run one codemode script through Pi's real
 * tool and print its output. The release workflow runs it from the packaged
 * binary, outside the release directory, so a missing sidecar fails the
 * release instead of every codemode call after install. */
export async function runCodemodeSmoke(): Promise<void> {
  const { loadPiSdk } = await import("./pi-runtime-binding");
  const sdk = await loadPiSdk();
  let tool:
    | {
        execute: (
          id: string,
          params: { code: string },
          ...rest: unknown[]
        ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
      }
    | undefined;
  sdk.createCodemodeExtension({ mode: "on", models: false })({
    registerTool: (definition: unknown) => {
      tool = definition as typeof tool;
    },
    getAllTools: () => [],
    appendEntry: () => {},
  } as never);
  if (!tool) throw new Error("Pi did not register its codemode tool");
  const result = await tool.execute(
    "codemode-smoke",
    { code: "return 6 * 7" },
    undefined,
    undefined,
    undefined,
  );
  const text = result.content
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  console.log(text);
  if (!/^Script completed/.test(text) || !/\b42\b/.test(text))
    throw new Error(`codemode smoke failed:\n${text}`);
}
