import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { checkPrivateKeyFile, isWithin } from "./private-key";

export { isWithin };

export function resolveProjectDir(input: string): string {
  if (!input || typeof input !== "string")
    throw new Error("projectDir is required");
  return realpathSync(resolve(input));
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

export function resolvePrivateKeyPath(
  input: string,
  projectDir?: string,
): string {
  if (!input) throw new Error("APPLE_ASC_PRIVATE_KEY_PATH is required");
  const path = realpathSync(resolve(input));
  checkPrivateKeyFile(path, statSync(path), projectDir);
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
