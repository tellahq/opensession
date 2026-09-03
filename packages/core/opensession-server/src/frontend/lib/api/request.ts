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
const inflightGets = new Map<string, Promise<Response>>();

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
  const createResponse = () => {
    const init: RequestInit = {
      method,
      signal: opts.signal,
      keepalive: opts.keepalive,
    };
    if (opts.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }
    return fetch(`${BASE}${path}`, init);
  };

  let responsePending = share ? inflightGets.get(path) : undefined;
  const ownsSharedRequest = share && !responsePending;
  if (!responsePending) responsePending = createResponse();
  if (ownsSharedRequest) inflightGets.set(path, responsePending);

  const pending = responsePending.then(async (sharedResponse) => {
    const res = share ? sharedResponse.clone() : sharedResponse;
    if (!res.ok) {
      const body: { error?: string } | null = await res
        .json()
        .catch(() => null);
      throw new ApiError(
        body?.error || `${opts.label || "Failed"}: ${res.status}`,
        res.status,
      );
    }
    const body: T = await res.json().catch(() => null);
    return body;
  });

  if (ownsSharedRequest) {
    void pending
      .finally(() => {
        if (inflightGets.get(path) === responsePending) {
          inflightGets.delete(path);
        }
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
