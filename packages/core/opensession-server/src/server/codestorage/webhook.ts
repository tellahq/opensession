/**
 * Inbound code.storage webhooks (https://code.storage/docs/guides/webhooks.md).
 *
 * `POST /codestorage/webhook` on the webhook server (registered by
 * CodeStorageIntegration.getRoutes() at boot, and by the setup routes when
 * the integration is connected live from the web UI). Deliveries carry
 * `X-Pierre-Signature: t=<unix_ts>,sha256=<hex>` where the signature is
 * HMAC-SHA256(secret, `${t}.${body}`) — the secret lives at
 * `integrations.codeStorage.webhookSecret`; deliveries are rejected until it
 * is configured (fail-closed).
 *
 * On `push` we drop the PR-host branch cache for the pushed branch of every
 * registered repo backed by that code.storage repo, so branch-review state
 * reacts to external pushes instead of waiting out polling TTLs (mirror of
 * the GitHub flow in pr-webhook.ts, minus the bulk-cache write-through —
 * code.storage payloads carry no PR-shaped data to write through), then
 * broadcast a debounced `pr_updated` so open tabs refetch now.
 * `repo.sync.failed` records a per-repo health warning (cleared by
 * `repo.sync.succeeded`) surfaced by GET /api/setup/codestorage/status, which
 * also reports the last-delivery metadata kept here.
 */

import { createHmac, timingSafeEqual } from "crypto";
import {
  MAX_WEBHOOK_BODY_BYTES,
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../shared/bounded-body";
import { codeStorageConfig, configuredRepos } from "../config";
import { prHostFor } from "../pr-host";
import { invalidateSessionsCache } from "../session-cache";
import { scheduleSandboxEnvironmentInvalidation } from "../sandbox/environments";
import { broadcastToAll } from "../ws-hub";

/** Reject deliveries whose signed timestamp is too far from now (replay cap). */
const TOLERANCE_SECONDS = 300;

export interface CsWebhookDelivery {
  /** ISO timestamp of when we received the delivery. */
  at: string;
  /** `X-Pierre-Event` value ("push", "repo.sync.failed", …). */
  event: string;
  ok: boolean;
  /** Rejection reason when !ok ("invalid signature", …). */
  error?: string;
  /** Pushed ref, for push events. */
  ref?: string;
  /** code.storage repo path from the payload, when present. */
  repo?: string;
}

export interface CsSyncFailure {
  at: string;
  error: string;
}

interface CsWebhookState {
  /** Last delivery that passed signature verification (or, pre-verification,
   *  was at least a well-signed request — never an unauthenticated one). */
  lastDelivery: CsWebhookDelivery | null;
  /** Last REJECTED request (bad/missing signature, secret unset). Kept apart
   *  from lastDelivery: rejections are unauthenticated and attacker-writable,
   *  so they must never overwrite the verified-delivery health the
   *  Connections card reports. */
  lastRejected: CsWebhookDelivery | null;
  rejectedCount: number;
  /** Outstanding repo.sync.failed warnings, keyed by code.storage repo path. */
  syncFailures: Record<string, CsSyncFailure>;
}

// Parked on globalThis like the other live-state modules so a hot reload
// keeps the delivery history.
const state: CsWebhookState = ((globalThis as any).__csWebhookState ??= {
  lastDelivery: null,
  lastRejected: null,
  rejectedCount: 0,
  syncFailures: {},
});
// A hot reload can revive a pre-rejection-tracking state object.
state.lastRejected ??= null;
state.rejectedCount ??= 0;

/** In-memory delivery/health snapshot for GET /api/setup/codestorage/status. */
export function csWebhookState(): CsWebhookState {
  return state;
}

function recordDelivery(delivery: Omit<CsWebhookDelivery, "at">): void {
  state.lastDelivery = { at: new Date().toISOString(), ...delivery };
}

function recordRejection(event: string, error: string): void {
  state.rejectedCount += 1;
  // The event header is attacker-supplied on a rejection — cap it.
  state.lastRejected = {
    at: new Date().toISOString(),
    event: event.slice(0, 64),
    ok: false,
    error,
  };
}

export function verifyCsWebhookSignature(
  body: string,
  header: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const t = header.match(/(?:^|,)t=(\d+)(?:,|$)/)?.[1];
  const sig = header.match(/(?:^|,)sha256=([0-9a-fA-F]+)(?:,|$)/)?.[1];
  if (!t || !sig) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"),
  );
  const provided = Buffer.from(sig.toLowerCase());
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

// A push can land as a burst; coalesce into one broadcast per repo+branch,
// exactly like pr-webhook.ts. Invalidations happen immediately per delivery,
// so the refetch the broadcast triggers always reads post-invalidation state.
const pendingBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();
const BROADCAST_DEBOUNCE_MS = 2_000;

function scheduleCsBroadcast(repoId: string, csRepo: string, branch: string) {
  const key = `${csRepo}\u0000${branch}`;
  if (pendingBroadcasts.has(key)) return;
  pendingBroadcasts.set(
    key,
    setTimeout(() => {
      pendingBroadcasts.delete(key);
      broadcastToAll({ type: "pr_updated", repo: repoId, csRepo, branch });
    }, BROADCAST_DEBOUNCE_MS),
  );
}

export async function handleCsWebhook(req: Request): Promise<Response> {
  const event = req.headers.get("x-pierre-event") || "";
  const secret = codeStorageConfig()?.webhookSecret;
  if (!secret) {
    recordRejection(event, "webhookSecret not configured");
    return Response.json(
      { error: "integrations.codeStorage.webhookSecret is not configured" },
      { status: 503 },
    );
  }
  let body: string;
  try {
    body = await readRequestTextWithinLimit(req, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return webhookBodyTooLargeResponse(MAX_WEBHOOK_BODY_BYTES);
    throw error;
  }
  const signature = req.headers.get("x-pierre-signature") || "";
  if (!verifyCsWebhookSignature(body, signature, secret)) {
    console.error("[codestorage] Invalid webhook signature");
    recordRejection(event, "invalid signature");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: {
    repository?: { id?: string; url?: string };
    ref?: string;
    error?: string;
  };
  try {
    payload = JSON.parse(body);
  } catch {
    recordDelivery({ event, ok: false, error: "invalid JSON payload" });
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  const repoPath = payload.repository?.url;
  const repoInternalId = payload.repository?.id;

  // Sync lifecycle: a failed run is a per-repo health warning until the next
  // successful one (the status endpoint surfaces it).
  if (event === "repo.sync.failed") {
    recordDelivery({
      event,
      ok: true,
      ...(repoPath ? { repo: repoPath } : {}),
    });
    if (repoPath) {
      state.syncFailures[repoPath] = {
        at: new Date().toISOString(),
        error:
          typeof payload.error === "string" ? payload.error : "sync failed",
      };
    }
    return Response.json({ ok: true });
  }
  if (event === "repo.sync.succeeded") {
    recordDelivery({
      event,
      ok: true,
      ...(repoPath ? { repo: repoPath } : {}),
    });
    if (repoPath) delete state.syncFailures[repoPath];
    return Response.json({ ok: true });
  }
  if (event !== "push") {
    recordDelivery({
      event,
      ok: true,
      ...(repoPath ? { repo: repoPath } : {}),
    });
    return Response.json({ ok: true, ignored: event });
  }

  const branch =
    typeof payload.ref === "string"
      ? payload.ref.replace(/^refs\/heads\//, "")
      : "";
  recordDelivery({
    event,
    ok: true,
    ...(typeof payload.ref === "string" ? { ref: payload.ref } : {}),
    ...(repoPath ? { repo: repoPath } : {}),
  });
  if (!branch || (!repoPath && !repoInternalId))
    return Response.json({ ok: true });

  // `repository.url` is the repo path ("acme/widget") — what Repo.csRepo
  // holds; the internal `repository.id` is matched too in case a config used it.
  let matched = false;
  for (const repo of Object.values(configuredRepos())) {
    if (repo.host !== "codestorage" || !repo.csRepo) continue;
    if (repo.csRepo !== repoPath && repo.csRepo !== repoInternalId) continue;
    // Advisory (the cs host owns its caches and the dispatch is
    // fire-and-forget) — the next PR-info read re-fetches the branch diff.
    prHostFor(repo).invalidatePrInfo(repo.csRepo, branch);
    scheduleCsBroadcast(repo.id, repo.csRepo, branch);
    if (branch === repo.defaultBranch)
      scheduleSandboxEnvironmentInvalidation(repo.id);
    matched = true;
  }
  // Session prState enrichment reads through the 2s sessions cache — drop it
  // so sidebar rows catch up on their next poll (GitHub repos untouched:
  // this only ran for a delivery matching a codestorage-hosted repo).
  if (matched) invalidateSessionsCache();
  return Response.json({ ok: true });
}
