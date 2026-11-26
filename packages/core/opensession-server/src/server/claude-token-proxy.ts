/**
 * Token-swap proxy for Claude Code processes that must not hold a model
 * credential.
 *
 * A Claude host (src/claude-host) may run on a machine this server does not
 * trust with an account's token. Instead of the token, its Claude Code process
 * gets a random placeholder and `ANTHROPIC_BASE_URL` pointing here. Claude Code
 * then sends its model requests to this proxy with the placeholder as its
 * credential; the proxy replaces it with the real one and forwards the request
 * to Anthropic unchanged, streaming the answer back.
 *
 * Containment:
 *  - The real credential is only ever attached to requests for the one fixed
 *    upstream origin, and redirects are returned to the caller, never
 *    followed, so it cannot be steered to another host.
 *  - A placeholder is valid only while its lease is: the provider releases it
 *    when the conversation's process is retired.
 *  - A request without a known placeholder is refused and reaches nothing.
 *  - Nothing here logs a header value.
 *
 * The listener starts on the first lease, never at import.
 */

const UPSTREAM = "https://api.anthropic.com";

type CredentialHeader = "authorization" | "x-api-key";
type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

interface Lease {
  header: CredentialHeader;
  value: string;
}

export interface ClaudeTokenLease {
  /** Replaces the credential variables for the Claude Code process. */
  env: Record<string, string>;
  release(): void;
}

interface ProxyState {
  leases: Map<string, Lease>;
  server?: ReturnType<typeof Bun.serve>;
  upstream: string;
  fetch: UpstreamFetch;
}

const g = globalThis as { __claudeTokenProxy?: ProxyState };

function state(): ProxyState {
  return (g.__claudeTokenProxy ??= {
    leases: new Map(),
    upstream: UPSTREAM,
    fetch: (url, init) => fetch(url, init),
  });
}

/** Headers that describe one hop, not the request. */
const HOP_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
];

function refuse(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function presentedPlaceholder(headers: Headers): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "");
  return bearer?.[1] ?? headers.get("x-api-key") ?? undefined;
}

async function forward(request: Request): Promise<Response> {
  const proxy = state();
  const placeholder = presentedPlaceholder(request.headers);
  const lease = placeholder ? proxy.leases.get(placeholder) : undefined;
  if (!lease)
    return refuse(
      401,
      "authentication_error",
      "This Claude token placeholder is unknown or no longer valid",
    );
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of HOP_HEADERS) headers.delete(name);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.set(
    lease.header,
    lease.header === "authorization" ? `Bearer ${lease.value}` : lease.value,
  );
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  let upstream: Response;
  try {
    upstream = await proxy.fetch(
      `${proxy.upstream}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: request.signal,
        // Bun: pass the upstream bytes through as sent, and do not cut a long
        // quiet stream (a model thinking) at the default idle timeout.
        decompress: false,
        timeout: false,
      } as RequestInit,
    );
  } catch (error) {
    if (request.signal.aborted) return refuse(499, "api_error", "Canceled");
    return refuse(
      502,
      "api_error",
      `Could not reach Anthropic: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const responseHeaders = new Headers(upstream.headers);
  for (const name of HOP_HEADERS) responseHeaders.delete(name);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function ensureServer(): ReturnType<typeof Bun.serve> {
  const proxy = state();
  if (proxy.server) return proxy.server;
  proxy.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A model can think for minutes between bytes.
    idleTimeout: 0,
    fetch: forward,
  });
  // The proxy must never be what keeps a finished run's process alive.
  proxy.server.unref();
  return proxy.server;
}

/**
 * Trade a credential environment (as claudeCodeAuth returns it) for one that
 * carries a placeholder and this proxy's address.
 */
export function leaseClaudeToken(
  authEnv: Readonly<Record<string, string>>,
): ClaudeTokenLease {
  const variable = authEnv.ANTHROPIC_API_KEY
    ? "ANTHROPIC_API_KEY"
    : "CLAUDE_CODE_OAUTH_TOKEN";
  const value = authEnv[variable];
  if (!value)
    throw new Error("No Claude credential to lease a placeholder for");
  const random = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  // Shaped like the credential it stands for, so Claude Code treats it alike.
  const placeholder =
    variable === "ANTHROPIC_API_KEY"
      ? `sk-ant-api03-placeholder-${random}`
      : `sk-ant-oat01-placeholder-${random}`;
  const proxy = state();
  const server = ensureServer();
  proxy.leases.set(placeholder, {
    header: variable === "ANTHROPIC_API_KEY" ? "x-api-key" : "authorization",
    value,
  });
  return {
    env: {
      [variable]: placeholder,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    },
    release: () => {
      proxy.leases.delete(placeholder);
    },
  };
}

/** Test seam: point the proxy at a fake upstream. Returns the restore call. */
export function __setClaudeTokenProxyUpstreamForTest(
  upstream: string,
  fetchImpl?: UpstreamFetch,
): () => void {
  const proxy = state();
  const saved = { upstream: proxy.upstream, fetch: proxy.fetch };
  proxy.upstream = upstream;
  if (fetchImpl) proxy.fetch = fetchImpl;
  return () => {
    proxy.upstream = saved.upstream;
    proxy.fetch = saved.fetch;
  };
}

/** Test seam: live placeholder count. */
export function __claudeTokenLeaseCountForTest(): number {
  return state().leases.size;
}
