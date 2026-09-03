/** Lightweight, credential-safe GitHub API budget telemetry. */
import { defaultRepo } from "./config";
import {
  resolveGithubCredential,
  serviceGithubCredential,
} from "./github-auth";

type Sample = { calls: number; failures: number; durationMs: number };
const samples = new Map<string, Sample>();
let lastLogAt = 0;
let probe: Promise<void> | null = null;

/** The GraphQL bucket as a real consumer response reported it. */
export interface GithubGraphqlBucket {
  limit: number;
  used: number;
  remaining: number;
  /** Epoch ms. */
  resetAt: number;
}
let observed: { bucket: GithubGraphqlBucket; at: number } | null = null;

/** Parse the `rateLimit { limit used remaining resetAt }` object a GraphQL
 * consumer adds to its own query. Anything malformed is ignored. */
export function parseGithubGraphqlBucket(
  value: unknown,
): GithubGraphqlBucket | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const limit = Number(record.limit);
  const used = Number(record.used);
  const remaining = Number(record.remaining);
  const resetAt =
    typeof record.resetAt === "string"
      ? Date.parse(record.resetAt)
      : Number(record.resetAt) * 1000;
  if (![limit, used, remaining, resetAt].every(Number.isFinite)) return null;
  return { limit, used, remaining, resetAt };
}

/** The most recent bucket a consumer observed, for health views. */
export function lastObservedGithubGraphqlBucket(): {
  bucket: GithubGraphqlBucket;
  at: number;
} | null {
  return observed;
}

function formatBucket(bucket: GithubGraphqlBucket): string {
  return `remaining=${bucket.remaining}/${bucket.limit} used=${bucket.used} reset=${new Date(bucket.resetAt).toISOString()}`;
}

/**
 * Count a GraphQL consumer and periodically snapshot the installation bucket.
 * Consumers that run their own GraphQL query pass the `rateLimit` object from
 * the response as `bucket`: that is the bucket their credential really spends
 * from, and it is reported ahead of the probe. The probe resolves its token
 * the same way the consumers do, through the service credential for the
 * default repository, rather than a separately selected installation.
 * Logs consumer labels, aggregate timings, and numeric quota only. Tokens,
 * query variables, repository data, and response bodies are never logged.
 */
export function noteGithubGraphqlCall(
  consumer: string,
  durationMs: number,
  ok: boolean,
  opts: { ambient?: boolean; bucket?: unknown } = {},
): void {
  const key = `${opts.ambient ? "ambient" : "service"}:${consumer}`;
  const sample = samples.get(key) || { calls: 0, failures: 0, durationMs: 0 };
  sample.calls++;
  sample.durationMs += Math.max(0, durationMs);
  if (!ok) sample.failures++;
  samples.set(key, sample);
  const bucket = parseGithubGraphqlBucket(opts.bucket);
  if (bucket) observed = { bucket, at: Date.now() };
  if (Date.now() - lastLogAt < 60_000 || probe) return;
  lastLogAt = Date.now();
  probe = (async () => {
    let budget = "probe=unavailable";
    try {
      const credential = await resolveGithubCredential(
        serviceGithubCredential,
        { repo: defaultRepo().ghRepo },
      );
      const token = credential.env.GH_TOKEN;
      if (token) {
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "opensession-budget",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await response.json().catch(() => null)) as any;
        const gql = parseGithubGraphqlBucket({
          ...json?.resources?.graphql,
          resetAt: json?.resources?.graphql?.reset,
        });
        if (response.ok && gql) budget = `probe{${formatBucket(gql)}}`;
      }
    } catch {}
    const seen = observed
      ? `observed{${formatBucket(observed.bucket)} age=${Math.round((Date.now() - observed.at) / 1000)}s}`
      : "observed=none";
    const totals = [...samples.entries()]
      .map(
        ([label, value]) =>
          `${label}{calls=${value.calls},failures=${value.failures},durationMs=${Math.round(value.durationMs)}}`,
      )
      .join(" ");
    console.log(
      `[github-budget] graphql credential=app ${seen} ${budget} consumers=${totals || "none"}`,
    );
    samples.clear();
    probe = null;
  })();
}
