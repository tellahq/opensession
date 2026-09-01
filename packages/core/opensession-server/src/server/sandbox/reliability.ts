import type { Sandbox, SandboxProvider, SandboxSessionSpec } from "./provider";

const TRANSIENT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const PERMANENT_MESSAGE =
  /(?:api[ -]?key|credential|token|unauthori[sz]ed|forbidden|permission|billing|quota|rate.?limit|plan allows|per day|not configured|not ready|invalid|unsupported|attached repos?|kill switch|disabled)/i;
const TRANSIENT_MESSAGE =
  /(?:timed? ?out|temporar(?:y|ily) unavailable|connection (?:reset|refused)|fetch failed|network (?:error|unreachable)|\b(?:408|425|500|502|503|504)\b|ECONN|ETIMEDOUT|UND_ERR_)/i;

function errorValues(error: unknown): unknown[] {
  const values: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth++) {
    values.push(current);
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return values;
}

/** Retry only failures that are clearly transport/service transients. */
export function isTransientSandboxStartError(error: unknown): boolean {
  const values = errorValues(error);
  const message = values
    .map((value) =>
      value instanceof Error
        ? value.message
        : typeof value === "string"
          ? value
          : "",
    )
    .filter(Boolean)
    .join(" ");
  if (PERMANENT_MESSAGE.test(message)) return false;
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      TRANSIENT_CODES.has(candidate.code)
    )
      return true;
    const status = Number(candidate.status ?? candidate.statusCode);
    // A blind sub-second retry cannot help a 429 and can consume another
    // provider start from a daily quota. Providers may expose a future
    // Retry-After-aware path, but generic session creation must fail once.
    if ([408, 425, 500, 502, 503, 504].includes(status)) return true;
  }
  return TRANSIENT_MESSAGE.test(message);
}

/**
 * One bounded retry around idempotent provider ensure(). Agent launch itself is
 * never retried: after that boundary a second attempt could duplicate a run.
 */
export async function ensureSandboxWithTransientRetry(
  provider: SandboxProvider,
  spec: SandboxSessionSpec,
  options: { delayMs?: number; onRetry?: (error: unknown) => void } = {},
): Promise<Sandbox> {
  try {
    return await provider.ensure(spec);
  } catch (error) {
    if (!isTransientSandboxStartError(error)) throw error;
    options.onRetry?.(error);
    await Bun.sleep(options.delayMs ?? 500);
    return provider.ensure(spec);
  }
}
