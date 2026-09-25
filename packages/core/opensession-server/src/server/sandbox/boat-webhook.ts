/**
 * Boat lifecycle webhooks (https://docs.boat.dev/webhooks).
 *
 * Boat stops a Sandbox on its own idle timer and can bring one back without
 * this server asking. Until now Open Session learned about either only on
 * its next call, so a session kept saying `awake` over a stopped machine,
 * and a machine that came back had no Portals until someone opened one.
 *
 * Every event is a hint, never the truth: deliveries repeat and arrive out
 * of order. The handler verifies the signature, drops repeats by delivery
 * id, answers 204 at once (Boat gives up after 5 seconds), and then asks
 * Boat for the machine's current state on the session's lifecycle lane
 * before it changes anything. Polling stays the fallback for a lost event.
 *
 *   sandbox.archived  the machine stopped: record `sleeping` and withdraw its
 *                     relays, so opening a Portal shows the waiting page and
 *                     wakes it instead of hitting a dead one.
 *   sandbox.ready     the machine is up: record `awake` and relaunch the
 *                     workspace's dead Portals, which warm their pages.
 *   sandbox.error     logged with the session it belongs to.
 *   sandbox.hydrated  the lazily restored disk is complete: a Portal start
 *                     waiting for it (box-hydration.ts) goes ahead.
 *
 * Machines are matched through their state file (one read, no scan). A
 * prewarmed standby has no session yet and is ignored.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { PortalSandboxRecord } from "../types";
import type { PublicWebhookHandler } from "../webhook-server";
import { resolveWorkspaceSecretAsync } from "../workspace-secrets";

export const BOAT_WEBHOOK_PATH = "/sandbox-webhooks/boat";
/** Workspace secret holding the endpoint's `whsec_` signing secret. */
export const BOAT_WEBHOOK_SECRET_REF = "sandbox.box.webhook";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SKEW_SECONDS = 300;
const SECRET_CACHE_MS = 30_000;
/** Let a wake this server started claim the lifecycle lane first. */
const READY_SETTLE_MS = 3_000;

export type BoatWebhookEvent = {
  id: string;
  type: string;
  createdAt?: string;
  data: {
    sandbox: { id: string; name?: string };
    previousState?: string;
    state?: string;
  };
};

/** Boat's scheme: HMAC-SHA256(secret, `${delivery}.${timestamp}.${body}`),
 * sent as `v1=<hex>`, with a timestamp within five minutes. */
export function verifyBoatSignature(input: {
  body: Uint8Array;
  delivery: string;
  timestamp: string;
  signature: string;
  secret: string;
  nowSeconds?: number;
}): boolean {
  const issuedAt = Number(input.timestamp);
  const now = input.nowSeconds ?? Date.now() / 1000;
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > MAX_SKEW_SECONDS)
    return false;
  const supplied = input.signature.replace(/^v1=/, "");
  if (!/^[a-f0-9]{64}$/i.test(supplied) || !input.delivery) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.delivery}.${input.timestamp}.`)
    .update(input.body)
    .digest();
  return timingSafeEqual(Buffer.from(supplied, "hex"), expected);
}

export function parseBoatWebhookEvent(raw: string): BoatWebhookEvent | null {
  try {
    const event = JSON.parse(raw);
    const sandboxId = event?.data?.sandbox?.id;
    if (
      typeof event?.id !== "string" ||
      typeof event?.type !== "string" ||
      typeof sandboxId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(sandboxId)
    )
      return null;
    return event as BoatWebhookEvent;
  } catch {
    return null;
  }
}

/** Delivery ids seen recently; Boat retries for well under an hour. */
const seen = new Map<string, number>();
const SEEN_TTL_MS = 60 * 60_000;
const SEEN_MAX = 5_000;

export function firstDelivery(id: string, now = Date.now()): boolean {
  const at = seen.get(id);
  if (at !== undefined && now - at < SEEN_TTL_MS) return false;
  seen.set(id, now);
  if (seen.size > SEEN_MAX)
    for (const [key, when] of seen) {
      if (now - when < SEEN_TTL_MS && seen.size <= SEEN_MAX) break;
      seen.delete(key);
    }
  return true;
}

let cachedSecret: { value: string; at: number } | undefined;

/** Cached briefly once found; a missing one is looked up again next time,
 * so a secret stored while Boat retries takes effect on the next attempt. */
async function signingSecret(): Promise<string | undefined> {
  if (cachedSecret && Date.now() - cachedSecret.at < SECRET_CACHE_MS)
    return cachedSecret.value;
  const value = await resolveWorkspaceSecretAsync(BOAT_WEBHOOK_SECRET_REF);
  cachedSecret = value ? { value, at: Date.now() } : undefined;
  return value;
}

const handleBoatWebhook: PublicWebhookHandler = async (req) => {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return new Response(null, { status: 413 });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES)
    return new Response(null, { status: 413 });
  const secret = await signingSecret();
  // Not configured yet: Boat retries, so nothing is lost while it is set up.
  if (!secret) return new Response(null, { status: 503 });
  const delivery = req.headers.get("x-ascii-delivery") || "";
  if (
    !verifyBoatSignature({
      body,
      delivery,
      timestamp: req.headers.get("x-ascii-timestamp") || "",
      signature: req.headers.get("x-ascii-signature") || "",
      secret,
    })
  )
    return new Response(null, { status: 401 });
  if (!firstDelivery(delivery)) return new Response(null, { status: 204 });
  const event = parseBoatWebhookEvent(new TextDecoder().decode(body));
  if (!event) return new Response(null, { status: 204 });
  void applyBoatEvent(event).catch((error) =>
    console.warn(
      `[sandbox:boat] webhook ${event.type} for ${event.data.sandbox.id} failed:`,
      error instanceof Error ? error.message : String(error),
    ),
  );
  return new Response(null, { status: 204 });
};

export function boatWebhookRoutes(): Map<string, PublicWebhookHandler> {
  return new Map([[`POST ${BOAT_WEBHOOK_PATH}`, handleBoatWebhook]]);
}

/** Which session record a Boat machine belongs to, from its state file. */
async function ownerOf(sandboxId: string): Promise<{
  sessionId: string;
  role: "workspace" | "portal";
} | null> {
  const { readRemoteStateAsync } = await import("./adapters/bootstrap");
  const state = await readRemoteStateAsync("box", sandboxId);
  if (!state?.sessionId) return null;
  return state.sessionId.endsWith("--portals")
    ? {
        sessionId: state.sessionId.slice(0, -"--portals".length),
        role: "portal",
      }
    : { sessionId: state.sessionId, role: "workspace" };
}

async function applyBoatEvent(event: BoatWebhookEvent): Promise<void> {
  const sandboxId = event.data.sandbox.id;
  const owner = await ownerOf(sandboxId);
  const transition =
    event.data.previousState || event.data.state
      ? ` (${event.data.previousState ?? "?"} -> ${event.data.state ?? "?"})`
      : "";
  console.log(
    `[sandbox:boat] ${event.type} ${sandboxId}${transition}${owner ? ` for ${owner.sessionId}${owner.role === "portal" ? " (Portal Sandbox)" : ""}` : ""}`,
  );
  if (event.type === "sandbox.hydrated") {
    const { noteBoxHydrated } = await import("./box-hydration");
    noteBoxHydrated(sandboxId);
  }
  if (!owner) return;
  if (event.type === "sandbox.archived") await markAsleep(sandboxId, owner);
  else if (event.type === "sandbox.ready") {
    await Bun.sleep(READY_SETTLE_MS);
    await markAwake(sandboxId, owner);
  }
}

type Owner = { sessionId: string; role: "workspace" | "portal" };

async function currentRecord(sandboxId: string, owner: Owner) {
  const { findSessionAsync } = await import("../session-cache");
  const session = await findSessionAsync(owner.sessionId);
  const record =
    owner.role === "workspace" ? session?.sandbox : session?.portalSandbox;
  if (!session || record?.sandboxId !== sandboxId) return null;
  return { session, record };
}

async function machineStatus(
  sandboxId: string,
): Promise<"running" | "stopped" | "gone"> {
  const { getSandboxProvider } = await import("./index");
  const sandbox = await getSandboxProvider("box").get(sandboxId);
  return sandbox ? await sandbox.status() : "gone";
}

async function persist(
  owner: Owner,
  record: PortalSandboxRecord,
  lifecycle: "awake" | "sleeping",
): Promise<void> {
  const { touchNativeSession } = await import("../session-cache");
  const patch = { ...record, lifecycle, lastLifecycleError: undefined };
  touchNativeSession(
    owner.sessionId,
    owner.role === "workspace" ? { sandbox: patch } : { portalSandbox: patch },
  );
}

async function markAsleep(sandboxId: string, owner: Owner): Promise<void> {
  const { withSessionLifecycleLane } = await import("./lifecycle-lane");
  await withSessionLifecycleLane(owner.sessionId, async () => {
    const current = await currentRecord(sandboxId, owner);
    if (!current || current.record.lifecycle === "sleeping") return;
    // A wake may have started after the event was sent.
    if ((await machineStatus(sandboxId)) !== "stopped") return;
    const { suspendSandboxPreviewRoutes } = await import("../preview");
    suspendSandboxPreviewRoutes(sandboxId);
    await persist(owner, current.record, "sleeping");
    console.log(
      `[sandbox:boat] ${owner.sessionId}: ${sandboxId} stopped by Boat, recorded asleep`,
    );
  });
}

async function markAwake(sandboxId: string, owner: Owner): Promise<void> {
  const { sessionLifecycleInFlight, withSessionLifecycleLane } =
    await import("./lifecycle-lane");
  // A wake, move, or sleep this server started owns the machine right now
  // and restores its Portals itself.
  if (sessionLifecycleInFlight(owner.sessionId)) return;
  await withSessionLifecycleLane(owner.sessionId, async () => {
    const current = await currentRecord(sandboxId, owner);
    if (!current) return;
    if ((await machineStatus(sandboxId)) !== "running") return;
    if (current.record.lifecycle !== "awake")
      await persist(owner, current.record, "awake");
    const { isArchivedId } = await import("../archive");
    // A Portal Sandbox relaunches on the next visit, which first lands the
    // host checkpoint; relaunching here would serve an older tree.
    if (owner.role !== "workspace" || isArchivedId(owner.sessionId)) return;
    const { activeSandboxFor, restoreSandboxPortals } =
      await import("../session-sandbox");
    const sandbox = await activeSandboxFor(current.session);
    if (!sandbox) return;
    await restoreSandboxPortals(current.session, sandbox, { onlyDead: true });
  });
}
