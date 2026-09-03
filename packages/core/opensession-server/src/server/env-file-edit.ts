/**
 * Surgical edits to the secrets env file (`~/.opensession.env` — the systemd
 * EnvironmentFile, also what the CLI's onboard/connect commands write).
 *
 * The web setup routes (routes/setup.ts) use this to store integration
 * credentials and ENABLE_* flags. Callers own key validation (only keys from
 * an integration's declared spec.env may ever reach here — never arbitrary
 * names like PATH); this module owns value validation, line editing, backup,
 * atomicity, and 0600.
 *
 * Line handling: an existing `KEY=...` (or commented-out `# KEY=...`) line is
 * replaced in place; a new key is appended at the end under a
 * `# --- added via web setup ---` marker. Setting a key to the empty string
 * unsets it by commenting the line out with a web-setup tombstone (so the
 * systemd EnvironmentFile stops defining it after the next restart, but the
 * operator can still see what was there).
 */

import { chmodSync, existsSync, readFileSync, rmSync } from "fs";
import { dirname } from "path";
import { statePath } from "./paths";
import { backupFile } from "./config-mutation";
import { writeFileAtomic } from "./shared/atomic-write";

/** Same resolution the CLI uses (scripts/lib/paths.ts): env override first,
 *  then the dual-read home path. Read per call so tests can repoint it. */
export function envFilePath(): string {
  return process.env.OPENSESSION_ENV_FILE || statePath(".opensession.env");
}

const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * The env file cannot be edited from this process. Every write creates two
 * siblings (`.bak-<n>`, then the atomic `.tmp.*` rename source), so write
 * access on the file alone is not enough: the directory must be writable by
 * the service user. A system-scope install that points OPENSESSION_ENV_FILE
 * into root-only `/etc/opensession` hits this on every Settings save.
 */
export class EnvFileWriteError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(envFileWriteRequirement(path), { cause });
    this.name = "EnvFileWriteError";
    this.path = path;
  }
}

/** One sentence shared by the server error and the installer check. */
export function envFileWriteRequirement(path: string): string {
  return (
    `Cannot write the env file ${path}: the service user needs write access to ${dirname(path)} ` +
    "because backups and atomic writes create files beside it. Move the file to a directory " +
    "the service user owns, set OPENSESSION_ENV_FILE to match, and reinstall the service."
  );
}

function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && PERMISSION_CODES.has(code);
}

export const WEB_SETUP_MARKER = "# --- added via web setup ---";
export const WEB_SETUP_UNSET_SUFFIX = " # unset via web setup";

const MAX_ENV_VALUE_LENGTH = 4096;

/** Reject anything that can't be one well-formed env-file line. */
export function validateEnvValue(value: unknown): string | null {
  if (typeof value !== "string") return "value must be a string";
  if (value.length > MAX_ENV_VALUE_LENGTH) {
    return `value exceeds ${MAX_ENV_VALUE_LENGTH} characters`;
  }
  if (/[\n\r\0]/.test(value)) return "value must be a single line";
  return null;
}

/** Quote only when needed; systemd EnvironmentFile and dotenv both read
 *  double-quoted values with backslash escapes. */
function formatEnvLine(key: string, value: string): string {
  if (value === "" || /[^A-Za-z0-9_@%+=:,./-]/.test(value)) {
    return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `${key}=${value}`;
}

function activeLineRe(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
}

function commentedLineRe(key: string): RegExp {
  return new RegExp(`^\\s*#\\s*(?:export\\s+)?${key}\\s*=`);
}

/**
 * Pure line-editing core (unit-tested): apply `edits` to env-file `content`.
 * Non-empty value → set (replace the active line in place, else uncomment a
 * commented one in place, else append under the marker). Empty value → unset
 * (comment out every active line for the key; absent key is a no-op).
 */
export function applyEnvEdits(
  content: string,
  edits: Record<string, string>,
): string {
  const lines = content.length ? content.split("\n") : [];
  // A trailing newline yields one empty final element — drop it and restore
  // the newline on the way out so appends land on real lines.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();

  const toAppend: string[] = [];
  for (const [key, value] of Object.entries(edits)) {
    const active = activeLineRe(key);
    const commented = commentedLineRe(key);
    if (value === "") {
      for (let i = 0; i < lines.length; i++) {
        if (active.test(lines[i])) {
          lines[i] = `# ${lines[i].trim()}${WEB_SETUP_UNSET_SUFFIX}`;
        }
      }
      continue;
    }
    const line = formatEnvLine(key, value);
    const activeIdx = lines.findIndex((l) => active.test(l));
    if (activeIdx !== -1) {
      lines[activeIdx] = line;
      continue;
    }
    const commentedIdx = lines.findIndex((l) => commented.test(l));
    if (commentedIdx !== -1) {
      lines[commentedIdx] = line;
      continue;
    }
    toAppend.push(line);
  }

  if (toAppend.length) {
    if (!lines.some((l) => l.trim() === WEB_SETUP_MARKER)) {
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(WEB_SETUP_MARKER);
    }
    lines.push(...toAppend);
  }

  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** A prepared env-file edit can be rolled back if a second file in the same
 * config mutation fails to commit. Call only while holding the shared lock. */
export interface PreparedEnvFileEdit {
  commit(): void;
  rollback(): void;
}

export function prepareEnvFileEdits(
  edits: Record<string, string>,
): PreparedEnvFileEdit {
  const path = envFilePath();
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, "utf-8") : "";
  const after = applyEnvEdits(before, edits);
  let committed = false;
  return {
    commit() {
      if (committed) return;
      try {
        backupFile(path);
        writeFileAtomic(path, after);
      } catch (error) {
        if (isPermissionError(error)) throw new EnvFileWriteError(path, error);
        throw error;
      }
      committed = true;
      try {
        chmodSync(path, 0o600);
      } catch {}
    },
    rollback() {
      if (!committed) return;
      if (existed) {
        writeFileAtomic(path, before);
        try {
          chmodSync(path, 0o600);
        } catch {}
      } else {
        rmSync(path, { force: true });
      }
      committed = false;
    },
  };
}

/**
 * Apply edits to the env file on disk: `.bak-<n>` backup first (same scheme
 * as scripts/lib/config-edit.ts), atomic write, 0600 after. Serialize calls
 * under withConfigMutationLock (config-mutation.ts) like every other setup
 * mutation.
 */
export function applyEnvFileEdits(edits: Record<string, string>): void {
  prepareEnvFileEdits(edits).commit();
}

/** Parse the env file's active definitions. With `includeUnset`, only a
 * web-setup tombstone is represented as an empty string, so example comments
 * remain inert while pending clears override boot-time process.env values. */
export function readEnvFileValues(options?: {
  includeUnset?: boolean;
}): Record<string, string> {
  const path = envFilePath();
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) {
      let value = m[2].trim();
      const quoted = value.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (quoted) {
        value = quoted[1].replace(/\\(.)/g, "$1");
      } else {
        const single = value.match(/^'([^']*)'$/);
        if (single) value = single[1];
      }
      values[m[1]] = value;
      continue;
    }
    if (!options?.includeUnset) continue;
    if (!line.endsWith(WEB_SETUP_UNSET_SUFFIX)) continue;
    const tombstone = line.match(
      /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/,
    );
    if (tombstone && !(tombstone[1] in values)) values[tombstone[1]] = "";
  }
  return values;
}
