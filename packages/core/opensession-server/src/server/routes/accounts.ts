/**
 * Claude subscription pool + Codex (OpenAI) account pool + xAI (SuperGrok)
 * account pool. Tokens only ever returned masked.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { ownerRefNamesSignedInUser } from "../shared/user-mappings";
import { isHostOperator } from "./memory-diagnostics";
import {
  type AccountWriteForbidden,
  type AccountWriteGuard,
  addAccount,
  addClaudeApiAccount,
  getAccountById,
  listAccountsPublic,
  refreshAllUsage,
  removeAccount,
  returnAccountToPool,
  setAccountLabel,
  setAccountOwner,
} from "../claude-accounts";
import {
  claudeFederationSetup,
  isClaudeApiAccount,
} from "../claude-api-credentials";
import { designatedBridgeAccountIds } from "../model-providers";
import {
  addCodexAccount,
  listCodexAccountsPublic,
  refreshAllCodexUsage,
  removeCodexAccount,
  setCodexAccountLabel,
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
  setXaiAccountLabel,
  setXaiAccountOwner,
} from "../xai-accounts";
import {
  cancelXaiDeviceLogin,
  getXaiDeviceLogin,
  startXaiDeviceLogin,
} from "../xai-device-login";

/** A PUT body that renames the account: {"label": "Team"}, or "" to show
 *  the email again. */
function isRename(body: unknown): body is { label: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { label?: unknown }).label === "string"
  );
}

/**
 * API accounts spend an Anthropic organization's money, so only the host
 * operator, or the person a personal API account belongs to, may rename,
 * reassign, return, or remove one. Subscription accounts keep the pool's
 * existing rules. Undefined means the caller may go ahead (or the account
 * does not exist, which the route answers itself).
 */
/** Who may change a Claude API account: its owner or the host operator. The
 *  writers re-run this against the record inside the store transaction. */
function apiAccountChangeGuard(ctx: RouteContext): AccountWriteGuard {
  return (account) => {
    if (!isClaudeApiAccount(account) || isHostOperator(ctx)) return undefined;
    if (ctx.authUser && ownerRefNamesSignedInUser(account.owner, ctx.authUser))
      return undefined;
    return account.owner
      ? "Only this account's owner or the host operator can change it."
      : "Only the host operator can change a shared Claude API account.";
  };
}

function apiAccountChangeForbidden(
  ctx: RouteContext,
  id: string,
): Response | undefined {
  const account = getAccountById(id);
  const forbidden = account && apiAccountChangeGuard(ctx)(account);
  return forbidden ? forbiddenResponse(forbidden) : undefined;
}

function forbiddenResponse(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

function foundOr404(
  updated: object | AccountWriteForbidden | null | boolean,
): Response {
  if (updated && typeof updated === "object" && "forbidden" in updated)
    return forbiddenResponse(updated.forbidden);
  return updated
    ? Response.json(updated === true ? { ok: true } : updated)
    : Response.json({ error: "Not found" }, { status: 404 });
}

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

  // Claude API accounts (API key or Workload Identity Federation). Keep these
  // ahead of the generic /claude-accounts/:id matchers.
  if (path === "/api/claude-accounts/api" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (typeof body?.name !== "string" || !body.name.trim()) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }
    // Federation spends whatever organization trusts this server's issuer,
    // with no secret from the caller, so enrolling one is the operator's call.
    if (body.federation != null && !isHostOperator(ctx))
      return Response.json(
        {
          error:
            "Only the host operator can add a workload identity account. Add a Claude API key instead, or ask the operator.",
        },
        { status: 403 },
      );
    const result = await addClaudeApiAccount({
      name: body.name,
      owner: typeof body.owner === "string" ? body.owner : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      federation: body.federation ?? undefined,
    });
    if ("error" in result) return Response.json(result, { status: 400 });
    // bridge.accounts fences Anthropic runs to the accounts it names; a new
    // account outside it serves nothing until an operator adds its id.
    const designated = designatedBridgeAccountIds();
    if (designated.length && !designated.includes(result.id))
      return Response.json({
        ...result,
        warning: `Mythos runs can't use this account yet: add its id (${result.id}) to bridge.accounts in model-providers.json, which limits Claude runs to the accounts it lists.`,
      });
    return Response.json(result);
  }
  if (
    path === "/api/claude-accounts/federation-setup" &&
    req.method === "GET"
  ) {
    return Response.json({
      ...(await claudeFederationSetup()),
      canEnroll: isHostOperator(ctx),
    });
  }

  if (path === "/api/claude-accounts/refresh" && req.method === "POST") {
    await refreshAllUsage({ recheckMythos: true });
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

  // Clear an account's sidelines after its limit was reset at Anthropic.
  const returnMatch = path.match(
    /^\/api\/claude-accounts\/([^/]+)\/return-to-pool$/,
  );
  if (returnMatch && req.method === "POST") {
    const forbidden = apiAccountChangeForbidden(
      ctx,
      decodeURIComponent(returnMatch[1]),
    );
    if (forbidden) return forbidden;
    return foundOr404(returnAccountToPool(decodeURIComponent(returnMatch[1])));
  }

  const accountDelMatch = path.match(/^\/api\/claude-accounts\/([^/]+)$/);
  if (accountDelMatch && (req.method === "DELETE" || req.method === "PUT")) {
    const forbidden = apiAccountChangeForbidden(
      ctx,
      decodeURIComponent(accountDelMatch[1]),
    );
    if (forbidden) return forbidden;
  }
  if (accountDelMatch && req.method === "DELETE") {
    return foundOr404(
      await removeAccount(
        decodeURIComponent(accountDelMatch[1]),
        apiAccountChangeGuard(ctx),
      ),
    );
  }
  // Set/clear an account's personal owner ({"owner": "Alex"} or "").
  if (accountDelMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (isRename(body)) {
      return foundOr404(
        await setAccountLabel(
          decodeURIComponent(accountDelMatch[1]),
          body.label,
          apiAccountChangeGuard(ctx),
        ),
      );
    }
    return foundOr404(
      await setAccountOwner(
        decodeURIComponent(accountDelMatch[1]),
        typeof body?.owner === "string" ? body.owner : undefined,
        typeof body?.credentialsPath === "string"
          ? body.credentialsPath
          : undefined,
        apiAccountChangeGuard(ctx),
      ),
    );
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
    const result = await addCodexAccount(
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
    let result = await startDeviceLogin(
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
    return (await removeCodexAccount(
      decodeURIComponent(codexAccountDelMatch[1]),
    ))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  // Set/clear an account's personal owner ({"owner": "Alex"} or "").
  if (codexAccountDelMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (isRename(body)) {
      return foundOr404(
        await setCodexAccountLabel(
          decodeURIComponent(codexAccountDelMatch[1]),
          body.label,
        ),
      );
    }
    const updated = await setCodexAccountOwner(
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
    return (await removeXaiAccount(decodeURIComponent(xaiAccountMatch[1])))
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  // Set/clear an account's personal owner ({"owner": "Alex"} or "").
  if (xaiAccountMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (isRename(body)) {
      return foundOr404(
        await setXaiAccountLabel(
          decodeURIComponent(xaiAccountMatch[1]),
          body.label,
        ),
      );
    }
    const updated = await setXaiAccountOwner(
      decodeURIComponent(xaiAccountMatch[1]),
      typeof body?.owner === "string" ? body.owner : undefined,
    );
    return updated
      ? Response.json(updated)
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  return undefined;
}
