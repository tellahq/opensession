/**
 * Where an Open Session install lives on disk.
 *
 * Layout, modelled on opencode's single dot-directory:
 *
 *   ~/.opensession/
 *     bin/opensession     shim on PATH, execs the CLI in this checkout
 *     src/                the git checkout (unless installed elsewhere)
 *     config.json         instance config
 *   ~/.opensession.env    secrets (systemd EnvironmentFile)
 *
 * REPO_ROOT is derived from this file's location rather than assumed, so the
 * CLI works identically from ~/.opensession/src, from a developer's clone, and
 * from a worktree.
 */

import { homedir } from "os";
import { realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";

export const HOME = homedir();

/** Root of the install this CLI runs from. In a source checkout it is the
 *  checkout (two up from this file). In the compiled binary, `import.meta.dir`
 *  is a virtual path inside the executable, so use the directory the binary
 *  actually lives in (the release dir), following the shim symlink. */
export const REPO_ROOT = (() => {
  const compiled = !/^bun(\b|-|\.|$)/i.test(basename(process.execPath));
  if (compiled) {
    try {
      return dirname(realpathSync(process.execPath));
    } catch {
      return dirname(process.execPath);
    }
  }
  return resolve(import.meta.dir, "..", "..");
})();

/** Everything a normal install owns, overridable for tests and side-by-side installs. */
export const OPENSESSION_HOME = process.env.OPENSESSION_HOME || join(HOME, ".opensession");

export const BIN_DIR = join(OPENSESSION_HOME, "bin");
export const SHIM_PATH = join(BIN_DIR, "opensession");
export const CONFIG_PATH = process.env.OPENSESSION_CONFIG || join(OPENSESSION_HOME, "config.json");
export const ENV_PATH = process.env.OPENSESSION_ENV_FILE || join(HOME, ".opensession.env");

/** The unit name is fixed; the file is rendered per-box at install time. */
export const SERVICE_NAME = "opensession";
/** User-scope unit: no root, the default. */
export const USER_UNIT_PATH = join(
  process.env.XDG_CONFIG_HOME || join(HOME, ".config"),
  "systemd",
  "user",
  `${SERVICE_NAME}.service`,
);
/** System-scope unit: the operator path (`service install --system`). */
export const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
