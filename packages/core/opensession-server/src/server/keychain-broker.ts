/**
 * The keychain broker: one HTTPS call with a borrowed credential, made from
 * inside this process for the call_credential tool (keychain-tools.ts).
 *
 * The session is the caller's, taken from the run-rpc token that routed the
 * tool call, never from anything the agent supplies. So a grant is usable
 * only in the session it was issued to; its id alone authorizes nothing.
 *
 * The request goes only to the credential's host over HTTPS on the default
 * port. The method and the normalized path are checked against the
 * credential's ceiling after URL parsing, so `..` segments cannot step
 * outside an allowed prefix. Redirects are not followed. The secret is
 * scrubbed from the response headers and body, and a statusOnly credential
 * returns nothing but the status.
 */

import { audit } from "./audit";
import {
  activeGrantFor,
  brokerHeaders,
  consumeGrantForBroker,
  ensureKeychainLoaded,
  findCredential,
  scrubSecret,
} from "./keychain";

export const BROKER_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type BrokerMethod = (typeof BROKER_METHODS)[number];

const BROKER_TIMEOUT_MS = 30_000;
/** What we read of a response body, and what reaches the model of it. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RETURNED_CHARS = 60_000;

/** Request headers the agent may set. Everything else is dropped, so it
 *  cannot override the injected credential, cookies or the host. */
const FORWARDED_HEADERS = new Set([
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "idempotency-key",
  "user-agent",
]);
/** Response headers worth showing. */
const RETURNED_HEADERS = ["content-type", "location", "retry-after", "etag"];

export interface BrokerCallInput {
  sessionId: string;
  credential: string;
  method: BrokerMethod;
  /** Path and optional query on the credential's host, starting with "/". */
  path: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export type BrokerCallResult =
  | { error: string }
  | {
      status: number;
      statusOnly?: true;
      headers?: Record<string, string>;
      body?: string;
      truncated?: true;
    };

export async function brokerCall(
  input: BrokerCallInput,
): Promise<BrokerCallResult> {
  await ensureKeychainLoaded();
  const meta = findCredential(input.credential);
  if (!meta) return { error: `no credential matches "${input.credential}"` };
  if (!input.path.startsWith("/") || input.path.startsWith("//"))
    return { error: "path must start with a single /" };
  let target: URL;
  try {
    target = new URL(`https://${meta.host}${input.path}`);
  } catch {
    return { error: "path is not a valid URL path" };
  }
  if (target.hostname !== meta.host || target.port || target.username)
    return { error: `path must stay on https://${meta.host}` };

  const grant = activeGrantFor(input.sessionId, meta.id);
  if (!grant)
    return {
      error: `this session holds no live grant for ${meta.service}. Ask its owner with request_credential first.`,
    };
  const use = consumeGrantForBroker(
    grant.id,
    input.sessionId,
    input.method,
    target.pathname,
  );
  if ("error" in use) {
    audit({
      kind: "keychain_broker_denied",
      grant_id: grant.id,
      session_id: input.sessionId,
      method: input.method,
      path: target.pathname,
      reason: use.error,
    });
    return { error: use.error };
  }
  const { credential } = use;

  const headers = new Headers();
  for (const [k, v] of Object.entries(input.headers || {}))
    if (FORWARDED_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  for (const [k, v] of Object.entries(brokerHeaders(credential)))
    headers.set(k, v);

  audit({
    kind: "keychain_broker_call",
    grant_id: grant.id,
    credential_id: credential.id,
    session_id: input.sessionId,
    owner: grant.owner,
    service: credential.service,
    method: input.method,
    host: credential.host,
    path: target.pathname,
    mode: grant.mode,
  });

  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(BROKER_TIMEOUT_MS)])
    : AbortSignal.timeout(BROKER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (input.fetchImpl ?? fetch)(target, {
      method: input.method,
      headers,
      body:
        input.method === "GET" || input.method === "HEAD"
          ? undefined
          : input.body,
      signal,
      // A redirect's Location can point at any host; following it would send
      // the credential somewhere the owner never approved.
      redirect: "manual",
    });
  } catch (e: any) {
    const reason = e?.name === "TimeoutError" ? "timed out" : "failed";
    return { error: `the request to ${credential.host} ${reason}` };
  }

  if (credential.statusOnly) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, statusOnly: true };
  }

  const scrub = (text: string) => scrubSecret(text, credential.secret);
  const outHeaders: Record<string, string> = {};
  for (const name of RETURNED_HEADERS) {
    const v = res.headers.get(name);
    if (v) outHeaders[name] = scrub(v);
  }
  const contentType = res.headers.get("content-type") || "";
  const textual =
    !contentType || /text\/|json|xml|x-www-form-urlencoded/i.test(contentType);
  const { bytes, cut } = await readCapped(res, MAX_BODY_BYTES);
  if (!textual)
    return {
      status: res.status,
      headers: outHeaders,
      body: `[${bytes.length}${cut ? "+" : ""} bytes of ${contentType} omitted]`,
    };
  let body = scrub(new TextDecoder().decode(bytes));
  let truncated = cut;
  if (body.length > MAX_RETURNED_CHARS) {
    body = body.slice(0, MAX_RETURNED_CHARS);
    truncated = true;
  }
  return {
    status: res.status,
    headers: outHeaders,
    body,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

export async function readCapped(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    if (value.length > room) {
      chunks.push(value.subarray(0, room));
      size = max;
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, cut };
}
