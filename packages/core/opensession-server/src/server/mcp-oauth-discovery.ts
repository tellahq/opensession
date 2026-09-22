import { assertFetchableUrl } from "./web-fetch";

export interface OauthDiscovery {
  resource?: string;
  scopes?: string[];
  endpoints: { authorize: string; token: string; register?: string };
}

const MAX_METADATA_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

/** A configured origin is already trusted as an MCP target. Metadata may not
 * turn that trust into access to another private service or plaintext origin. */
async function discoveryUrl(raw: unknown, resource: URL): Promise<URL> {
  if (typeof raw !== "string" || raw.length > 4096)
    throw new Error("Invalid OAuth metadata URL");
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.origin !== resource.origin && url.protocol !== "https:")
  )
    throw new Error("Unsafe OAuth metadata URL");
  if (url.origin !== resource.origin) await assertFetchableUrl(url.href);
  return url;
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    // Observe work even if the deadline already elapsed, so a late rejection
    // from DNS or a cancelled stream cannot become an unhandled rejection.
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function metadata(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error("OAuth metadata unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.length;
      if (size > MAX_METADATA_BYTES)
        throw new Error("OAuth metadata too large");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid OAuth metadata");
  return value as Record<string, unknown>;
}

/** Only Bearer challenges may supply resource_metadata. Split on commas outside
 * quoted strings so a Basic realm cannot smuggle a discovery parameter. */
function challengeMetadata(header: string): string | undefined {
  if (header.length > 8192) return undefined;
  let bearer = false;
  for (const part of header.match(/(?:[^,"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ??
    []) {
    const challenge = part.trim().match(/^([\w-]+)\s+(?![=\s])(.*)$/);
    const param = challenge ? challenge[2]! : part.trim();
    if (challenge) bearer = challenge[1]!.toLowerCase() === "bearer";
    const match = param.match(/^resource_metadata\s*=\s*"([^"\\]*)"\s*$/i);
    if (bearer && match) return match[1];
  }
  return undefined;
}

function wellKnown(issuer: URL, name: string): string[] {
  const path =
    issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return [
    `${issuer.origin}/.well-known/${name}${path}`,
    `${issuer.origin}${path}/.well-known/${name}`,
  ];
}

/** RFC 9728 resource discovery followed by RFC 8414 / OIDC issuer discovery.
 * No credentials, redirects, recursive discovery, or unbounded provider lists.
 * One deadline covers DNS, all requests, and streaming JSON bodies. */
export async function discoverMcpOauth(
  serverUrl: string,
): Promise<OauthDiscovery> {
  const resourceUrl = new URL(serverUrl);
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const request = async (raw: string) => {
    signal.throwIfAborted();
    const url = await bounded(discoveryUrl(raw, resourceUrl), signal);
    return bounded(
      fetch(url.href, {
        headers: { Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal,
      }),
      signal,
    );
  };
  // Validate the configured target too (notably userinfo, fragments and schemes).
  await bounded(discoveryUrl(serverUrl, resourceUrl), signal);
  let advertised: string | undefined;
  try {
    const response = await request(serverUrl);
    if (response.status === 401)
      advertised = challengeMetadata(
        response.headers.get("www-authenticate") ?? "",
      );
    void response.body?.cancel().catch(() => {});
  } catch {}

  const path = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname;
  const candidates = new Set([
    ...(advertised ? [advertised] : []),
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${path}`,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
  ]);
  let resource: string | undefined;
  let scopes: string[] | undefined;
  let issuer = resourceUrl.origin;
  for (const candidate of candidates) {
    try {
      const pr = await metadata(await request(candidate), signal);
      // RFC 9728 binds the document to the requested resource, not a sibling path.
      if (pr.resource !== resourceUrl.href) continue;
      if (
        !Array.isArray(pr.authorization_servers) ||
        !pr.authorization_servers.length
      )
        continue;
      const nextIssuer = await bounded(
        discoveryUrl(pr.authorization_servers[0], resourceUrl),
        signal,
      );
      if (nextIssuer.search) continue;
      if (
        pr.scopes_supported !== undefined &&
        (!Array.isArray(pr.scopes_supported) ||
          !pr.scopes_supported.every((s) => typeof s === "string"))
      )
        continue;
      resource = pr.resource as string;
      scopes = pr.scopes_supported as string[] | undefined;
      issuer = pr.authorization_servers[0] as string;
      break;
    } catch {}
  }
  // Keep legacy origin-only AS discovery for servers without RFC 9728 metadata.
  const asCandidates = new Set([
    ...wellKnown(new URL(issuer), "oauth-authorization-server"),
    // OIDC's standard form appends to the issuer path; also support insertion.
    ...wellKnown(new URL(issuer), "openid-configuration").reverse(),
  ]);
  for (const candidate of asCandidates) {
    try {
      const as = await metadata(await request(candidate), signal);
      if (as.issuer !== issuer) continue;
      const authorize = await bounded(
        discoveryUrl(as.authorization_endpoint, resourceUrl),
        signal,
      );
      const token = await bounded(
        discoveryUrl(as.token_endpoint, resourceUrl),
        signal,
      );
      const register =
        as.registration_endpoint === undefined
          ? undefined
          : await bounded(
              discoveryUrl(as.registration_endpoint, resourceUrl),
              signal,
            );
      return {
        resource,
        scopes,
        endpoints: {
          authorize: authorize.href,
          token: token.href,
          register: register?.href,
        },
      };
    } catch {}
  }
  throw new Error(
    "No valid OAuth authorization-server metadata for this MCP resource",
  );
}
