import { BASE_PATH } from "../base";
import { resolveAnonymousUserPath } from "../auth-ready";

export const BASE = `${BASE_PATH}/api`;

/** API base for building direct resource URLs (e.g. <img src> endpoints). */
export const API_BASE = BASE;

// A page can mount several surfaces that need the same resource at once. Share
// only the request that is currently in flight: this removes duplicate cold
// loads without turning the API layer into a stale response cache. Requests
// with an AbortSignal stay independent because one caller must not be able to
// cancel another caller's work.
const inflightGets = new Map<string, Promise<unknown>>();

/** Single error shape for every API failure: HTTP status + the server's
 * `error` field when it sent one, else a "<label>: <status>" message. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * The one request helper behind every wrapper below. Checks `res.ok` BEFORE
 * touching the body — so an HTML 502 during a server restart surfaces as a
 * useful ApiError instead of `SyntaxError: Unexpected token '<'` — and parses
 * JSON defensively (a bodyless 204/500 just yields null).
 */
export function request<T>(
  path: string,
  opts: {
    method?: string;
    /** JSON-encoded and sent with a Content-Type header when present. */
    body?: unknown;
    signal?: AbortSignal;
    keepalive?: boolean;
    /** Error-message prefix when the server didn't provide an `error` field. */
    label?: string;
  } = {},
): Promise<T> {
  const method = opts.method || "GET";
  if (method === "GET" && /[?&]user=Anonymous(?:&|$)/.test(path)) {
    return resolveAnonymousUserPath(path).then((resolvedPath) =>
      request<T>(resolvedPath, opts),
    );
  }
  const share = method === "GET" && opts.body === undefined && !opts.signal;
  if (share) {
    const existing = inflightGets.get(path);
    if (existing) return existing as Promise<T>;
  }

  const pending = (async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: opts.signal,
      keepalive: opts.keepalive,
      ...(opts.body !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts.body),
          }
        : {}),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ApiError(
        body?.error || `${opts.label || "Failed"}: ${res.status}`,
        res.status,
      );
    }
    return (await res.json().catch(() => null)) as T;
  })();

  if (share) {
    inflightGets.set(path, pending);
    void pending
      .finally(() => {
        if (inflightGets.get(path) === pending) inflightGets.delete(path);
      })
      .catch(() => {});
  }
  return pending;
}

export function getWebSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${BASE_PATH}/ws`;
}

export function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
