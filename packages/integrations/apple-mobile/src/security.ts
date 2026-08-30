import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function defaultRoots(): string[] {
  const home = homedir();
  return [
    resolve(home, "dev"),
    resolve(home, ".opensession/worktrees"),
    resolve(home, ".opensession-worktrees"),
    resolve(home, ".opensession-scratch"),
    resolve(home, ".opensession-session-scratch"),
  ];
}

export function allowedRoots(): string[] {
  const configured = process.env.APPLE_MOBILE_ALLOWED_ROOTS;
  const roots = configured
    ? configured
        .split(":")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : defaultRoots();
  return roots.map((root) =>
    existsSync(root) ? realpathSync(root) : resolve(root),
  );
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

export function resolveProjectDir(input: string): string {
  if (!input || typeof input !== "string")
    throw new Error("projectDir is required");
  const candidate = realpathSync(resolve(input));
  if (!allowedRoots().some((root) => isWithin(root, candidate))) {
    throw new Error(
      `Project is outside APPLE_MOBILE_ALLOWED_ROOTS: ${candidate}`,
    );
  }
  return candidate;
}

export function resolveProjectPath(
  projectDir: string,
  input: string,
  options: { mustExist?: boolean } = {},
): string {
  if (!input || isAbsolute(input))
    throw new Error("Paths must be non-empty and project-relative");
  const unresolved = resolve(projectDir, input);
  if (!isWithin(projectDir, unresolved))
    throw new Error(`Path escapes project: ${input}`);

  if (options.mustExist !== false) {
    const candidate = realpathSync(unresolved);
    if (!isWithin(projectDir, candidate))
      throw new Error(`Symlink escapes project: ${input}`);
    return candidate;
  }

  let parent = dirname(unresolved);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const realParent = realpathSync(parent);
  if (!isWithin(projectDir, realParent))
    throw new Error(`Output parent escapes project: ${input}`);
  return unresolved;
}

export function resolvePrivateKeyPath(input: string): string {
  if (!input) throw new Error("APPLE_ASC_PRIVATE_KEY_PATH is required");
  const path = realpathSync(resolve(input));
  const stat = statSync(path);
  if (!stat.isFile())
    throw new Error("APPLE_ASC_PRIVATE_KEY_PATH must be a file");
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      "APPLE_ASC_PRIVATE_KEY_PATH must not be accessible by group or others",
    );
  }
  if (allowedRoots().some((root) => isWithin(root, path))) {
    throw new Error(
      "APPLE_ASC_PRIVATE_KEY_PATH must be outside APPLE_MOBILE_ALLOWED_ROOTS",
    );
  }
  return path;
}

export function redact(value: string): string {
  const secrets = [
    process.env.APPLE_ASC_PRIVATE_KEY_PATH,
    process.env.APPLE_ASC_KEY_ID,
    process.env.APPLE_ASC_ISSUER_ID,
  ].filter((entry): entry is string => Boolean(entry));
  return secrets.reduce(
    (text, secret) => text.split(secret).join("<redacted>"),
    value,
  );
}
