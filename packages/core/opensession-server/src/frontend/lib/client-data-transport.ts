import { BASE_PATH } from "./base";
import {
  assertClientDataScope,
  captureClientDataScope,
  clientDataScopeHeaders,
  publishClientDataIdentity,
  type ClientDataScope,
} from "./client-data-scope";

/** Cover direct fetch callers as well as the JSON API helper. Auth status is
 * deliberately exempt: it is how an unresolved browser learns its identity. */
export function installClientDataTransport(): () => void {
  const original = globalThis.fetch;
  const guarded = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      const api =
        url.origin === location.origin &&
        url.pathname.startsWith(`${BASE_PATH}/api/`);
      if (!api || url.pathname.startsWith(`${BASE_PATH}/api/auth/`))
        return original(input, init);
      const scope = captureClientDataScope();
      assertClientDataScope(scope);
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, key) =>
        headers.set(key, value),
      );
      const expected = headers.get("X-OpenSession-Expected-GitHub-Account-Id");
      if (expected !== null && expected !== String(scope.githubAccountId))
        throw new Error("The request belongs to another GitHub account.");
      headers.delete("X-OpenSession-Privacy");
      for (const [key, value] of Object.entries(clientDataScopeHeaders(scope)))
        headers.set(key, value);
      const response = await original(input, {
        ...init,
        headers,
        cache: "no-store",
      });
      assertClientDataScope(scope);
      if (response.status === 401 || response.status === 409) {
        const body = await response
          .clone()
          .json()
          .catch(() => null);
        assertClientDataScope(scope);
        if (
          response.status === 401 ||
          body?.code === "principal_changed" ||
          body?.error === "principal_changed"
        ) {
          publishClientDataIdentity(null);
          window.dispatchEvent(new Event("opensession-principal-changed"));
          assertClientDataScope(scope);
        }
      }
      return scopedResponse(response, scope);
    },
    { preconnect: original.preconnect },
  );
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}

/** A readable body is fenced too, including streaming consumers that never
 * call json(). High-water zero avoids buffering data across an identity turn. */
function guardedStream(
  body: ReadableStream<Uint8Array> | null,
  scope: ClientDataScope,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          assertClientDataScope(scope);
          const result = await reader.read();
          assertClientDataScope(scope);
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
          void reader.cancel().catch(() => {});
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
async function readScopedBody<T>(
  scope: ClientDataScope,
  read: () => Promise<T>,
): Promise<T> {
  assertClientDataScope(scope);
  const result = await read();
  assertClientDataScope(scope);
  return result;
}
class ScopedResponse extends Response {
  constructor(
    response: Response,
    private readonly scope: ClientDataScope,
    private readonly original: Response = response,
  ) {
    super(guardedStream(response.body, scope), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  override get url() {
    return this.original.url;
  }
  override get redirected() {
    return this.original.redirected;
  }
  override get type() {
    return this.original.type;
  }
  override json(): ReturnType<Response["json"]> {
    return readScopedBody(this.scope, () => super.json());
  }
  override text() {
    return readScopedBody(this.scope, () => super.text());
  }
  override blob() {
    return readScopedBody(this.scope, () => super.blob());
  }
  override arrayBuffer() {
    return readScopedBody(this.scope, () => super.arrayBuffer());
  }
  override formData() {
    return readScopedBody(this.scope, () => super.formData());
  }
  override bytes() {
    return readScopedBody(this.scope, () => super.bytes());
  }
  override clone(): Response {
    assertClientDataScope(this.scope);
    return new ScopedResponse(super.clone(), this.scope, this.original);
  }
}
function scopedResponse(response: Response, scope: ClientDataScope): Response {
  return new ScopedResponse(response, scope);
}
