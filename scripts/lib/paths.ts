/**
 * Where an Open Session install lives on disk.
 *
 * Layout, modelled on self-hosted tools's single dot-directory:
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
export const OPENSESSION_HOME =
  process.env.OPENSESSION_HOME || join(HOME, ".opensession");

export const BIN_DIR = join(OPENSESSION_HOME, "bin");
export const SHIM_PATH = join(BIN_DIR, "opensession");
export const CONFIG_PATH =
  process.env.OPENSESSION_CONFIG || join(OPENSESSION_HOME, "config.json");
export const ENV_PATH =
  process.env.OPENSESSION_ENV_FILE || join(HOME, ".opensession.env");

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
export const STAGED_UNIT_PATH = join(OPENSESSION_HOME, "opensession.service");
export const INGRESS_SERVICE_NAME = "opensession-ingress";
export const INGRESS_SERVICE_PATH = `/etc/systemd/system/${INGRESS_SERVICE_NAME}.service`;
export const STAGED_INGRESS_UNIT_PATH = join(
  OPENSESSION_HOME,
  `${INGRESS_SERVICE_NAME}.service`,
);
export const USER_INGRESS_UNIT_PATH = join(
  process.env.XDG_CONFIG_HOME || join(HOME, ".config"),
  "systemd",
  "user",
  `${INGRESS_SERVICE_NAME}.service`,
);
export const SOCKET_NAME = "opensession.socket";
export const SOCKET_PATH = `/etc/systemd/system/${SOCKET_NAME}`;
export const STAGED_SOCKET_PATH = join(OPENSESSION_HOME, SOCKET_NAME);
export const USER_SOCKET_PATH = join(
  process.env.XDG_CONFIG_HOME || join(HOME, ".config"),
  "systemd",
  "user",
  SOCKET_NAME,
);
export const EXECUTOR_SERVICE_NAME = "opensession-executor";
export const EXECUTOR_SERVICE_PATH = `/etc/systemd/system/${EXECUTOR_SERVICE_NAME}.service`;
export const STAGED_EXECUTOR_UNIT_PATH = join(
  OPENSESSION_HOME,
  "opensession-executor.service",
);
export const EXECUTOR_TOKEN_PATH = "/etc/opensession/executor-token";
export const SESSION_KERNEL_SERVICE_NAME = "opensession-session-kernel";
export const SESSION_KERNEL_SERVICE_PATH = `/etc/systemd/system/${SESSION_KERNEL_SERVICE_NAME}.service`;
export const STAGED_SESSION_KERNEL_UNIT_PATH = join(
  OPENSESSION_HOME,
  "opensession-session-kernel.service",
);
export const SESSION_KERNEL_TOKEN_PATH =
  "/etc/opensession/session-kernel-token";
export const USER_SESSION_KERNEL_TOKEN_PATH = join(
  OPENSESSION_HOME,
  "session-kernel-token",
);
export const USER_SESSION_KERNEL_UNIT_PATH = join(
  process.env.XDG_CONFIG_HOME || join(HOME, ".config"),
  "systemd",
  "user",
  `${SESSION_KERNEL_SERVICE_NAME}.service`,
);
