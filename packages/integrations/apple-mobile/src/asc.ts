import { credentials } from "./credentials";

const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com";
/** Apple rejects tokens that live longer than 20 minutes. */
const TOKEN_TTL_SECONDS = 15 * 60;
const MAX_PAGES = 10;

export interface AscRef {
  type: string;
  id: string;
}

/** One JSON:API resource as App Store Connect returns it. */
export interface AscResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, { data?: AscRef | AscRef[] | null }>;
}

export interface AscDocument<A = Record<string, unknown>> {
  data: AscResource<A> | AscResource<A>[];
  included?: AscResource[];
  links?: { next?: string };
}

export class AscError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: string[],
  ) {
    super(message);
  }
}

/** Only loopback overrides are honored, so a misconfigured base URL can never
 *  send a signed token to another host. Tests use this to run a fake API. */
export function ascBaseUrl(): string {
  const override = process.env.APPLE_ASC_API_BASE_URL;
  if (!override) return DEFAULT_BASE_URL;
  const url = new URL(override);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("APPLE_ASC_API_BASE_URL may only point at loopback");
  }
  return url.origin;
}

function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("App Store Connect private key is empty");
  return new Uint8Array(Buffer.from(body, "base64"));
}

/** ES256 JWT for the App Store Connect API. WebCrypto's ECDSA signature is
 *  already the raw r||s form JWS expects. */
export async function ascToken(
  input: { keyId: string; issuerId: string; privateKeyPem: string },
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBody(input.privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64url(
    JSON.stringify({ alg: "ES256", kid: input.keyId, typ: "JWT" }),
  );
  const payload = base64url(
    JSON.stringify({
      iss: input.issuerId,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      aud: "appstoreconnect-v1",
    }),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

function apiError(status: number, body: unknown): AscError {
  const errors =
    body && typeof body === "object" && "errors" in body
      ? ((body as { errors?: unknown }).errors as
          | { code?: string; title?: string; detail?: string }[]
          | undefined)
      : undefined;
  const parts = (errors ?? [])
    .map((error) => error.detail || error.title || "")
    .filter(Boolean);
  return new AscError(
    `App Store Connect API ${status}${parts.length ? `: ${parts.join("; ")}` : ""}`,
    status,
    (errors ?? []).map((error) => error.code ?? "").filter(Boolean),
  );
}

export class AscClient {
  #token?: { value: string; expiresAt: number };
  readonly #auth: { keyId: string; issuerId: string; keyPath: string };
  readonly #baseUrl: string;

  constructor(
    auth: { keyId: string; issuerId: string; keyPath: string },
    baseUrl = ascBaseUrl(),
  ) {
    this.#auth = auth;
    this.#baseUrl = baseUrl;
  }

  async #bearer(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.#token && this.#token.expiresAt - 60 > now) {
      return this.#token.value;
    }
    const value = await ascToken(
      {
        keyId: this.#auth.keyId,
        issuerId: this.#auth.issuerId,
        privateKeyPem: await Bun.file(this.#auth.keyPath).text(),
      },
      now,
    );
    this.#token = { value, expiresAt: now + TOKEN_TTL_SECONDS };
    return value;
  }

  async request<A = Record<string, unknown>>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<AscDocument<A> | undefined> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== new URL(this.#baseUrl).origin) {
      throw new Error("Refusing to send App Store Connect credentials offsite");
    }
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.#bearer()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) throw apiError(response.status, parsed);
    return parsed as AscDocument<A> | undefined;
  }

  async get<A = Record<string, unknown>>(path: string) {
    const document = await this.request<A>("GET", path);
    if (!document) throw new Error(`Empty App Store Connect response: ${path}`);
    return document;
  }

  /** Follows `links.next`, bounded so a runaway listing cannot loop. */
  async list<A = Record<string, unknown>>(
    path: string,
    maxPages = MAX_PAGES,
  ): Promise<{ data: AscResource<A>[]; included: AscResource[] }> {
    const data: AscResource<A>[] = [];
    const included: AscResource[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      const document: AscDocument<A> = await this.get<A>(next);
      data.push(
        ...(Array.isArray(document.data) ? document.data : [document.data]),
      );
      included.push(...(document.included ?? []));
      next = document.links?.next;
    }
    return { data, included };
  }
}

export function ascClient(projectDir?: string): AscClient {
  const auth = credentials(true, projectDir);
  return new AscClient({
    keyId: auth.keyId!,
    issuerId: auth.issuerId!,
    keyPath: auth.keyPath!,
  });
}

export function query(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function single<A>(
  document: AscDocument<A> | undefined,
  label: string,
): AscResource<A> {
  const data = document?.data;
  if (!data || Array.isArray(data)) {
    throw new Error(`App Store Connect returned no ${label}`);
  }
  return data;
}
