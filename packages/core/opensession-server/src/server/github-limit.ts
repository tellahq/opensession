/** GitHub quotas are independent per installation and API resource. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeFileAtomicAsync } from "./shared/atomic-write";
import { stateDir } from "./paths";
import type { GithubCredential } from "./github-auth";
import type { GithubInstallationCredential } from "./github-app";

export type GithubRateResource = "graphql" | "rest";
type Resources = Record<GithubRateResource, number>;
type Scope = GithubInstallationCredential | { repo?: string; owner?: string };

/** User tokens have their own quota, not the repository's installation quota.
 * Unknown pre-materialized credentials are isolated by a non-secret digest. */
export function ghCredentialScope(
  credential: GithubCredential,
): GithubInstallationCredential {
  const token = credential.env.GH_TOKEN || "";
  return {
    token,
    rateLimitKey:
      credential.rateLimitKey ||
      (credential.kind === "user"
        ? credential.principal
        : `credential:${createHash("sha256").update(token).digest("hex")}`),
  };
}

/** Lazy async persistence: no gateway I/O at import or synchronous fallback. */
export class GithubRateLimits {
  private resources = new Map<string, Resources>();
  private probes = new Map<string, Promise<void>>();
  private loaded: Promise<void> | undefined;
  private writes = Promise.resolve();

  constructor(private readonly path: string) {}

  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.path, "utf8"));
        // Legacy global files cannot identify which installation was exhausted.
        // Do not attribute their quota to an arbitrary current default.
        if (parsed?.version !== 3 || !parsed.installations) return;
        for (const [key, saved] of Object.entries(parsed.installations)) {
          const resources: Resources = { graphql: 0, rest: 0 };
          for (const resource of ["graphql", "rest"] as const) {
            const until = (saved as Partial<Resources> | null)?.[resource];
            if (
              typeof until === "number" &&
              Number.isFinite(until) &&
              until > Date.now()
            ) {
              resources[resource] = Math.min(until, Date.now() + 2 * 3600_000);
            }
          }
          if (resources.graphql || resources.rest)
            this.resources.set(key, resources);
        }
      } catch {}
    })());
  }

  private persist(): Promise<void> {
    // Serialize snapshots so a slower earlier write cannot overwrite a newer one.
    this.writes = this.writes
      .then(async () => {
        const installations = Object.fromEntries(
          [...this.resources].filter(
            ([, r]) => r.graphql > Date.now() || r.rest > Date.now(),
          ),
        );
        await writeFileAtomicAsync(
          this.path,
          JSON.stringify({ version: 3, installations }) + "\n",
        );
      })
      .catch(() => {});
    return this.writes;
  }

  async backoff(
    resource: GithubRateResource,
    credential: GithubInstallationCredential,
  ): Promise<number> {
    await this.load();
    const until = this.resources.get(credential.rateLimitKey)?.[resource] || 0;
    return until > Date.now() ? until : 0;
  }

  async note(
    source: string,
    resetEpochMs: number | undefined,
    resource: GithubRateResource,
    credential: GithubInstallationCredential,
  ): Promise<void> {
    await this.load();
    if (!credential.token) return;
    const key = credential.rateLimitKey;
    let resources = this.resources.get(key);
    if (!resources) {
      resources = { graphql: 0, rest: 0 };
      this.resources.set(key, resources);
    }
    const clamp = (reset: number) =>
      Math.min(reset + 30_000, Date.now() + 2 * 3600_000);
    const log = () =>
      console.error(
        `[github-limit] ${source}: ${resource} rate-limited; pausing this credential until ${new Date(resources[resource]).toISOString()}`,
      );
    if (
      resetEpochMs &&
      Number.isFinite(resetEpochMs) &&
      resetEpochMs > Date.now()
    ) {
      resources[resource] = Math.max(resources[resource], clamp(resetEpochMs));
      await this.persist();
      log();
      return;
    }
    const probeKey = `${key}:${resource}`;
    if (resources[resource] > Date.now() || this.probes.has(probeKey)) return;
    const fallback = Date.now() + 15 * 60_000;
    resources[resource] = fallback;
    const probe = (async () => {
      await this.persist();
      try {
        // Use the exact rejected credential, never mint the default's token.
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `Bearer ${credential.token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "opensession",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const data = (await response.json().catch(() => null)) as any;
        const reset =
          Number(
            data?.resources?.[resource === "rest" ? "core" : "graphql"]?.reset,
          ) * 1000;
        if (response.ok && Number.isFinite(reset) && reset > Date.now()) {
          // A header-based rejection arriving during the probe is authoritative.
          resources[resource] =
            resources[resource] === fallback
              ? clamp(reset)
              : Math.max(resources[resource], clamp(reset));
          await this.persist();
        }
      } catch {}
      log();
    })().finally(() => this.probes.delete(probeKey));
    this.probes.set(probeKey, probe);
    // The fallback is already active. Do not hold the rejected request (or
    // its PR lock) while the advisory reset probe waits on GitHub.
    void probe;
  }

  /** Tests can drain detached probes before restoring fetch or deleting state. */
  async waitForProbesForTest(): Promise<void> {
    await Promise.all(this.probes.values());
  }
}

const g = globalThis as typeof globalThis & {
  __osGhLimitStateV3?: GithubRateLimits;
};
const state = (g.__osGhLimitStateV3 ??= new GithubRateLimits(
  stateDir("github-limit.json"),
));
const testBackoff: Resources = { graphql: 0, rest: 0 };

async function resolveScope(
  scope: Scope,
): Promise<GithubInstallationCredential | null> {
  if ("token" in scope) return scope;
  const { githubInstallationCredential } = await import("./github-app");
  return githubInstallationCredential(scope);
}

/** Omitted selectors retain configured-default / single-installation behavior. */
export async function ghRateLimited(
  resource: GithubRateResource = "graphql",
  scope: Scope = {},
): Promise<boolean> {
  return (await ghBackoffUntil(resource, scope)) > Date.now();
}

export async function ghBackoffUntil(
  resource: GithubRateResource = "graphql",
  scope: Scope = {},
): Promise<number> {
  if (testBackoff[resource] > Date.now()) return testBackoff[resource];
  const credential = await resolveScope(scope);
  return credential ? state.backoff(resource, credential) : 0;
}

export function __setGhBackoffForTest(
  untilEpochMs: number,
  resource: GithubRateResource = "graphql",
): number {
  const prev = testBackoff[resource];
  testBackoff[resource] = untilEpochMs;
  return prev;
}

export async function __waitForGhProbesForTest(): Promise<void> {
  await state.waitForProbesForTest();
}

export function isGhRateLimitMsg(msg: string): boolean {
  return /rate limit|secondary limit|abuse detection/i.test(msg);
}

/** A rejection must carry the credential that actually made the request. */
export async function noteGhRateLimited(
  source: string,
  resetEpochMs: number | undefined,
  resource: GithubRateResource,
  credential: GithubInstallationCredential,
): Promise<void> {
  await state.note(source, resetEpochMs, resource, credential);
}

export async function botGhToken(
  opts: { write?: boolean; repo?: string; owner?: string } = {},
): Promise<string | null> {
  const { githubToken } = await import("./github-app");
  return githubToken(opts);
}
