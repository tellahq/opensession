/**
 * Direct GitHub GraphQL reads with the App installation token, without
 * spawning `gh`.
 *
 * Going straight to the API gives us what `gh api graphql` hides: the
 * response headers and GitHub's own `rateLimit` answer. Every read query gets
 * `rateLimit { cost limit used remaining resetAt }` added, so the budget
 * telemetry records the points each consumer really spends, not only how
 * often it calls.
 *
 * GitHub can refuse a GraphQL document with HTTP 200 and an `errors` list, so
 * the body is classified as well as the status. A rate-limit refusal pauses
 * the credential through the shared backoff, and later reads during that
 * pause fail fast without a request.
 */
import { githubInstallationCredential } from "./github-app";
import { noteGithubGraphqlCall } from "./github-budget";
import { ghBackoffUntil, noteGhRateLimited } from "./github-limit";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

const GRAPHQL_URL = "https://api.github.com/graphql";
const RATE_LIMIT_SELECTION = "rateLimit { cost limit used remaining resetAt }";

export type GithubGraphqlResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; rateLimited: boolean };

/** Add the `rateLimit` selection to a read query. Mutations and documents
 * that already ask for it are returned unchanged. */
export function withRateLimitSelection(query: string): string {
  const trimmed = query.trimStart();
  if (!trimmed.startsWith("query") && !trimmed.startsWith("{")) return query;
  if (/\brateLimit\s*\{/.test(query)) return query;
  // The operation's selection set closes before any trailing fragment
  // definitions, so insert before the brace that ends the operation.
  const fragment = query.search(/\n\s*fragment\s/);
  const operationEnd = fragment === -1 ? query.length : fragment;
  const end = query.lastIndexOf("}", operationEnd);
  if (end === -1) return query;
  return `${query.slice(0, end)}  ${RATE_LIMIT_SELECTION}\n${query.slice(end)}`;
}

/** When GitHub asked us to wait until, from `retry-after` or the reset header. */
export function githubRetryAt(
  headers: Headers,
  now: number,
): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter))
    return now + Number(retryAfter) * 1000;
  const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
  return Number.isFinite(reset) && reset > now ? reset : undefined;
}

/** Whether an answer is a rate-limit refusal. GraphQL can say so with HTTP
 * 200, a typed `RATE_LIMITED` error, or an untyped "rate limit exceeded". */
export function isGithubGraphqlRateLimited(
  status: number,
  headers: Headers,
  errors: Array<{ type?: string; message?: string }> | undefined,
  body: string,
): boolean {
  if (status === 429) return true;
  if (errors?.some((error) => error.type === "RATE_LIMITED")) return true;
  if (errors?.length && headers.get("x-ratelimit-remaining") === "0")
    return true;
  if (
    errors?.some((error) =>
      /rate limit (already )?exceeded|secondary rate limit/i.test(
        error.message || "",
      ),
    )
  )
    return true;
  return (
    status === 403 &&
    (headers.get("x-ratelimit-remaining") === "0" ||
      headers.has("retry-after") ||
      /rate limit/i.test(body))
  );
}

/**
 * One GraphQL read against the installation that serves `repo`. `consumer`
 * labels the call in the budget log. Never throws.
 */
export async function githubGraphql<T>(input: {
  repo: string;
  consumer: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<GithubGraphqlResult<T>> {
  const credential = await githubInstallationCredential({ repo: input.repo });
  if (!credential)
    return {
      ok: false,
      error: "The selected GitHub bot credential is unavailable",
      rateLimited: false,
    };
  if ((await ghBackoffUntil("graphql", credential)) > Date.now())
    return {
      ok: false,
      error: "GitHub GraphQL is rate-limited for this credential",
      rateLimited: true,
    };
  const started = Date.now();
  let ok = false;
  let bucket: unknown;
  try {
    const response = await fetchWithTimeout(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "opensession",
      },
      body: JSON.stringify({
        query: withRateLimitSelection(input.query),
        variables: input.variables || {},
      }),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    bucket = json?.data?.rateLimit;
    const errors: Array<{ type?: string; message?: string }> | undefined =
      Array.isArray(json?.errors) ? json.errors : undefined;
    if (
      isGithubGraphqlRateLimited(
        response.status,
        response.headers,
        errors,
        text,
      )
    ) {
      await noteGhRateLimited(
        input.consumer,
        githubRetryAt(response.headers, Date.now()),
        "graphql",
        credential,
      );
      return {
        ok: false,
        error: "GitHub GraphQL rate limit exceeded",
        rateLimited: true,
      };
    }
    if (!response.ok || errors?.length || !json?.data) {
      const detail =
        errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `GitHub GraphQL HTTP ${response.status}`;
      return { ok: false, error: detail.slice(0, 300), rateLimited: false };
    }
    ok = true;
    return { ok: true, data: json.data as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 300), rateLimited: false };
  } finally {
    noteGithubGraphqlCall(input.consumer, Date.now() - started, ok, {
      bucket,
    });
  }
}
