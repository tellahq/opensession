/**
 * Per-resource GitHub rate-limit gates.
 *
 * GitHub meters REST (`core`) and GraphQL independently. App installation and
 * App user tokens share those installation buckets, so exhausting GraphQL must
 * pause GraphQL consumers without suppressing healthy REST acknowledgements,
 * metadata reads, comments, or writes. Backoffs survive process restarts.
 */
import { existsSync, readFileSync } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";

const PERSIST_PATH = stateDir("github-limit.json");
export type GithubRateResource = "graphql" | "rest";

interface GhLimitState {
  backoffUntil: Record<GithubRateResource, number>;
  probe: Record<GithubRateResource, Promise<void> | null>;
}

const state: GhLimitState = ((globalThis as any).__osGhLimitStateV2 ||= (() => {
  const s: GhLimitState = {
    backoffUntil: { graphql: 0, rest: 0 },
    probe: { graphql: null, rest: null },
  };
  try {
    if (existsSync(PERSIST_PATH)) {
      const parsed = JSON.parse(readFileSync(PERSIST_PATH, "utf-8"));
      // Migrate the old global gate conservatively to GraphQL. It was almost
      // always set by gh porcelain, and must not keep suppressing healthy REST.
      const saved = parsed?.resources || { graphql: parsed?.backoffUntil };
      for (const resource of ["graphql", "rest"] as const) {
        const until = saved?.[resource];
        if (typeof until === "number" && until > Date.now()) {
          s.backoffUntil[resource] = until;
          console.error(
            `[github-limit] resuming persisted ${resource} backoff until ${new Date(until).toISOString()}`,
          );
        }
      }
    }
  } catch {}
  return s;
})());

function persistBackoff(): void {
  try {
    writeFileAtomic(
      PERSIST_PATH,
      JSON.stringify({ resources: state.backoffUntil }) + "\n",
    );
  } catch {}
}

/** Defaults to GraphQL for existing gh-pr callers. REST callers must opt in. */
export function ghRateLimited(
  resource: GithubRateResource = "graphql",
): boolean {
  return Date.now() < state.backoffUntil[resource];
}

export function ghBackoffUntil(
  resource: GithubRateResource = "graphql",
): number {
  return ghRateLimited(resource) ? state.backoffUntil[resource] : 0;
}

export function __setGhBackoffForTest(
  untilEpochMs: number,
  resource: GithubRateResource = "graphql",
): number {
  const prev = state.backoffUntil[resource];
  state.backoffUntil[resource] = untilEpochMs;
  return prev;
}

export function isGhRateLimitMsg(msg: string): boolean {
  return /rate limit|secondary limit|abuse detection/i.test(msg);
}

/** Record a rejection against only the resource that rejected the request. */
export function noteGhRateLimited(
  source: string,
  resetEpochMs?: number,
  resource: GithubRateResource = "graphql",
): void {
  if (resetEpochMs && resetEpochMs > Date.now()) {
    const until = Math.min(resetEpochMs + 30_000, Date.now() + 2 * 3600_000);
    if (until > state.backoffUntil[resource]) {
      state.backoffUntil[resource] = until;
      persistBackoff();
      console.error(
        `[github-limit] ${source}: ${resource} rate-limited; pausing ${resource} calls until ${new Date(until).toISOString()}`,
      );
    }
    return;
  }
  if (ghRateLimited(resource) || state.probe[resource]) return;
  state.backoffUntil[resource] = Date.now() + 15 * 60_000;
  persistBackoff();
  state.probe[resource] = (async () => {
    try {
      const { githubToken } = await import("./github-app");
      const token = await githubToken();
      if (token) {
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "opensession",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const data = (await response.json().catch(() => null)) as any;
        const key = resource === "rest" ? "core" : "graphql";
        const reset = Number(data?.resources?.[key]?.reset) * 1000;
        if (response.ok && reset > Date.now()) {
          state.backoffUntil[resource] = reset + 30_000;
          persistBackoff();
        }
      }
    } catch {}
    console.error(
      `[github-limit] ${source}: ${resource} rate-limited; pausing ${resource} calls until ${new Date(state.backoffUntil[resource]).toISOString()}`,
    );
    state.probe[resource] = null;
  })();
}

/** Service token for direct REST calls. Repository-specific calls must pass
 * `repo` or `owner` so the token comes from that account's installation.
 * Missing App authority fails closed. */
export async function botGhToken(
  opts: { write?: boolean; repo?: string; owner?: string } = {},
): Promise<string | null> {
  const { githubToken } = await import("./github-app");
  return githubToken(opts);
}
