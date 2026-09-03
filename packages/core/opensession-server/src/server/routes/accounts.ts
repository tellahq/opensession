/**
 * Claude subscription pool + Codex (OpenAI) account pool + xAI (SuperGrok)
 * account pool. Tokens only ever returned masked.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import {
  addAccount,
  listAccountsPublic,
  refreshAllUsage,
  removeAccount,
  setAccountOwner,
} from "../claude-accounts";
import {
  addCodexAccount,
  listCodexAccountsPublic,
  refreshAllCodexUsage,
  removeCodexAccount,
  setCodexAccountOwner,
} from "../codex-accounts";
import {
  cancelDeviceLogin,
  getDeviceLogin,
  startDeviceLogin,
} from "../codex-device-login";
import {
  cancelCodexOauthLogin,
  completeCodexOauthLogin,
  startCodexOauthLogin,
} from "../codex-oauth-login";
import {
  cancelClaudeLogin,
  completeClaudeLogin,
  startClaudeLogin,
} from "../claude-oauth-login";
import {
  listXaiAccountsPublic,
  refreshXaiUsage,
  removeXaiAccount,
  setXaiAccountOwner,
} from "../xai-accounts";
import {
  cancelXaiDeviceLogin,
  getXaiDeviceLogin,
  startXaiDeviceLogin,
} from "../xai-device-login";

export async function handleAccountsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // ── Claude account pool (tokens are never sent back, only masked) ──
  if (path === "/api/claude-accounts" && req.method === "GET") {
    return Response.json({ accounts: listAccountsPublic() });
  }

  if (path === "/api/claude-accounts" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body?.name || !body?.token) {
      return Response.json(
        { error: "name and token are required" },
        { status: 400 },
      );
    }
    const result = await addAccount(
      body.name,
      body.token,
      typeof body.owner === "string" ? body.owner : undefined,
      typeof body.credentialsPath === "string"
        ? body.credentialsPath
        : undefined,
    );
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  if (path === "/api/claude-accounts/refresh" && req.method === "POST") {
    await refreshAllUsage();
    return Response.json({ accounts: listAccountsPublic() });
  }

  // "Sign in with Claude" attaches usage OAuth to an existing setup-token
  // account. Keep this ahead of the generic /claude-accounts/:id matchers.
  if (path === "/api/claude-accounts/oauth-login" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (typeof body?.accountId !== "string" || !body.accountId) {
      return Response.json({ error: "accountId is required" }, { status: 400 });
    }
    const result = await startClaudeLogin(body.accountId);
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }
  const oauthLoginMatch = path.match(
    /^\/api\/claude-accounts\/oauth-login\/([^/]+)$/,
  );
  if (oauthLoginMatch && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (typeof body?.code !== "string" || !body.code.trim()) {
      return Response.json({ error: "code is required" }, { status: 400 });
    }
    const result = await completeClaudeLogin(
      decodeURIComponent(oauthLoginMatch[1]),
      body.code,
    );
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }
  if (oauthLoginMatch && req.method === "DELETE") {
    return cancelClaudeLogin(decodeURIComponent(oauthLoginMatch[1]))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  const accountDelMatch = path.match(/^\/api\/claude-accounts\/([^/]+)$/);
  if (accountDelMatch && req.method === "DELETE") {
    return removeAccount(decodeURIComponent(accountDelMatch[1]))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  // Set/clear an account's personal owner ({"owner": "Alex"} or "").
  if (accountDelMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const updated = setAccountOwner(
      decodeURIComponent(accountDelMatch[1]),
      typeof body?.owner === "string" ? body.owner : undefined,
      typeof body?.credentialsPath === "string"
        ? body.credentialsPath
        : undefined,
    );
    return updated
      ? Response.json(updated)
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  // ── Codex (OpenAI) account pool ──
  if (path === "/api/codex-accounts" && req.method === "GET") {
    return Response.json({ accounts: listCodexAccountsPublic() });
  }

  if (path === "/api/codex-accounts/refresh" && req.method === "POST") {
    await refreshAllCodexUsage();
    return Response.json({ accounts: listCodexAccountsPublic() });
  }

  if (path === "/api/codex-accounts" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (
      (!body?.name && body?.kind === "api_key") ||
      !body?.value ||
      !["api_key", "home"].includes(body?.kind)
    ) {
      return Response.json(
        {
          error:
            "kind (api_key|home) and value are required; API keys also need a name",
        },
        { status: 400 },
      );
    }
    const result = addCodexAccount(
      body.name,
      body.kind,
      body.value,
      typeof body.owner === "string" ? body.owner : undefined,
    );
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  // ── Paste-link ChatGPT sign-in (PKCE; for device-auth-disabled workspaces) ──
  // Keep these ahead of the generic /codex-accounts/:id matchers.
  if (path === "/api/codex-accounts/oauth-login" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const result = await startCodexOauthLogin(
      typeof body?.name === "string" ? body.name : "",
      typeof body?.owner === "string" ? body.owner : undefined,
    );
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }
  const codexOauthMatch = path.match(
    /^\/api\/codex-accounts\/oauth-login\/([^/]+)$/,
  );
  if (codexOauthMatch && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (typeof body?.code !== "string" || !body.code.trim()) {
      return Response.json({ error: "code is required" }, { status: 400 });
    }
    const result = await completeCodexOauthLogin(
      decodeURIComponent(codexOauthMatch[1]),
      body.code,
    );
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }
  if (codexOauthMatch && req.method === "DELETE") {
    return cancelCodexOauthLogin(decodeURIComponent(codexOauthMatch[1]))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  // ── Device-code sign-in (browser-free `codex login --device-auth`) ──
  if (path === "/api/codex-accounts/device-login" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    let result = startDeviceLogin(
      typeof body?.name === "string" ? body.name : "",
      typeof body?.owner === "string" ? body.owner : undefined,
    );
    // A failed start has no id — a started login may carry a (later) error
    // field too, so keying the status on "error" alone 400s successes.
    if (!("id" in result)) return Response.json(result, { status: 400 });
    // Give the CLI a moment to print the URL + code so the UI can render
    // them from this response; the client keeps polling either way.
    for (let i = 0; i < 25 && result.state === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 160));
      result = getDeviceLogin(result.id) ?? result;
    }
    return Response.json(result);
  }

  const deviceLoginMatch = path.match(
    /^\/api\/codex-accounts\/device-login\/([^/]+)$/,
  );
  if (deviceLoginMatch && req.method === "GET") {
    const login = getDeviceLogin(decodeURIComponent(deviceLoginMatch[1]));
    return login
      ? Response.json(login)
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  if (deviceLoginMatch && req.method === "DELETE") {
    return cancelDeviceLogin(decodeURIComponent(deviceLoginMatch[1]))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  const codexAccountDelMatch = path.match(/^\/api\/codex-accounts\/([^/]+)$/);
  if (codexAccountDelMatch && req.method === "DELETE") {
    return removeCodexAccount(decodeURIComponent(codexAccountDelMatch[1]))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  // Set/clear an account's personal owner ({"owner": "Alex"} or "").
  if (codexAccountDelMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const updated = setCodexAccountOwner(
      decodeURIComponent(codexAccountDelMatch[1]),
      typeof body?.owner === "string" ? body.owner : undefined,
    );
    return updated
      ? Response.json(updated)
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  // ── xAI (SuperGrok) account pool: device-code sign-in only ──
  if (path === "/api/xai-accounts" && req.method === "GET") {
    return Response.json({ accounts: listXaiAccountsPublic() });
  }

  if (path === "/api/xai-accounts/refresh" && req.method === "POST") {
    await refreshXaiUsage();
    return Response.json({ accounts: listXaiAccountsPublic() });
  }

  if (path === "/api/xai-accounts/device-login" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    let result = startXaiDeviceLogin(
      typeof body?.owner === "string" ? body.owner : undefined,
    );
    // Give xAI a moment to answer with the URL + code so the UI can render
    // them from this response; the client keeps polling either way.
    for (let i = 0; i < 25 && result.state === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 160));
      result = getXaiDeviceLogin(result.id) ?? result;
    }
    return Response.json(result);
  }

  const xaiLoginMatch = path.match(
    /^\/api\/xai-accounts\/device-login\/([^/]+)$/,
  );
  if (xaiLoginMatch && req.method === "GET") {
    const login = getXaiDeviceLogin(decodeURIComponent(xaiLoginMatch[1]));
    return login
      ? Response.json(login)
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  if (xaiLoginMatch && req.method === "DELETE") {
    return cancelXaiDeviceLogin(decodeURIComponent(xaiLoginMatch[1]))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  const xaiAccountMatch = path.match(/^\/api\/xai-accounts\/([^/]+)$/);
  if (xaiAccountMatch && req.method === "DELETE") {
    return removeXaiAccount(decodeURIComponent(xaiAccountMatch[1]))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  // Set/clear an account's personal owner ({"owner": "Alex"} or "").
  if (xaiAccountMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const updated = setXaiAccountOwner(
      decodeURIComponent(xaiAccountMatch[1]),
      typeof body?.owner === "string" ? body.owner : undefined,
    );
    return updated
      ? Response.json(updated)
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  return undefined;
}
