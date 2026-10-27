/**
 * Stage Photon's wasm beside a compiled `opensession` executable.
 *
 * Pi (`@earendil-works/pi-coding-agent`) resizes images with Photon
 * (`@silvia-odwyer/photon-node`), which reads `photon_rs_bg.wasm` from its
 * package directory at load time. `bun build --compile` cannot embed that read,
 * so Pi falls back to `<dirname(process.execPath)>/photon_rs_bg.wasm`. A release
 * without the file drops every image from Pi turns.
 */

import { copyFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { PHOTON_WASM_FILENAME } from "../../packages/core/opensession-server/src/server/photon-wasm";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SERVER_PACKAGE = join(
  REPO_ROOT,
  "packages",
  "core",
  "opensession-server",
);

/**
 * The exact wasm Pi's Photon loads: resolve Pi from the server package, then
 * Photon from Pi, so the copy always matches the version Pi depends on, under
 * any node_modules layout.
 */
export function resolvePhotonWasm(fromDir: string = SERVER_PACKAGE): string {
  const pi = Bun.resolveSync("@earendil-works/pi-coding-agent", fromDir);
  const photonPackage = dirname(
    Bun.resolveSync("@silvia-odwyer/photon-node/package.json", dirname(pi)),
  );
  const wasm = join(photonPackage, PHOTON_WASM_FILENAME);
  if (!existsSync(wasm))
    throw new Error(
      `Photon package at ${photonPackage} has no ${PHOTON_WASM_FILENAME}`,
    );
  return wasm;
}

/** Copy the wasm into `destDir` (the executable's directory). */
export function stagePhotonWasm(
  destDir: string,
  source = resolvePhotonWasm(),
): string {
  const destination = join(destDir, PHOTON_WASM_FILENAME);
  copyFileSync(source, destination);
  return destination;
}
