/**
 * Keychain asks a session made that this viewer owns the credential for,
 * per session (opensession-keychain request_credential).
 *
 * Fed by the session subscription (useSessionViewerSubscription) with the
 * keychain_asks_changed frame, and read by KeychainAskCard through
 * useSyncExternalStore. The frame carries nothing about the ask, so every
 * change re-reads /api/keychain/asks, which answers with the asks only for
 * the credential's verified owner. Everyone else gets an empty list.
 */
import { BASE_PATH } from "./base";

export type SessionKeychainAsk = {
  id: string;
  requestedBy: string;
  purpose: string;
  requestedMode: "once" | "standing" | "run" | "release";
  run?: { command: string };
  credentials: Array<{
    service: string;
    host: string;
    kind?: "api" | "login";
    username?: string;
    loginUrl?: string;
  }>;
  createdAt: string;
};

const NONE: SessionKeychainAsk[] = [];
const open = new Map<string, SessionKeychainAsk[]>();
const listeners = new Map<string, Set<() => void>>();
/** Bumped per load, so a slow response cannot overwrite a newer one. */
const loads = new Map<string, number>();

function set(sessionId: string, value: SessionKeychainAsk[]): void {
  open.set(sessionId, value);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

function load(sessionId: string): void {
  const token = (loads.get(sessionId) ?? 0) + 1;
  loads.set(sessionId, token);
  fetch(
    `${BASE_PATH}/api/keychain/asks?sessionId=${encodeURIComponent(sessionId)}`,
  )
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body || loads.get(sessionId) !== token) return;
      set(sessionId, Array.isArray(body.asks) ? body.asks : NONE);
    })
    .catch(() => {});
}

/** The first viewer loads what is already open; the frame only reaches
 *  viewers connected when it went out. Teardown is deferred a microtask so
 *  a resubscribe on render keeps the loaded state. */
export function subscribeKeychainAsks(
  sessionId: string,
  listener: () => void,
): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  if (!set.size && !open.has(sessionId) && !loads.has(sessionId))
    load(sessionId);
  set.add(listener);
  return () => {
    set.delete(listener);
    queueMicrotask(() => {
      if (set.size || listeners.get(sessionId) !== set) return;
      listeners.delete(sessionId);
      open.delete(sessionId);
      loads.delete(sessionId);
    });
  };
}

export function keychainAsksFor(sessionId: string): SessionKeychainAsk[] {
  return open.get(sessionId) ?? NONE;
}

export function applyKeychainAsksFrame(msg: { sessionId: string }): void {
  if (listeners.has(msg.sessionId)) load(msg.sessionId);
}

/** Re-read after this viewer answered, without waiting for the frame. */
export function reloadKeychainAsks(sessionId: string): void {
  if (listeners.has(sessionId)) load(sessionId);
}
