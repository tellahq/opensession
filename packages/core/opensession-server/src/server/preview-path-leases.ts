import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60_000;

interface PreviewPathLease {
  id: string;
  key: string;
  sessionId: string;
  path: string;
  acquiredAt: string;
  expiresAt: string;
}

interface PreviewPathLeaseStore {
  version: 1;
  leases: PreviewPathLease[];
}

type PreviewPathLeaseClaim =
  | { ok: true; lease: PreviewPathLease }
  | { ok: false; reason: "in_use" };

interface LeaseStoreOptions {
  file?: string;
  now?: number;
}

function leaseFile(): string {
  return stateDir("preview-path-leases.json");
}

function parseLease(value: unknown): PreviewPathLease {
  if (!value || typeof value !== "object")
    throw new Error("Invalid preview path lease store");
  if (
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("key" in value) ||
    typeof value.key !== "string" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("acquiredAt" in value) ||
    typeof value.acquiredAt !== "string" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string"
  )
    throw new Error("Invalid preview path lease store");
  return {
    id: value.id,
    key: value.key,
    sessionId: value.sessionId,
    path: value.path,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
  };
}

function readStore(file: string): PreviewPathLeaseStore {
  if (!existsSync(file)) return { version: 1, leases: [] };
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("leases" in parsed) ||
    !Array.isArray(parsed.leases)
  )
    throw new Error("Invalid preview path lease store");
  return { version: 1, leases: parsed.leases.map(parseLease) };
}

function writeStore(file: string, leases: PreviewPathLease[]): void {
  writeJsonAtomic(file, { version: 1, leases }, true, 0o600);
}

function normalizedKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 256 || /[\n\r\0]/.test(key))
    throw new Error("Exclusive preview key must be 1 to 256 characters.");
  return key;
}

function ttlMs(minutes?: number): number {
  if (minutes === undefined) return DEFAULT_TTL_MS;
  if (!Number.isFinite(minutes) || minutes < 10 || minutes > 30 * 24 * 60)
    throw new Error(
      "Preview reservations must last between 10 minutes and 30 days.",
    );
  return Math.min(minutes * 60_000, MAX_TTL_MS);
}

/**
 * Reserve one mutable staging record for one session. This is synchronous on
 * purpose: read, conflict check and atomic replacement run without an await,
 * so two tool calls in the active gateway cannot both claim the same key.
 */
export function claimPreviewPathLease(
  input: {
    key: string;
    sessionId: string;
    path: string;
    ttlMinutes?: number;
  },
  options: LeaseStoreOptions = {},
): PreviewPathLeaseClaim {
  const file = options.file ?? leaseFile();
  const now = options.now ?? Date.now();
  const key = normalizedKey(input.key);
  const store = readStore(file);
  const live = store.leases.filter(
    (lease) => Date.parse(lease.expiresAt) > now,
  );
  const conflict = live.find(
    (lease) => lease.key === key && lease.sessionId !== input.sessionId,
  );
  if (conflict) {
    if (live.length !== store.leases.length) writeStore(file, live);
    return { ok: false, reason: "in_use" };
  }

  const existing = live.find(
    (lease) => lease.key === key && lease.sessionId === input.sessionId,
  );
  const lease: PreviewPathLease = {
    id: existing?.id ?? randomUUID(),
    key,
    sessionId: input.sessionId,
    path: input.path,
    acquiredAt: existing?.acquiredAt ?? new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs(input.ttlMinutes)).toISOString(),
  };
  writeStore(file, [
    ...live.filter((candidate) => candidate.sessionId !== input.sessionId),
    lease,
  ]);
  return { ok: true, lease };
}

export function releasePreviewPathLease(
  sessionId: string,
  options: LeaseStoreOptions & { leaseId?: string } = {},
): boolean {
  const file = options.file ?? leaseFile();
  const now = options.now ?? Date.now();
  const store = readStore(file);
  let released = false;
  const leases = store.leases.filter((lease) => {
    if (Date.parse(lease.expiresAt) <= now) return false;
    if (
      lease.sessionId === sessionId &&
      (!options.leaseId || options.leaseId === lease.id)
    ) {
      released = true;
      return false;
    }
    return true;
  });
  if (released || leases.length !== store.leases.length)
    writeStore(file, leases);
  return released;
}
