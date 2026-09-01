/**
 * Linear OAuth flow and token management.
 */
import { connectResultPage } from "../../server/connect-result-page";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { randomBytes, timingSafeEqual } from "crypto";
import {
  configuredIntegration,
  configuredServer,
  personaName,
} from "../../server/config";

const LINEAR_CLIENT_ID = process.env.LINEAR_CLIENT_ID || "";
const LINEAR_CLIENT_SECRET = process.env.LINEAR_CLIENT_SECRET || "";
const TOKENS_FILE = `${process.env.HOME}/.linear-agent-tokens.json`;
const STATE_COOKIE = "__Host-linear-oauth-state";
const STATE_TTL_SECONDS = 10 * 60;

function redirectUri(): string {
  const configured = configuredIntegration("linear").oauthRedirectUrl;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : `${configuredServer().webhookBaseUrl.replace(/\/+$/, "")}/oauth/callback`;
}

export interface LinearTokens {
  [orgId: string]: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

export async function loadTokens(): Promise<LinearTokens> {
  try {
    const file = Bun.file(TOKENS_FILE);
    if (await file.exists()) {
      return JSON.parse(await file.text());
    }
    return {};
  } catch {
    return {};
  }
}

export async function saveTokens(tokens: LinearTokens): Promise<void> {
  writeJsonAtomic(TOKENS_FILE, tokens);
}

export async function refreshToken(
  orgId: string,
  tokens: LinearTokens,
): Promise<boolean> {
  const tokenData = tokens[orgId];
  if (!tokenData?.refreshToken) {
    console.error(`[linear] No refresh token for org: ${orgId}`);
    return false;
  }

  console.log(`[linear] Refreshing token for org: ${orgId}`);

  try {
    const response = await fetchWithTimeout(
      "https://api.linear.app/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: LINEAR_CLIENT_ID,
          client_secret: LINEAR_CLIENT_SECRET,
          refresh_token: tokenData.refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );

    const data = await response.json();
    if (data.access_token) {
      tokens[orgId] = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || tokenData.refreshToken,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
      await saveTokens(tokens);
      console.log(`[linear] Token refreshed successfully for org: ${orgId}`);
      return true;
    } else {
      console.error(`[linear] Failed to refresh token:`, data);
      return false;
    }
  } catch (e) {
    console.error(`[linear] Error refreshing token:`, e);
    return false;
  }
}

export async function getValidToken(
  orgId: string,
  tokens: LinearTokens,
): Promise<string | null> {
  const tokenData = tokens[orgId];
  if (!tokenData) return null;

  const isExpired =
    tokenData.expiresAt && tokenData.expiresAt < Date.now() + 5 * 60 * 1000;
  if (isExpired) {
    const refreshed = await refreshToken(orgId, tokens);
    if (!refreshed) return null;
  }

  return tokens[orgId]?.accessToken || null;
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name && value.length) return value.join("=");
  }
  return null;
}

function stateCookie(state: string, maxAge: number): string {
  return `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function statesMatch(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function consumeState(response: Response): Response {
  response.headers.append("Set-Cookie", stateCookie("", 0));
  return response;
}

export function handleAuthorize(): Response {
  const state = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: LINEAR_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "app:assignable read write",
    actor: "app",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://linear.app/oauth/authorize?${params}`,
      "Set-Cookie": stateCookie(state, STATE_TTL_SECONDS),
    },
  });
}

// Every exit here lands in a person's browser, so they all render the shared
// connect-result card rather than raw text (and never Linear's own JSON, which
// is a token response).
function failed(message: string): Response {
  return connectResultPage({
    ok: false,
    server: "linear",
    title: "Linear not authorized",
    message,
    action: { href: "/oauth/authorize", label: "Try again" },
    status: 400,
  });
}

export async function handleCallback(
  req: Request,
  url: URL,
  tokens: LinearTokens,
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookieValue(req, STATE_COOKIE);
  if (!statesMatch(state, expectedState)) {
    return consumeState(
      failed("The authorization could not be verified. Start again."),
    );
  }
  if (!code) {
    return consumeState(
      failed(
        "The redirect came back without a code, so nothing was authorized.",
      ),
    );
  }

  const response = await fetchWithTimeout(
    "https://api.linear.app/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: LINEAR_CLIENT_ID,
        client_secret: LINEAR_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    },
  );

  const data = await response.json();
  if (data.access_token) {
    const orgResponse = await fetchWithTimeout(
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.access_token}`,
        },
        body: JSON.stringify({ query: "{ organization { id name } }" }),
      },
    );
    const orgData = await orgResponse.json();
    const orgId = orgData.data?.organization?.id;
    const orgName = orgData.data?.organization?.name;

    if (orgId) {
      tokens[orgId] = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
      await saveTokens(tokens);
      return consumeState(
        connectResultPage({
          ok: true,
          server: "linear",
          title: "Linear authorized",
          message: `${personaName()} can pick up tickets in ${orgName} now.`,
          action: { close: true },
        }),
      );
    }
    return consumeState(
      failed("Linear authorized, but did not say which workspace. Try again."),
    );
  }

  return consumeState(
    failed(
      data?.error_description ||
        data?.error ||
        "Linear did not return an access token.",
    ),
  );
}
