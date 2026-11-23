/**
 * Whether a merged PR has reached production, so its preview link can hand
 * over to the production site.
 *
 * A merged PR keeps pointing at its preview environment (the branch alias
 * still serves the merged change) until the repo's production deploy carries
 * the merge commit. Then the link points at the production site instead.
 *
 * Configured under `integrations.github`:
 * - `productionEnvironment`: the GitHub deployment environment production
 *   deploys report to (e.g. "Production – acme").
 * - `productionUrl`: the production site's origin (e.g. https://acme.example).
 *
 * "Deployed" means the merge commit is the commit of the environment's latest
 * successful deployment, or an ancestor of it: a later deploy that includes
 * the merge counts too, so a release that skipped this exact commit is not
 * mistaken for "never deployed".
 *
 * Read at serve time, never stored in the details cache: the details cache
 * lives for minutes and the handover should land on the next poll. The
 * environment's latest deploy is cached per repo for a short time, shared by
 * every merged PR of that repo; an ancestry answer is cached per pair of
 * commits, and a "yes" is permanent.
 */
import { configuredIntegration } from "./config";
import { githubInstallationCredential } from "./github-app";
import { ghRateLimited } from "./github-limit";
import type { PrDetails, PrStaging } from "./pr-contract";

export interface ProductionDeployConfig {
  environment: string;
  url: string;
}

export function productionDeployConfig(): ProductionDeployConfig | null {
  const github = configuredIntegration("github");
  const environment = github.productionEnvironment;
  const url = github.productionUrl;
  if (typeof environment !== "string" || !environment.trim()) return null;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  return { environment: environment.trim(), url: url.trim() };
}

type Read = <T>(
  repo: string,
  path: string,
) => Promise<{ ok: boolean; data: T | null }>;

/** One read-only REST call on the repo's installation. Any failure, including
 *  a known rate-limit window, reads as not ok. */
const githubRead: Read = async <T>(repo: string, path: string) => {
  const failed = { ok: false, data: null };
  const credential = await githubInstallationCredential({ repo });
  if (!credential || (await ghRateLimited("rest", credential))) return failed;
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opensession",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return failed;
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return failed;
  }
};

/** How long the environment's latest deploy is trusted before asking again. */
const LATEST_TTL_MS = 60_000;
/** Deployments looked at, newest first, for one that succeeded. */
const LATEST_SCAN = 5;
const ANCESTRY_CACHE_LIMIT = 2000;

const latestCache = new Map<string, { sha: string | null; ts: number }>();
const latestInflight = new Map<string, Promise<string | null>>();
const ancestryCache = new Map<string, boolean>();

/** The commit of the environment's latest successful deployment. */
async function latestDeployedSha(
  repo: string,
  environment: string,
  read: Read,
): Promise<string | null> {
  const key = `${repo}\n${environment}`;
  const hit = latestCache.get(key);
  if (hit && Date.now() - hit.ts < LATEST_TTL_MS) return hit.sha;
  let pending = latestInflight.get(key);
  if (!pending) {
    pending = (async () => {
      const list = await read<Array<{ id: number; sha: string }>>(
        repo,
        `/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${LATEST_SCAN}`,
      );
      // A failed read keeps the last answer rather than flipping a deployed
      // PR back to its preview.
      if (!list.ok || !Array.isArray(list.data)) return hit?.sha ?? null;
      for (const deployment of list.data) {
        const statuses = await read<Array<{ state: string }>>(
          repo,
          `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
        );
        if (!statuses.ok) return hit?.sha ?? null;
        if (statuses.data?.[0]?.state === "success") return deployment.sha;
      }
      return null;
    })()
      .then((sha) => {
        latestCache.set(key, { sha, ts: Date.now() });
        return sha;
      })
      .finally(() => latestInflight.delete(key));
    latestInflight.set(key, pending);
  }
  return pending;
}

/** Whether `commit` is `deployed` or one of its ancestors. */
async function includedIn(
  repo: string,
  commit: string,
  deployed: string,
  read: Read,
): Promise<boolean> {
  if (commit === deployed) return true;
  const key = `${repo}\n${commit}\n${deployed}`;
  const known = ancestryCache.get(key);
  if (known !== undefined) return known;
  const compare = await read<{ status?: string }>(
    repo,
    `/repos/${repo}/compare/${commit}...${deployed}?per_page=1`,
  );
  if (!compare.ok) return false;
  const included =
    compare.data?.status === "ahead" || compare.data?.status === "identical";
  if (ancestryCache.size >= ANCESTRY_CACHE_LIMIT) ancestryCache.clear();
  ancestryCache.set(key, included);
  return included;
}

/**
 * For a merged PR whose change is in production, swap its preview link for
 * the production site; until then, mark the preview as waiting on it, which
 * is what keeps clients asking. Everything else passes through untouched,
 * including a merged PR that never had a preview (it changed nothing the site
 * serves) and every PR on an instance without a production environment.
 */
export async function withProductionDeploy(
  data: PrDetails | null,
  repo: string,
  {
    read = githubRead,
    config: readConfig = productionDeployConfig,
  }: { read?: Read; config?: () => ProductionDeployConfig | null } = {},
): Promise<PrDetails | null> {
  if (!data || data.state !== "MERGED" || !data.staging) return data;
  if (data.staging.production) return data;
  const config = readConfig();
  const merge = data.mergeCommitOid;
  if (!config || !merge) return data;
  try {
    const deployed = await latestDeployedSha(repo, config.environment, read);
    if (!deployed || !(await includedIn(repo, merge, deployed, read)))
      return {
        ...data,
        staging: { ...data.staging, awaitingProduction: true },
      };
  } catch (e) {
    console.warn(`[pr-production-deploy] ${repo}: ${String(e)}`);
    return { ...data, staging: { ...data.staging, awaitingProduction: true } };
  }
  const production: PrStaging = {
    url: config.url,
    status: "Ready",
    live: true,
    production: true,
  };
  return { ...data, staging: production };
}

export function __resetProductionDeployForTest(): void {
  latestCache.clear();
  latestInflight.clear();
  ancestryCache.clear();
}
