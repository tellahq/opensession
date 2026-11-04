/**
 * Where the installed `opensession` shim lives. Split out of paths.ts so the
 * server can name the shim without importing the CLI's install-root
 * resolution, which resolves the binary's real path synchronously at load.
 */

import { homedir } from "os";
import { join } from "path";

/** Everything a normal install owns, overridable for tests and side-by-side installs. */
export const OPENSESSION_HOME =
  process.env.OPENSESSION_HOME || join(homedir(), ".opensession");

export const BIN_DIR = join(OPENSESSION_HOME, "bin");
export const SHIM_PATH = join(BIN_DIR, "opensession");
