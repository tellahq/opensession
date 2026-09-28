/**
 * Daytona file writes over the SDK's signed upload URL.
 *
 * `sandbox.fs.uploadFile` builds its multipart body with the `form-data`
 * package, which the SDK loads with a runtime `require`. A `bun build
 * --compile` binary ships no `node_modules`, so that require fails and every
 * Daytona write (qualification, run specs, projected credentials) breaks on a
 * compiled install. `sandbox.uploadUrl(path)` returns a pre-signed toolbox URL
 * for the same `files/upload-v2` operation; POSTing the platform `FormData` to
 * it needs no extra module. That endpoint takes the multipart field `file`,
 * creates missing parent directories, and overwrites an existing file.
 *
 * Uploads can carry projected credentials, and the signed URL is a
 * short-lived bearer credential. Errors therefore name only the stage, the
 * destination path, and an HTTP status: never a provider, transport, or
 * signing message, a response body, or a cause, any of which could echo the
 * file, headers, the URL, or key material. Nothing here is logged.
 */

/** Signed URLs outlive the request only briefly. Never 0: that never expires. */
export const DAYTONA_UPLOAD_URL_TTL_SECONDS = 120;
/** Upper bound on one upload request. */
export const DAYTONA_UPLOAD_TIMEOUT_MS = 120_000;

export interface DaytonaUploadTarget {
  uploadUrl(path: string, ttlSeconds?: number): Promise<string>;
}

export interface DaytonaUploadOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/** Release the response without reading it; the outcome is its status. */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

/**
 * Write `content` byte for byte to `path` inside the sandbox. Strings are
 * encoded as UTF-8; binary content is sent unchanged.
 */
export async function uploadDaytonaFile(
  sandbox: DaytonaUploadTarget,
  path: string,
  content: string | Uint8Array,
  options: DaytonaUploadOptions = {},
): Promise<void> {
  const bytes = Buffer.from(content);
  let url: string;
  try {
    url = await sandbox.uploadUrl(path, DAYTONA_UPLOAD_URL_TTL_SECONDS);
  } catch {
    throw new Error(`Daytona upload to ${path} failed: could not sign URL`);
  }
  const form = new FormData();
  const name = path.split("/").filter(Boolean).pop() || "file";
  form.append(
    "file",
    new Blob([bytes], { type: "application/octet-stream" }),
    name,
  );
  const doFetch = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(
    options.timeoutMs ?? DAYTONA_UPLOAD_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      body: form,
      // Never forward the file (or the signed URL) to another origin.
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error(
      `Daytona upload to ${path} failed: ${signal.aborted ? "timed out" : "request failed"}`,
    );
  }
  discardBody(response);
  if (!response.ok) {
    throw new Error(
      `Daytona upload to ${path} failed: HTTP ${response.status}`,
    );
  }
}
