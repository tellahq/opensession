/**
 * Replay protection for GitHub webhook deliveries.
 *
 * Keep the historical Slack-store path so upgrading a GitHub-only deployment
 * retains delivery IDs that were accepted before webhook ownership moved here.
 */
import { readTextIfExists } from "../../server/shared/async-fs";
import { statePath } from "../../server/paths";
import { coalescedWriter } from "../../server/shared/coalesced-write";

export function githubDeliveriesStore(): string {
  return statePath(".slack-sessions/github-deliveries.json");
}
const GITHUB_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GITHUB_DELIVERIES = 500;
const githubDeliveryExpiry: Map<string, number> = ((
  globalThis as any
).__githubDeliveryExpiry ??= new Map<string, number>());
const githubDeliveriesInFlight: Set<string> = ((
  globalThis as any
).__githubDeliveriesInFlight ??= new Set<string>());
let githubDeliveriesLoad: Promise<void> | undefined;

function pruneGithubDeliveries(now = Date.now()): void {
  for (const [id, expiresAt] of githubDeliveryExpiry) {
    if (expiresAt <= now) githubDeliveryExpiry.delete(id);
  }
  // Map iteration is insertion ordered, so evict the oldest delivery first.
  while (githubDeliveryExpiry.size > MAX_GITHUB_DELIVERIES) {
    const oldest = githubDeliveryExpiry.keys().next().value;
    if (oldest === undefined) break;
    githubDeliveryExpiry.delete(oldest);
  }
}

// Rewritten after every delivery, so the write is async and coalesced: a
// burst of webhooks produces one or two writes, none on the caller's stack.
// A restart in the instant between admission and the write can let GitHub
// redeliver that one event; the in-flight claim still dedupes it live.
const deliveriesWriter = coalescedWriter({
  path: githubDeliveriesStore,
  render: () => JSON.stringify([...githubDeliveryExpiry]),
  label: "github",
});

function persistGithubDeliveries(): void {
  deliveriesWriter.schedule();
}

/** Resolves once every processed delivery so far is on disk. */
export function flushGithubDeliveries(): Promise<void> {
  return deliveriesWriter.flush();
}

/**
 * Restore replay protection once per module lifetime. Checks and writes call
 * this lazily so a webhook accepted before agent startup cannot bypass replay
 * protection. A hot reload safely rehydrates from the atomically persisted file.
 */
export function loadGithubDeliveries(force = false): Promise<void> {
  if (githubDeliveriesLoad && !force) return githubDeliveriesLoad;
  const load = restoreGithubDeliveries();
  githubDeliveriesLoad = load;
  return load;
}

async function restoreGithubDeliveries(): Promise<void> {
  let text: string | undefined;
  try {
    text = await readTextIfExists(githubDeliveriesStore());
  } catch (e) {
    console.error("[github] Failed to load webhook deliveries:", e);
  }
  // Cleared only once the read finished, so a check that awaits this load
  // never sees a half-restored map.
  githubDeliveryExpiry.clear();
  try {
    if (text !== undefined) {
      const entries = JSON.parse(text) as [string, number][];
      const now = Date.now();
      for (const [id, expiresAt] of entries) {
        if (
          typeof id === "string" &&
          Number.isFinite(expiresAt) &&
          expiresAt > now
        ) {
          githubDeliveryExpiry.set(id, expiresAt);
        }
      }
      pruneGithubDeliveries(now);
      persistGithubDeliveries();
    }
  } catch (e) {
    console.error("[github] Failed to load webhook deliveries:", e);
  }
}

/** True if this signed GitHub delivery was already accepted within its TTL. */
export async function isGithubDeliveryProcessed(id: string): Promise<boolean> {
  await loadGithubDeliveries();
  return processedNow(id);
}

function processedNow(id: string): boolean {
  const expiresAt = githubDeliveryExpiry.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    githubDeliveryExpiry.delete(id);
    persistGithubDeliveries();
    return false;
  }
  return true;
}

export type GithubDeliveryClaim = "claimed" | "in_flight" | "processed";

/** Claim one delivery in this process without durably calling it complete yet. */
export async function claimGithubDelivery(
  id: string,
): Promise<GithubDeliveryClaim> {
  await loadGithubDeliveries();
  if (processedNow(id)) return "processed";
  if (githubDeliveriesInFlight.has(id)) return "in_flight";
  githubDeliveriesInFlight.add(id);
  return "claimed";
}

/** Record a signed GitHub delivery after its durable admission step succeeds. */
export async function markGithubDeliveryProcessed(id: string): Promise<void> {
  await loadGithubDeliveries();
  githubDeliveriesInFlight.delete(id);
  githubDeliveryExpiry.set(id, Date.now() + GITHUB_DELIVERY_TTL_MS);
  pruneGithubDeliveries();
  persistGithubDeliveries();
}

export function releaseGithubDelivery(id: string): void {
  githubDeliveriesInFlight.delete(id);
}

let githubWebhooksReceived = 0;

export function incrementGithubWebhooks(): void {
  githubWebhooksReceived++;
}

export function githubWebhookCount(): number {
  return githubWebhooksReceived;
}
