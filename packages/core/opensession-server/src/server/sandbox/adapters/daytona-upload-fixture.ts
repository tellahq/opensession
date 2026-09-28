/**
 * Offline fixture for Daytona uploads: a real SDK `Sandbox` whose toolbox
 * proxy is a loopback server that records each upload. Shared by the unit
 * test and the compiled-binary regression, so neither reaches Daytona.
 */

import { createHmac } from "node:crypto";
import { Sandbox } from "@daytonaio/sdk";

export const FIXTURE_SANDBOX_ID = "sbx-upload-fixture";
export const FIXTURE_SIGNING_KEY = "fixture-signing-key";

export interface RecordedUpload {
  method: string;
  pathname: string;
  path: string | null;
  signatureValid: boolean;
  expiresInSeconds: number;
  fields: string[];
  fileName: string | null;
  bytes: Uint8Array;
}

export interface UploadFixture {
  sandbox: Sandbox;
  uploads: RecordedUpload[];
  /** Respond to the next upload with this status and body instead of 200. */
  failNext(status: number, body: string): void;
  close(): void;
}

function expectedSignature(path: string, expires: string): string {
  const canonical = `v1:files:POST:${path}:${expires}`;
  return `v1_${createHmac("sha256", FIXTURE_SIGNING_KEY).update(canonical).digest("base64url")}`;
}

export function startUploadFixture(): UploadFixture {
  const uploads: RecordedUpload[] = [];
  let failure: { status: number; body: string } | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.searchParams.get("path");
      const expires = url.searchParams.get("expires") ?? "";
      const form = await request.formData();
      const file = form.get("file");
      uploads.push({
        method: request.method,
        pathname: url.pathname,
        path,
        signatureValid:
          path !== null &&
          url.searchParams.get("signature") ===
            expectedSignature(path, expires),
        expiresInSeconds: Number(expires) - Math.floor(Date.now() / 1000),
        fields: [...form.keys()],
        fileName: file instanceof File ? file.name : null,
        bytes:
          file instanceof Blob
            ? new Uint8Array(await file.arrayBuffer())
            : new Uint8Array(),
      });
      if (failure) {
        const { status, body } = failure;
        failure = undefined;
        return new Response(body, { status });
      }
      return Response.json({});
    },
  });
  // SAFETY: the SDK constructor is internal; this passes the dto fields and
  // stub collaborators that signing and multipart uploads touch offline.
  const sandbox = new (Sandbox as any)(
    {
      id: FIXTURE_SANDBOX_ID,
      toolboxProxyUrl: `http://127.0.0.1:${server.port}/toolbox`,
      labels: {},
    },
    { basePath: "", baseOptions: { headers: {} } },
    { defaults: {} },
    {},
    () => "",
    { subscribe: () => "fixture-subscription", refresh: () => true },
  ) as Sandbox;
  // A freshly fetched key: uploadUrl signs locally without calling the API.
  // SAFETY: these are the SDK's signing-key cache fields (Sandbox.js).
  const cache = sandbox as any;
  cache.signingKey = FIXTURE_SIGNING_KEY;
  cache.signingKeyFetchedAt = Date.now() / 1000 + 3600;
  return {
    sandbox,
    uploads,
    failNext(status, body) {
      failure = { status, body };
    },
    close() {
      server.stop(true);
    },
  };
}
