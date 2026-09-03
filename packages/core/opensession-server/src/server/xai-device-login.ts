/**
 * Device-code sign-in for the xAI (SuperGrok) account pool.
 *
 * The Codex sibling shells out to `codex login --device-auth`; xAI has no CLI
 * we depend on, so the OAuth 2.0 device grant runs in-process (xai-oauth.ts):
 * request a code, surface the verification URL and one-time code to Settings,
 * poll the token endpoint until the person approves on any device, then
 * register the token pair with addXaiAccount. No Pi extension is loaded for
 * this; the runner keeps `noExtensions: true`.
 *
 * Live attempts are parked on globalThis so a hot reload neither orphans a
 * poll loop nor loses the URL and code mid-flow.
 */

import {
  XaiOAuthError,
  fetchXaiUser,
  pollXaiDeviceToken,
  requestXaiDeviceCode,
  type XaiOAuthTokens,
} from "./xai-oauth";
import { addXaiAccount, type XaiAccountPublic } from "./xai-accounts";

// Prune finished attempts (the UI has long stopped polling by then).
const RETENTION_MS = 60 * 60 * 1000;

export type XaiDeviceLoginState =
  | "starting"
  | "awaiting_code"
  | "done"
  | "error"
  | "cancelled";

interface XaiDeviceLogin {
  id: string;
  owner?: string;
  state: XaiDeviceLoginState;
  url?: string;
  code?: string;
  error?: string;
  account?: XaiAccountPublic;
  abort: AbortController;
  createdAt: number;
  finishedAt?: number;
}

export interface XaiDeviceLoginPublic {
  id: string;
  state: XaiDeviceLoginState;
  url?: string;
  code?: string;
  error?: string;
  account?: XaiAccountPublic;
}

const logins: Map<string, XaiDeviceLogin> = ((
  globalThis as any
).__xaiDeviceLogins ??= new Map());

function toPublic(l: XaiDeviceLogin): XaiDeviceLoginPublic {
  // Only include set fields — callers use `"error" in result` semantics.
  return {
    id: l.id,
    state: l.state,
    ...(l.url ? { url: l.url } : {}),
    ...(l.code ? { code: l.code } : {}),
    ...(l.error ? { error: l.error } : {}),
    ...(l.account ? { account: l.account } : {}),
  };
}

function finish(
  l: XaiDeviceLogin,
  state: XaiDeviceLoginState,
  error?: string,
): void {
  if (l.state === "done" || l.state === "error" || l.state === "cancelled")
    return;
  l.state = state;
  if (error) l.error = error;
  l.finishedAt = Date.now();
  l.abort.abort();
}

function prune(): void {
  const now = Date.now();
  for (const [id, l] of logins) {
    if (l.finishedAt && now - l.finishedAt > RETENTION_MS) logins.delete(id);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function register(
  l: XaiDeviceLogin,
  tokens: XaiOAuthTokens,
  email: string | undefined,
): void {
  const result = addXaiAccount({
    tokens,
    ...(email ? { email } : {}),
    ...(l.owner ? { owner: l.owner } : {}),
  });
  if ("error" in result) {
    finish(l, "error", `Signed in, but registering failed: ${result.error}`);
    return;
  }
  l.account = result;
  finish(l, "done");
  console.log(`[xai-device-login] ${result.name} signed in and registered`);
}

async function run(l: XaiDeviceLogin): Promise<void> {
  const { signal } = l.abort;
  try {
    const device = await requestXaiDeviceCode(signal);
    l.url = device.verificationUri;
    l.code = device.userCode;
    if (l.state === "starting") l.state = "awaiting_code";
    let interval = Math.max(1, device.intervalSeconds);
    const deadline = Date.now() + Math.max(device.expiresInSeconds, 60) * 1000;
    while (!signal.aborted) {
      // Sleep first: an immediate poll on a fresh code only returns pending.
      await sleep(interval * 1000, signal);
      if (signal.aborted) return;
      if (Date.now() > deadline) {
        finish(l, "error", "The device code expired. Start again.");
        return;
      }
      const poll = await pollXaiDeviceToken(device.deviceCode, signal);
      if (poll.status === "pending") continue;
      if (poll.status === "slow_down") {
        interval += 5;
        continue;
      }
      if (poll.status === "failed") {
        if (poll.fatal) {
          finish(l, "error", poll.message);
          return;
        }
        // A transient token-endpoint fault; keep polling until the deadline.
        continue;
      }
      let email: string | undefined;
      try {
        // Best effort: the id token also carries the email when /user is down.
        email = (await fetchXaiUser(poll.tokens.access)).email;
      } catch {}
      register(l, poll.tokens, email);
      return;
    }
  } catch (error) {
    if (signal.aborted) return;
    const message =
      error instanceof XaiOAuthError
        ? error.message
        : `xAI sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
    finish(l, "error", message);
  }
}

/** Kick off a device-code sign-in. Returns fast; the caller polls
 * getXaiDeviceLogin until the URL and code appear, then until it completes. */
export function startXaiDeviceLogin(owner?: string): XaiDeviceLoginPublic {
  prune();
  const l: XaiDeviceLogin = {
    id: crypto.randomUUID(),
    ...(owner?.trim() ? { owner: owner.trim() } : {}),
    state: "starting",
    abort: new AbortController(),
    createdAt: Date.now(),
  };
  logins.set(l.id, l);
  void run(l);
  return toPublic(l);
}

export function getXaiDeviceLogin(id: string): XaiDeviceLoginPublic | null {
  const l = logins.get(id);
  return l ? toPublic(l) : null;
}

export function cancelXaiDeviceLogin(id: string): boolean {
  const l = logins.get(id);
  if (!l) return false;
  finish(l, "cancelled");
  return true;
}
