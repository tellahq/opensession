/**
 * Web Push client: registers this prefix's sw.js service worker and manages
 * this device's push subscription. Complements lib/notify.ts (tab-bound
 * notifications) — push reaches the phone with the app closed, but only when
 * the app was opened over a secure origin (the ts.net HTTPS host).
 */

import { z } from "zod";
import { BASE_PATH } from "./base";
import { PRODUCT_NAME, PUBLIC_BASE_URL } from "./brand";

export type PushState = "unsupported" | "denied" | "off" | "on";

const SW_URL = `${BASE_PATH}/sw.js`;
const navigateMessageSchema = z.object({
  type: z.literal("os1-navigate"),
  url: z.string(),
});
const vapidKeySchema = z.object({ publicKey: z.string() });

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Register this prefix's service worker at app boot (idempotent — enablePush
 * registers the same URL+scope). Push stays opt-in; this bare registration is
 * what turns on sw.js's app-shell caching, so a phone cold start paints from
 * cache when the tailnet is slow or unreachable. Registration alone never
 * prompts for any permission.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !window.isSecureContext) return;
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register(SW_URL, { scope: `${BASE_PATH}/` })
    .catch(() => {});
}

/**
 * Route a notification tap the service worker handed to this page (see sw.js).
 * The worker posts the URL rather than reloading the document, and waits for
 * the ack this sends back before falling back to a document navigation.
 */
export function onPushNavigate(handler: (url: string) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return () => {};
  const listener = (event: MessageEvent) => {
    const result = navigateMessageSchema.safeParse(event.data);
    if (!result.success) return;
    event.ports?.[0]?.postMessage({ ok: true });
    handler(result.data.url);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  // Messages posted before a listener exists are buffered until the page asks
  // for them, and addEventListener (unlike the onmessage setter) does not ask.
  navigator.serviceWorker.startMessages?.();
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "on" : "off";
  } catch {
    return "off";
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Enable push on this device for `user`. Throws with a friendly message. */
export async function enablePush(user: string): Promise<void> {
  if (!supported()) {
    throw new Error(
      window.isSecureContext
        ? "This browser doesn't support Web Push."
        : `Push needs an HTTPS origin. Open ${PRODUCT_NAME} at ${PUBLIC_BASE_URL}.`,
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("Notification permission was declined.");

  const reg = await navigator.serviceWorker.register(SW_URL, {
    scope: `${BASE_PATH}/`,
  });
  await navigator.serviceWorker.ready;

  const keyRes = await fetch(`${BASE_PATH}/api/push/vapid-key`);
  if (!keyRes.ok)
    throw new Error("Couldn't fetch the push key from the server.");
  const { publicKey } = vapidKeySchema.parse(await keyRes.json());

  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const res = await fetch(`${BASE_PATH}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, subscription: sub.toJSON() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Failed to register the subscription.");
  }
}

/** Disable push on this device (unsubscribes + tells the server). */
export async function disablePush(): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch(`${BASE_PATH}/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}
