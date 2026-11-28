/**
 * Which catalog models are worth listing under "More models". A model is left
 * out when the catalog already offers something that replaces it:
 *
 * - a newer release of the same family, from any provider (Opus 4.8 beside
 *   Opus 5.5, GLM-5.1 beside GLM-5.3);
 * - the same release from another provider (Kimi K3 from two hosts);
 * - a speed variant of a release that is itself listed ("-fast",
 *   "-highspeed"); Speed is a setting, not another model.
 */

/** Slug suffixes that name a faster serving of the same model. */
const SPEED_SUFFIXES = new Set(["fast", "highspeed", "turbo"]);
/** Leading vendor tokens that are not part of the model's name. */
const VENDOR_TOKENS = new Set(["zai"]);

export interface ModelFamily {
  /** Version-free name, without provider or speed suffix. */
  readonly family: string;
  readonly version: number[];
  /** A faster serving of `family` at `version`. */
  readonly speedVariant: boolean;
}

/** "pi/wafer/glm5.2-fast" → { family: "glm", version: [5, 2], speedVariant }. */
export function modelFamily(id: string): ModelFamily {
  const slug = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  const version: number[] = [];
  const words: string[] = [];
  for (const token of slug.split("-")) {
    const numeric = token.match(/^\d+(?:\.\d+)*$/);
    const tagged = token.match(/^([a-z]+)(\d+(?:\.\d+)*)$/);
    const digits = numeric ? token : tagged?.[2];
    if (digits) version.push(...digits.split(".").map(Number));
    if (tagged) words.push(tagged[1]);
    else if (!numeric && token) words.push(token);
  }
  while (words.length > 1 && VENDOR_TOKENS.has(words[0])) words.shift();
  const speedVariant =
    words.length > 1 && SPEED_SUFFIXES.has(words[words.length - 1]);
  if (speedVariant) words.pop();
  return { family: words.join("-"), version, speedVariant };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * `candidates` without the models something in `catalog` replaces (see the
 * module comment). `keep` rescues a model regardless (the one in use), so the
 * menu always shows what is picked. Of two servings of the same release, the
 * one earlier in `catalog` stays.
 */
export function relevantModels<T extends { id: string }>(
  candidates: readonly T[],
  catalog: readonly { id: string }[],
  keep: (option: T) => boolean = () => false,
): T[] {
  const newest = new Map<string, number[]>();
  const firstServing = new Map<string, string>();
  for (const { id } of catalog) {
    const { family, version, speedVariant } = modelFamily(id);
    if (speedVariant) continue;
    const best = newest.get(family);
    if (!best || compareVersions(version, best) > 0)
      newest.set(family, version);
    const release = `${family}@${version.join(".")}`;
    if (!firstServing.has(release)) firstServing.set(release, id);
  }
  return candidates.filter((option) => {
    if (keep(option)) return true;
    const { family, version, speedVariant } = modelFamily(option.id);
    const best = newest.get(family);
    if (!best) return true;
    const cmp = compareVersions(version, best);
    if (cmp < 0 || (speedVariant && cmp <= 0)) return false;
    if (speedVariant) return true;
    return firstServing.get(`${family}@${version.join(".")}`) === option.id;
  });
}
