/**
 * fetch() with a hard timeout via AbortController.
 *
 * Extracted from the Slack agent's API helper: external APIs should respond in
 * a couple seconds; if we don't hear back in 30s something is wrong (network,
 * provider side, auth). Without this, a wedged fetch can stall a message queue
 * or a per-PR lock indefinitely — a documented failure class. Use this for
 * every outbound fetch in agent/loop code.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
