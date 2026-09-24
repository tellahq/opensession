/**
 * Read a request body without allowing an untrusted peer to make us buffer an
 * arbitrary amount of data. Webhook signatures are computed over this exact
 * decoded text, so callers must read it before parsing the payload.
 */
export class RequestBodyTooLargeError extends RangeError {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

function declaredContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value === null) return null;
  // Invalid Content-Length values are handled by the HTTP server. Do not turn
  // an invalid value into an artificial size limit here.
  if (!/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Returns the request body as UTF-8 text, rejecting both an oversized declared
 * Content-Length and an oversized streamed body. The stream is cancelled as
 * soon as it exceeds the limit so the remaining upload is not buffered.
 */
export async function readRequestTextWithinLimit(
  req: Request,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(
    await readRequestBytesWithinLimit(req, maxBytes),
  );
}

/** The raw-bytes form of readRequestTextWithinLimit, with the same limits. */
export async function readRequestBytesWithinLimit(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = declaredContentLength(req.headers);
  if (declared !== null && declared > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }

  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {}
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Standard public-provider cap. Individual capability endpoints may use less. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export function webhookBodyTooLargeResponse(maxBytes: number): Response {
  return Response.json(
    { error: `Request body exceeds ${maxBytes} bytes` },
    { status: 413 },
  );
}
