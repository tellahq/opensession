/**
 * Browser-based "Sign in with ChatGPT" for the codex pool — the paste-link
 * OAuth flow (authorization code + PKCE against the Codex CLI's public
 * client id), companion to codex-device-login.ts for workspaces where
 * device-code auth is disabled in ChatGPT security settings.
 *
 * The CLI's own login spins a localhost:1455 callback server on the USER'S
 * machine; this server is headless and remote, so we use the classic
 * headless trick instead: the user opens the authorize URL on any device,
 * signs in, and lands on http://localhost:1455/auth/callback?code=… which
 * fails to load (nothing listens there) — they copy that full URL from the
 * address bar and paste it back. The code parameter is all we need; the
 * redirect URI still has to match exactly at the token exchange.
 *
 * On success we write a CODEX_HOME auth.json identical in shape to the
 * CLI's own (tokens.{id_token,access_token,refresh_token,account_id} +
 * last_refresh) and register the directory as a "home" pool account.
 * Refresh from then on is the standard single-family path: the codex CLI on
 * live turns, and codex-token-refresh.ts for idle accounts.
 *
 * Pending logins park on globalThis so a hot reload mid-flow doesn't lose
 * the PKCE verifier between "open this URL" and the paste.
 */

import { chmodSync, existsSync, mkdirSync } from "fs";
import { homeDir } from "./paths";
import { writeFileAtomic } from "./shared/atomic-write";
import {
  addCodexAccount,
  listCodexAccounts,
  type CodexAccountPublic,
} from "./codex-accounts";

const HOME = homeDir();
const ACCOUNTS_DIR = `${HOME}/.codex-accounts`;
// The Codex CLI's public OAuth client id — same family the CLI refreshes.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
// Must match the CLI's registered callback exactly, even though nothing
// listens there in this flow.
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const LOGIN_TTL_MS = 15 * 60 * 1000;

interface PendingLogin {
  id: string;
  name: string;
  owner?: string;
  slug: string;
  verifier: string;
  state: string;
  createdAt: number;
}

export interface CodexOauthLoginStart {
  id: string;
  url: string;
  name: string;
}

const pending: Map<string, PendingLogin> = ((
  globalThis as any
).__codexOauthLogins ??= new Map());

function prune(): void {
  const now = Date.now();
  for (const [id, l] of pending) {
    if (now - l.createdAt > LOGIN_TTL_MS) pending.delete(id);
  }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function jwtClaims(jwt: string): any {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

/** Begin a PKCE sign-in that will create pool account `name` on completion. */
export async function startCodexOauthLogin(
  name = "",
  owner?: string,
): Promise<CodexOauthLoginStart | { error: string }> {
  prune();
  const loginId = crypto.randomUUID();
  // Only the temporary directory needs a label. The registered account takes
  // its email from the returned ID token; `name` remains a compatibility input
  // for older clients that still send one.
  const trimmed = name.trim() || `chatgpt-${loginId.slice(0, 8)}`;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return { error: "Name must contain letters or digits" };
  if (listCodexAccounts().some((a) => a.name === trimmed)) {
    return { error: `An account named "${trimmed}" already exists` };
  }
  if (existsSync(`${ACCOUNTS_DIR}/${slug}/auth.json`)) {
    return {
      error: `${ACCOUNTS_DIR}/${slug} already holds a login — register it directly as a CODEX_HOME account instead.`,
    };
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const login: PendingLogin = {
    id: loginId,
    name: trimmed,
    ...(owner?.trim() ? { owner: owner.trim() } : {}),
    slug,
    verifier,
    state: b64url(crypto.getRandomValues(new Uint8Array(24))),
    createdAt: Date.now(),
  };
  pending.set(login.id, login);
  // The extra params mirror the CLI's own authorize request:
  // id_token_add_organizations puts the workspace/account claims in the
  // id_token (where account_id comes from).
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    state: login.state,
  })}`;
  return { id: login.id, url, name: trimmed };
}

/** The pasted value is either the full failed-to-load localhost URL or a bare
 *  authorization code. */
function parsePastedCode(
  pasted: string,
  expectedState: string,
): { code: string } | { error: string } {
  const cleaned = pasted.trim();
  if (!cleaned)
    return { error: "Paste the full localhost URL from the address bar." };
  if (cleaned.includes("://") || cleaned.startsWith("localhost")) {
    try {
      const url = new URL(
        cleaned.includes("://") ? cleaned : `http://${cleaned}`,
      );
      const code = url.searchParams.get("code");
      if (!code) {
        return {
          error:
            "That URL carries no ?code= parameter — copy the FULL address the browser " +
            "landed on after sign-in (it starts with http://localhost:1455/auth/callback).",
        };
      }
      const state = url.searchParams.get("state");
      if (state && state !== expectedState) {
        return {
          error:
            "State mismatch — this paste belongs to a different sign-in attempt. Start again.",
        };
      }
      return { code };
    } catch {
      return {
        error:
          "Couldn't parse that as a URL — paste the full address bar contents.",
      };
    }
  }
  return { code: cleaned };
}

/**
 * Exchange the pasted redirect URL (or bare code) for tokens, write the
 * CODEX_HOME, and register the pool account. On an exchange failure the
 * attempt stays alive so the user can fix a mangled paste.
 */
export async function completeCodexOauthLogin(
  id: string,
  pasted: string,
): Promise<{ account: CodexAccountPublic } | { error: string }> {
  prune();
  const login = pending.get(id);
  if (!login) return { error: "Sign-in attempt expired — start again." };
  const parsed = parsePastedCode(pasted, login.state);
  if ("error" in parsed) return parsed;

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: parsed.code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: login.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    return { error: `Token exchange failed: ${e?.message || e}` };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return {
      error: `Token exchange failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
    };
  }
  const body: any = await res.json().catch(() => null);
  if (!body?.access_token || !body?.refresh_token) {
    return { error: "Token exchange returned no usable tokens." };
  }
  // account_id (the ChatGPT-Account-Id header codex sends) lives in the
  // id_token's auth claim. Absent is tolerable — the CLI re-derives it on its
  // next real login — but log it, since backend calls may need it.
  const accountId: string | undefined =
    jwtClaims(body.id_token || "")?.["https://api.openai.com/auth"]
      ?.chatgpt_account_id || undefined;
  if (!accountId) {
    console.warn(
      `[codex-oauth-login] ${login.name}: id_token carried no chatgpt_account_id`,
    );
  }

  const dir = `${ACCOUNTS_DIR}/${login.slug}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    `${dir}/auth.json`,
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        auth_mode: "chatgpt",
        tokens: {
          id_token: body.id_token || null,
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          ...(accountId ? { account_id: accountId } : {}),
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  chmodSync(`${dir}/auth.json`, 0o600);
  pending.delete(id);

  const result = addCodexAccount(login.name, "home", dir, login.owner);
  if ("error" in result) {
    return { error: `Signed in, but registering failed: ${result.error}` };
  }
  console.log(
    `[codex-oauth-login] ${login.name} signed in and registered (${dir})`,
  );
  return { account: result };
}

export function cancelCodexOauthLogin(id: string): boolean {
  return pending.delete(id);
}
