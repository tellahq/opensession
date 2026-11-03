import { access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { writeFileAtomicAsync } from "./shared/atomic-write";

export type StableFrontendSnapshot = {
  releaseRoot: string;
  fallbackRoots: string[];
  version: string;
  indexHtml: string;
  publishedAt: string;
};

export function stableFrontendSnapshotPath(deployState: string): string {
  return join(deployState, "stable-frontend.json");
}

const MAX_FALLBACK_ROOTS = 3;

/** The resolved release root when `candidate` lies under the deploy state's
 *  releases directory, else null. Pure: the caller checks the release marker. */
function releaseRootUnder(
  deployState: string,
  candidate: string,
): string | null {
  const releases = resolve(deployState, "releases");
  const root = resolve(candidate);
  return root.startsWith(`${releases}${sep}`) ? root : null;
}

/** The marker file that makes a directory a published release. */
export function releaseMarker(root: string): string {
  return join(root, ".opensession-release");
}

/** Every release root a parsed snapshot file names, for the caller's marker
 *  check. Pure. */
export function snapshotRootCandidates(
  deployState: string,
  value: unknown,
): string[] {
  if (!value || typeof value !== "object") return [];
  const raw = value as Partial<StableFrontendSnapshot>;
  return [
    raw.releaseRoot,
    ...(Array.isArray(raw.fallbackRoots) ? raw.fallbackRoots : []),
  ]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => releaseRootUnder(deployState, candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * Validate a parsed snapshot file. Pure: `isRelease` answers whether a
 * resolved root carries its release marker, so the gateway (async) and the
 * stable ingress process (its own thread) share one rule.
 */
export function normalizeStableFrontendSnapshot(
  deployState: string,
  parsed: unknown,
  isRelease: (root: string) => boolean,
): StableFrontendSnapshot | null {
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<StableFrontendSnapshot>;
  const validReleaseRoot = (candidate: string): string | null => {
    const root = releaseRootUnder(deployState, candidate);
    return root && isRelease(root) ? root : null;
  };
  if (
    typeof value.releaseRoot !== "string" ||
    typeof value.version !== "string" ||
    typeof value.indexHtml !== "string" ||
    typeof value.publishedAt !== "string"
  )
    return null;
  const root = validReleaseRoot(value.releaseRoot);
  if (!root) return null;
  const fallbackRoots = Array.isArray(value.fallbackRoots)
    ? value.fallbackRoots
        .filter(
          (candidate): candidate is string => typeof candidate === "string",
        )
        .map(validReleaseRoot)
        .filter((candidate): candidate is string => Boolean(candidate))
        .filter(
          (candidate, index, roots) =>
            candidate !== root && roots.indexOf(candidate) === index,
        )
        .slice(0, MAX_FALLBACK_ROOTS)
    : [];
  return {
    ...value,
    releaseRoot: root,
    fallbackRoots,
  } as StableFrontendSnapshot;
}

async function existingReleases(roots: string[]): Promise<Set<string>> {
  const found = await Promise.all(
    roots.map((root) =>
      access(releaseMarker(root)).then(
        () => root,
        () => null,
      ),
    ),
  );
  return new Set(found.filter((root): root is string => Boolean(root)));
}

async function readSnapshot(
  deployState: string,
): Promise<StableFrontendSnapshot | null> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(stableFrontendSnapshotPath(deployState)).json();
  } catch {
    return null;
  }
  const releases = await existingReleases(
    snapshotRootCandidates(deployState, parsed),
  );
  return normalizeStableFrontendSnapshot(deployState, parsed, (root) =>
    releases.has(root),
  );
}

export async function publishStableFrontendSnapshot(
  deployState: string,
  snapshot: Omit<StableFrontendSnapshot, "publishedAt" | "fallbackRoots"> & {
    fallbackRoots?: string[];
  },
): Promise<StableFrontendSnapshot> {
  const previous = await readSnapshot(deployState);
  const candidates = [
    ...(snapshot.fallbackRoots ?? []),
    ...(previous ? [previous.releaseRoot, ...previous.fallbackRoots] : []),
  ]
    .map((candidate) => releaseRootUnder(deployState, candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
  const releases = await existingReleases(candidates);
  const fallbackRoots = candidates
    .filter((root) => releases.has(root))
    .filter(
      (root, index, roots) =>
        root !== resolve(snapshot.releaseRoot) && roots.indexOf(root) === index,
    )
    .slice(0, MAX_FALLBACK_ROOTS);
  const published: StableFrontendSnapshot = {
    ...snapshot,
    fallbackRoots,
    publishedAt: new Date().toISOString(),
  };
  await writeFileAtomicAsync(
    stableFrontendSnapshotPath(deployState),
    `${JSON.stringify(published)}\n`,
    0o600,
  );
  return published;
}
