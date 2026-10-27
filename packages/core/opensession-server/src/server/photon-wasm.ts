import { dirname, join } from "node:path";

/**
 * Pi resizes every image it sends to a model with Photon, a Rust/WASM image
 * library. Photon reads `photon_rs_bg.wasm` from its own package directory,
 * which does not exist inside a `bun build --compile` executable, so Pi's
 * loader (`utils/photon.js` in `@earendil-works/pi-coding-agent`) retries the
 * paths below. The compiled release ships the file beside the executable
 * (scripts/build-compile.ts). Without it Pi's `loadPhoton()` quietly resolves
 * to null and every image becomes "[Image omitted ...]".
 */
export const PHOTON_WASM_FILENAME = "photon_rs_bg.wasm";

/** The fallback paths Pi's Photon loader tries, in its order. */
export function photonWasmFallbackPaths(
  execPath: string = process.execPath,
  cwd: string = process.cwd(),
): string[] {
  const execDir = dirname(execPath);
  return [
    join(execDir, PHOTON_WASM_FILENAME),
    join(execDir, "photon", PHOTON_WASM_FILENAME),
    join(cwd, PHOTON_WASM_FILENAME),
  ];
}

/**
 * Pi swallows a failed Photon load, so the only symptom is images silently
 * dropped from turns. Say so once, up front, when a compiled binary cannot
 * find the wasm at any path Pi will try. Returns whether the wasm was found.
 */
export async function checkPhotonWasm(
  opts: {
    execPath?: string;
    cwd?: string;
    exists?: (path: string) => Promise<boolean>;
    warn?: (message: string) => void;
  } = {},
): Promise<boolean> {
  const exists = opts.exists ?? ((path: string) => Bun.file(path).exists());
  const paths = photonWasmFallbackPaths(opts.execPath, opts.cwd);
  for (const path of paths) if (await exists(path)) return true;
  (opts.warn ?? console.warn)(
    `[pi] ${PHOTON_WASM_FILENAME} not found (looked in ${paths.join(", ")}); ` +
      "image resizing is unavailable and images will be omitted from turns. " +
      `Reinstall the release or copy ${PHOTON_WASM_FILENAME} beside the binary.`,
  );
  return false;
}
