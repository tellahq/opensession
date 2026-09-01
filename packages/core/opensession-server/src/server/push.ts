/**
 * Web Push: phone/desktop notifications that work with the app closed —
 * unlike lib/notify.ts's tab-bound Notification API. Requires the app to be
 * opened over a secure origin; plain HTTP origins have no service workers.
 *
 * VAPID keys are generated once and persisted; subscriptions are stored per
 * user (a person can have several devices). Dead subscriptions (404/410 from
 * the push service) are pruned on send. Delivery is strictly best-effort —
 * push failures never affect the flow that triggered them.
 */
import { mkdirSync, readFileSync, existsSync } from "fs";
import webpush from "web-push";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { configuredIntegration } from "./config";

const PUSH_DIR = stateDir("push");
const VAPID_PATH = `${PUSH_DIR}/vapid.json`;
const SUBS_PATH = `${PUSH_DIR}/subscriptions.json`;

mkdirSync(PUSH_DIR, { recursive: true });

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapid: VapidKeys | null = null;
let configured = false;

export function getVapidPublicKey(): string {
  ensureVapid();
  return vapid!.publicKey;
}

function ensureVapid(): void {
  if (vapid) return;
  try {
    if (existsSync(VAPID_PATH)) {
      vapid = JSON.parse(readFileSync(VAPID_PATH, "utf-8"));
    }
  } catch {}
  if (!vapid?.publicKey || !vapid?.privateKey) {
    vapid = webpush.generateVAPIDKeys();
    writeJsonAtomic(VAPID_PATH, vapid);
    console.log("[push] generated VAPID keypair");
  }
  if (!configured) {
    const subject = configuredIntegration("push").vapidSubject;
    webpush.setVapidDetails(
      typeof subject === "string" && subject.trim()
        ? subject.trim()
        : "mailto:admin@example.com",
      vapid!.publicKey,
      vapid!.privateKey,
    );
    configured = true;
  }
}

export interface PushSubscriptionRecord {
  user: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: string;
}

interface SubsFile {
  subscriptions: PushSubscriptionRecord[];
}

function readSubs(): SubsFile {
  try {
    if (existsSync(SUBS_PATH)) {
      const s = JSON.parse(readFileSync(SUBS_PATH, "utf-8"));
      if (Array.isArray(s.subscriptions)) return s;
    }
  } catch {}
  return { subscriptions: [] };
}

export function listPushSubscriptions(user?: string): PushSubscriptionRecord[] {
  const all = readSubs().subscriptions;
  return user ? all.filter((s) => s.user === user) : all;
}

export function addPushSubscription(input: {
  user: string;
  subscription: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  userAgent?: string;
}): { ok: true } | { error: string } {
  const { endpoint, keys } = input.subscription || {};
  if (!input.user?.trim()) return { error: "user required" };
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return { error: "subscription must carry endpoint + p256dh/auth keys" };
  const store = readSubs();
  store.subscriptions = store.subscriptions.filter(
    (s) => s.endpoint !== endpoint,
  );
  store.subscriptions.push({
    user: input.user.trim(),
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userAgent: input.userAgent?.slice(0, 200),
    createdAt: new Date().toISOString(),
  });
  writeJsonAtomic(SUBS_PATH, store);
  return { ok: true };
}

export function removePushSubscription(endpoint: string): boolean {
  const store = readSubs();
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter(
    (s) => s.endpoint !== endpoint,
  );
  if (store.subscriptions.length === before) return false;
  writeJsonAtomic(SUBS_PATH, store);
  return true;
}

export interface PushPayload {
  title: string;
  body?: string;
  /** In-app path to open on tap, e.g. /session/<id>. */
  url?: string;
  tag?: string;
}

// Dedupe ledger: pushes that must survive a restart without refiring (a
// service restart resumes ask-blocked runs, which re-ask the same question —
// the person already got that buzz). Keyed by caller-chosen fingerprint.
const SENT_DEDUPE_PATH = `${PUSH_DIR}/sent-dedupe.json`;
const DEDUPE_TTL_MS = 48 * 60 * 60 * 1000;

function readSentDedupe(): Record<string, string> {
  try {
    if (existsSync(SENT_DEDUPE_PATH)) {
      const s = JSON.parse(readFileSync(SENT_DEDUPE_PATH, "utf-8"));
      if (s && typeof s === "object" && !Array.isArray(s)) return s;
    }
  } catch {}
  return {};
}

/**
 * Send a push to every device `user` has registered (matched by exact display
 * name — the same value UserPicker stores). Fire-and-forget; prunes dead subs.
 *
 * `dedupeKey` (optional) suppresses the send when the same key was already
 * pushed within the last 48h — the ledger is on disk, so a re-ask of the same
 * question after a service restart doesn't buzz the same person twice.
 */
export async function sendPushToUser(
  user: string,
  payload: PushPayload,
  opts?: { dedupeKey?: string },
): Promise<void> {
  if (opts?.dedupeKey) {
    const sent = readSentDedupe();
    const now = Date.now();
    const prev = sent[opts.dedupeKey] ? Date.parse(sent[opts.dedupeKey]) : NaN;
    if (Number.isFinite(prev) && now - prev < DEDUPE_TTL_MS) return;
    for (const [k, v] of Object.entries(sent)) {
      const t = Date.parse(v);
      if (!Number.isFinite(t) || now - t >= DEDUPE_TTL_MS) delete sent[k];
    }
    sent[opts.dedupeKey] = new Date(now).toISOString();
    writeJsonAtomic(SENT_DEDUPE_PATH, sent);
  }
  const subs = listPushSubscriptions(user);
  if (subs.length === 0) return;
  ensureVapid();
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          body,
          { TTL: 60 * 60 },
        );
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          removePushSubscription(s.endpoint);
          console.log(`[push] pruned dead subscription for ${s.user}`);
        } else {
          console.error(`[push] send failed for ${s.user}:`, e?.message || e);
        }
      }
    }),
  );
}
