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

import { chmodSync, copyFileSync, existsSync, readFileSync } from "fs";
import { configPath, configuredRepos } from "./config";
import { writeJsonAtomic } from "./shared/atomic-write";

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

/** The raw config.json object, unknown keys preserved. Missing file = {}. */
export function rawConfig(): Record<string, unknown> {
  const path = configPath();
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Local config must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Back up rather than clobber (same `.bak-<n>` scheme as scripts/lib/
 *  config-edit.ts), so a bad write can never lose a working config. */
export function backupFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let n = 1;
  while (existsSync(`${path}.bak-${n}`)) n++;
  const dest = `${path}.bak-${n}`;
  copyFileSync(path, dest);
  return dest;
}

/**
 * Persist config.json: `.bak-<n>` backup first, atomic write, 0600 after —
 * the config carries the team identity table and OAuth client settings, not
 * just ports. Call only from inside withConfigMutationLock.
 */
export function persistRawConfig(config: Record<string, unknown>): void {
  const path = configPath();
  backupFile(path);
  writeJsonAtomic(path, config);
  try {
    chmodSync(path, 0o600);
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
