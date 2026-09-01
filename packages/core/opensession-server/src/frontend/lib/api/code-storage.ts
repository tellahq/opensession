import { request } from "./request";

// ── code.storage connection (Settings → Integrations modal) ─────────────────

export interface CodeStorageDelivery {
  at: string;
  /** X-Pierre-Event value ("push", "repo.sync.failed", …). */
  event: string;
  ok: boolean;
  /** Rejection reason when !ok ("invalid signature", …). */
  error?: string;
  /** Pushed ref, for push events. */
  ref?: string;
  repo?: string;
}

export interface CodeStorageSyncFailure {
  repo: string;
  at: string;
  error: string;
}

export interface CodeStorageWebhookInfo {
  /** Receiver path on the webhook server ("/codestorage/webhook"). */
  path: string;
  /** Webhook server port (loopback; a TLS proxy fronts it). */
  port: number;
  /** HMAC secret to paste into the Pierre dashboard. */
  secret: string;
  lastDelivery: CodeStorageDelivery | null;
  /** Last rejected (unauthenticated) request — tracked apart from verified
   *  deliveries so scanners can't overwrite the delivery health. */
  lastRejected: CodeStorageDelivery | null;
  rejectedCount: number;
  /** Outstanding repo.sync.failed warnings. */
  syncFailures: CodeStorageSyncFailure[];
}

export interface CodeStorageStatus {
  configured: boolean;
  org?: string;
  keyPath?: string;
  repoCount?: number;
  /** Configured but the org probe failed — key not registered or unreachable. */
  error?: string;
  webhook?: CodeStorageWebhookInfo;
}

export async function fetchCodeStorageStatus(): Promise<CodeStorageStatus> {
  return request<CodeStorageStatus>("/setup/codestorage/status", {
    label: "Failed to load code.storage status",
  });
}

/** Validates + stores the key server-side, then probes the org's repo list.
 *  Throws (with the server's precise error) when validation fails. */
export async function connectCodeStorage(
  org: string,
  privateKeyPem: string,
): Promise<{ ok: boolean; org: string; repoCount?: number }> {
  return request("/setup/codestorage/connect", {
    method: "POST",
    body: { org, privateKeyPem },
    label: "code.storage connect failed",
  });
}

/** Removes the integration config; the key file stays on disk (note says where). */
export async function disconnectCodeStorage(): Promise<{
  ok: boolean;
  keyFileKept?: string;
  note?: string;
}> {
  return request("/setup/codestorage/disconnect", {
    method: "POST",
    label: "code.storage disconnect failed",
  });
}
