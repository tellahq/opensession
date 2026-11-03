/**
 * Serialized mutation of the instance config.json (and the secrets env file).
 *
 * Every write to config.json — repo registration (routes/local-repos.ts,
 * routes/setup-repos.ts), server origins, team roster edits, integration
 * toggles, and GitHub auth settings — funnels through ONE promise-chain lock so
 * concurrent read-modify-write cycles can't clobber each other. The chain is
 * parked on globalThis (under the key the local-repos lock historically used)
 * so a bun --hot reload keeps the same queue.
 *
 * `rawConfig()` reads the RAW file — not the tolerant typed parse in
 * config.ts — so a targeted mutation preserves unknown keys verbatim.
 */

import { configPath, configuredRepos, publishConfigSnapshot } from "./config";
import { chmod, copyFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { writeFileAtomicAsync } from "./shared/atomic-write";

const mutationState: { chain: Promise<unknown> } = ((
  globalThis as any
).__localRepoMutationState ??= { chain: Promise.resolve() });

/** Serialize a config/env mutation behind every other pending one. */
export function withConfigMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationState.chain.then(fn, fn);
  mutationState.chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** The raw config.json object, unknown keys preserved. Missing file = {}.
 * Fails closed on unreadable or malformed configuration. */
export function rawConfig(): Promise<Record<string, unknown>> {
  return rawConfigAsync();
}

/** Request-path reader: fail closed on unreadable or malformed configuration. */
export async function rawConfigAsync(): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Local config must contain a JSON object");
  }
  return parsed;
}

/** Async config persistence under the same mutation lock as setup routes.
 * Publish only after the atomic rename; a failed write must not admit a user. */
export async function persistRawConfigAsync(
  config: Record<string, unknown>,
): Promise<void> {
  const path = configPath();
  await backupFile(path);
  const contents = JSON.stringify(config, null, 2) + "\n";
  await writeFileAtomicAsync(path, contents, 0o600);
  publishConfigSnapshot(path, contents);
}

/** Back up rather than clobber (same `.bak-<n>` scheme as scripts/lib/
 *  config-edit.ts), so a bad write can never lose a working config. */
export async function backupFile(path: string): Promise<string | undefined> {
  for (let n = 1; ; n++) {
    const dest = `${path}.bak-${n}`;
    try {
      await copyFile(path, dest, constants.COPYFILE_EXCL);
      return dest;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }
}

/**
 * Persist config.json: `.bak-<n>` backup first, atomic write, 0600 after —
 * the config carries the team identity table and OAuth client settings, not
 * just ports. Call only from inside withConfigMutationLock.
 */
export async function persistRawConfig(
  config: Record<string, unknown>,
): Promise<void> {
  const path = configPath();
  await backupFile(path);
  const contents = JSON.stringify(config, null, 2);
  await writeFileAtomicAsync(path, contents);
  publishConfigSnapshot(path, contents);
  try {
    await chmod(path, 0o600);
  } catch {}
}

/**
 * Return one raw repository section for mutation without changing the meaning
 * of the registry. When the instance still uses its implicit built-in repos,
 * materialize the full resolved set first because a raw `repos` object is
 * authoritative rather than additive.
 *
 * Call only from inside withConfigMutationLock.
 */
export function repoSectionForMutation(
  config: Record<string, unknown>,
  id: string,
): Record<string, unknown> | null {
  const resolvedRepos = configuredRepos();
  if (!Object.hasOwn(resolvedRepos, id)) return null;

  const repos = reposForMutation(config, resolvedRepos);
  const existing = Object.hasOwn(repos, id) ? repos[id] : undefined;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }

  const { id: _id, ...section } = resolvedRepos[id];
  repos[id] = section;
  return section;
}

/** Materialize the effective registry before adding or changing raw entries. */
export function reposForMutation(
  config: Record<string, unknown>,
  resolvedRepos = configuredRepos(),
): Record<string, unknown> {
  let repos: Record<string, unknown>;
  if (
    config.repos &&
    typeof config.repos === "object" &&
    !Array.isArray(config.repos)
  ) {
    repos = config.repos as Record<string, unknown>;
  } else {
    repos = Object.fromEntries(
      Object.values(resolvedRepos).map((repo) => {
        const { id: _id, ...section } = repo;
        return [repo.id, section];
      }),
    );
    config.repos = repos;
  }
  return repos;
}
