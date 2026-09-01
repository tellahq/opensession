import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RELEASE_MARKER = ".opensession-release";

/** Immutable release identity shared by the gateway, SessionKernel, and executor. */
export function runtimeGeneration(root = process.cwd()): string {
  try {
    const value = readFileSync(resolve(root, RELEASE_MARKER), "utf8").trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : "development";
  } catch {
    return "development";
  }
}
