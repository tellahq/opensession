/**
 * Sandbox preview HTTPS-port allocator — the fix for the (former)
 * TODO(sandbox-preview-collision) in preview.ts.
 *
 * Host previews expose a webapp at Caddy https port `webappPort + 6000`
 * (webapp ports 3100-3999 → https 9100-9999). That's collision-free on the
 * host because the repo's own port allocator enforces webapp-port
 * uniqueness with lsof — but a SANDBOXED dev server's webapp port lives in
 * the container's private netns, where the host allocator can't see it: a
 * host session and a sandbox (or two sandboxes) can hold the same webapp
 * port number, and deriving the https port from that number would make both
 * claim the same Caddy route.
 *
 * So sandbox routes are namespaced by construction:
 *
 *  - Their https ports come from a dedicated range [20000, 28000) that the
 *    host scheme (9100-9999) can never compute — host-vs-sandbox collisions
 *    are structurally impossible.
 *  - Within the range, each (sandboxId, containerPort) pair gets an ALLOCATED
 *    port: deterministic first guess (FNV-1a of the key), then a linear probe
 *    past any port already held by a DIFFERENT key — sandbox-vs-sandbox
 *    collisions are impossible because the allocator never hands out a port
 *    twice.
 *  - Allocations persist in <sessions-dir>/sandbox-preview-ports.json so
 *    the preview URL is stable across opensession restarts and container
 *    recreations; they're released by DockerProvider.destroy().
 *
 * Single-writer by design (the one opensession process); the verify suite's
 * separate process cleans its own sbxtest-* entries.
 */

import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { writeJsonAtomic } from "../shared/atomic-write";

export const SANDBOX_HTTPS_BASE = 20000;
export const SANDBOX_HTTPS_RANGE = 8000;

/** `<sandboxId>:<containerPort>` → allocated https port. */
type AllocationMap = Record<string, number>;

// OPENSESSION_SESSIONS_DIR is a live binding (test seam) — resolve per call.
function allocationsPath(): string {
  return `${OPENSESSION_SESSIONS_DIR}/sandbox-preview-ports.json`;
}

function readAllocations(): AllocationMap {
  try {
    if (!existsSync(allocationsPath())) return {};
    const raw = JSON.parse(readFileSync(allocationsPath(), "utf-8"));
    const out: AllocationMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" && Number.isInteger(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function keyFor(sandboxId: string, containerPort: number): string {
  return `${sandboxId}:${containerPort}`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The https port for a sandbox's published container port — allocated on
 * first use, stable afterwards. Deterministic start + linear probe over the
 * persisted map; throws only when the whole 8000-port range is exhausted.
 */
export function sandboxHttpsPortFor(
  sandboxId: string,
  containerPort: number,
): number {
  const map = readAllocations();
  const key = keyFor(sandboxId, containerPort);
  const existing = map[key];
  if (existing != null) return existing;
  const used = new Set(Object.values(map));
  const start = fnv1a(key) % SANDBOX_HTTPS_RANGE;
  for (let i = 0; i < SANDBOX_HTTPS_RANGE; i++) {
    const port = SANDBOX_HTTPS_BASE + ((start + i) % SANDBOX_HTTPS_RANGE);
    if (used.has(port)) continue;
    map[key] = port;
    writeJsonAtomic(allocationsPath(), map);
    return port;
  }
  throw new Error(
    "sandbox preview https-port range exhausted (20000-27999 all allocated)",
  );
}

/** Existing allocation only, never allocates (stop/teardown paths). */
export function lookupSandboxHttpsPort(
  sandboxId: string,
  containerPort: number,
): number | null {
  return readAllocations()[keyFor(sandboxId, containerPort)] ?? null;
}

/** Reverse an existing allocation so the authenticated Portal route can
 * rebuild its process-local relay after an Open Session restart. */
export function sandboxAllocationForHttpsPort(
  httpsPort: number,
): { sandboxId: string; containerPort: number } | null {
  for (const [key, allocated] of Object.entries(readAllocations())) {
    if (allocated !== httpsPort) continue;
    const split = key.lastIndexOf(":");
    const sandboxId = key.slice(0, split);
    const containerPort = Number(key.slice(split + 1));
    if (sandboxId && Number.isInteger(containerPort))
      return { sandboxId, containerPort };
  }
  return null;
}

/**
 * Drop every allocation of a sandbox (DockerProvider.destroy / verify
 * cleanup). Returns the released https ports so the caller can remove their
 * Caddy routes.
 */
export function releaseSandboxPreviewPorts(sandboxId: string): number[] {
  const map = readAllocations();
  const released: number[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(`${sandboxId}:`)) {
      released.push(v);
      delete map[k];
    }
  }
  if (released.length) writeJsonAtomic(allocationsPath(), map);
  return released;
}
