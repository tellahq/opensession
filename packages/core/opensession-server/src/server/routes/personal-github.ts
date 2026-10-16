import { createHash } from "node:crypto";
import { personalAdmission, personalPrincipal } from "../personal-access";
import { webAuthRequired, webAuthToken } from "../web-auth";
import { personalConnectionClient } from "../personal-github/worker-client";
import type {
  PersonalConnectionClient,
  PersonalRepositoryClient,
} from "../personal-github/worker-protocol";
import { PERSONAL_CONNECTION_DISCLOSURE } from "../personal-github/disclosure";
import { PERSONAL_MANIFEST_OPERATION } from "../personal-github/manifest";
import { requestApplicationAccess, type RouteContext } from "./context";
import { PrivacyPrincipalChanged } from "../application-access";
import { PERSONAL_PRIVACY_PROTOCOL } from "../../shared/access-scope";
const headers = {
  "Cache-Control": "no-store",
  Vary: "Cookie, Authorization",
  "Referrer-Policy": "no-referrer",
};

function errorStatus(code: string): number {
  if (code === "manifest_limit") return 429;
  if (code === "app_exists") return 409;
  if (/missing|mismatch|replayed|expired/.test(code)) return 404;
  if (code === "disclosure_required" || code === "request_invalid") return 400;
  return 503;
}
class PersonalBodyError extends Error {}
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new PersonalBodyError("JSON required");
  const reader = req.body?.getReader();
  if (!reader) throw new PersonalBodyError("Body required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const signal = AbortSignal.timeout(5000);
  let onAbort!: () => void;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => {
      void reader.cancel().catch(() => {});
      reject(new PersonalBodyError("Request timed out"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), abort]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) {
        void reader.cancel().catch(() => {});
        throw new PersonalBodyError("Body too large");
      }
      chunks.push(value);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new PersonalBodyError("Invalid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new PersonalBodyError("Object required");
    return body;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Dependency seam is for synthetic route tests; production passes only ctx.
 * Registration requires the installed catalog/runtime coordinator. Credential
 * resolution is internal server RPC only and has no HTTP dispatcher. */
export async function handlePersonalGithubRoutes(
  ctx: RouteContext,
  client?: PersonalConnectionClient,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (
    path !== "/api/personal/github" &&
    !path.startsWith("/api/personal/github/") &&
    path !== "/api/personal/repos" &&
    !path.startsWith("/api/personal/repos/")
  )
    return undefined;
  const verified = personalPrincipal(ctx.authUser);
  const token = webAuthToken(req);
  if (!webAuthRequired() || !verified || !token)
    return Response.json(
      {
        code: "verified_signin_required",
        error:
          "Sign in again with GitHub to establish a verified account identity.",
      },
      { status: 401, headers },
    );
  const callback =
    path === "/api/personal/github/manifest/callback" && req.method === "GET";
  let principal;
  try {
    // The browser navigation cannot carry custom headers. Its one-use state
    // is bound to the compatible-client manifest POST and actual cookie below.
    principal = callback
      ? { githubAccountId: ctx.authUser!.githubAccountId! }
      : requestApplicationAccess(ctx).principal;
  } catch (error) {
    if (!(error instanceof PrivacyPrincipalChanged)) throw error;
    return Response.json(
      { code: error.code, error: error.code },
      { status: 409, headers },
    );
  }
  if (!principal)
    return Response.json(
      {
        code: "privacy_protocol_required",
        error: "Compatible client required",
      },
      { status: 404, headers },
    );
  const ownerGithubAccountId = principal.githubAccountId;
  // Hash only the actually authenticated credential. Never trust a body session
  // id; no raw web bearer/cookie enters worker persistence or disclosure audit.
  const context = {
    ownerGithubAccountId,
    origin: ctx.url.origin,
    browserSessionId: createHash("sha256")
      .update(`${PERSONAL_PRIVACY_PROTOCOL}:`)
      .update(token)
      .digest("hex"),
  };
  const registration = path === "/api/personal/repos" && req.method === "POST";
  if (
    !registration &&
    (path === "/api/personal/repos" || path.startsWith("/api/personal/repos/"))
  ) {
    return req.method === "GET" || req.method === "HEAD"
      ? Response.json({ error: "Not found" }, { status: 404, headers })
      : Response.json(personalAdmission(), { status: 503, headers });
  }
  const status = path === "/api/personal/github/status" && req.method === "GET";
  const mutation =
    registration ||
    (req.method === "POST" &&
      ["disclosure", "manifest", "grant", "grant/poll", "refresh"].some(
        (name) => path === `/api/personal/github/${name}`,
      )) ||
    (req.method === "DELETE" && path === "/api/personal/github/connection");
  if (!status && !callback && !mutation)
    return Response.json({ error: "Not found" }, { status: 404, headers });
  if (mutation && req.headers.get("origin") !== ctx.url.origin)
    return Response.json(
      {
        ok: false,
        code: "request_invalid",
        error:
          "Use the same browser origin to manage your personal connection.",
      },
      { status: 403, headers },
    );
  try {
    const rpc = client ?? personalConnectionClient();
    const repositoryRpc = rpc as Partial<PersonalRepositoryClient>;
    if (registration) {
      if (!repositoryRpc.repositoryAdmission || !repositoryRpc.register)
        return Response.json(personalAdmission(), { status: 503, headers });
      const body = await readBody(req);
      if (
        typeof body.appRecordId !== "string" ||
        body.appRecordId.length > 128 ||
        ![body.githubAppId, body.installationId, body.repositoryId].every(
          (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
        )
      )
        throw new PersonalBodyError("Invalid repository selection");
      const result = await repositoryRpc.register(ownerGithubAccountId, {
        appRecordId: body.appRecordId,
        githubAppId: body.githubAppId as number,
        installationId: body.installationId as number,
        repositoryId: body.repositoryId as number,
      });
      return Response.json(
        { ...result, ownerGithubAccountId },
        { status: result.ok ? 200 : errorStatus(result.code), headers },
      );
    }
    if (status) {
      const result = await rpc.call("status", ownerGithubAccountId);
      return Response.json(
        result.ok
          ? {
              ...result,
              ownerGithubAccountId,
              disclosure: PERSONAL_CONNECTION_DISCLOSURE,
              repositoryAdmission: repositoryRpc.repositoryAdmission === true,
            }
          : result,
        { status: result.ok ? 200 : errorStatus(result.code), headers },
      );
    }
    if (callback) {
      const result = await rpc.call("completeManifest", context, {
        state: ctx.url.searchParams.get("state") ?? "",
        code: ctx.url.searchParams.get("code") ?? "",
        operation: PERSONAL_MANIFEST_OPERATION,
      });
      const title = result.ok
        ? "GitHub App connected"
        : "GitHub App connection not completed";
      // No upstream message, state, conversion code or credential is rendered.
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><h1>${title}</h1><p>${result.ok ? "Return to your account settings to install and authorize your personal App." : "Return to your account settings and start again. If GitHub created an App that was not connected, remove it in GitHub settings."}</p><a href="/settings/myAccounts">Return to account settings</a></html>`,
        {
          status: result.ok ? 200 : errorStatus(result.code),
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          },
        },
      );
    }
    let result;
    if (path.endsWith("/disclosure")) {
      const body = await readBody(req);
      result = await rpc.call("acknowledgeDisclosure", context, {
        version: body.version,
        accepted: body.accepted,
      });
    } else if (path.endsWith("/manifest")) {
      const body = await readBody(req);
      result = await rpc.call(
        "beginManifest",
        context,
        typeof body.disclosureReceipt === "string"
          ? body.disclosureReceipt
          : undefined,
      );
    } else if (path.endsWith("/grant/poll")) {
      const body = await readBody(req);
      if (typeof body.flowId !== "string" || body.flowId.length > 128)
        return Response.json(
          {
            ok: false,
            code: "request_invalid",
            error: "Invalid authorization flow.",
          },
          { status: 400, headers },
        );
      result = await rpc.call("pollGrant", context, body.flowId);
    } else if (path.endsWith("/grant"))
      result = await rpc.call("startGrant", context);
    else if (path.endsWith("/refresh"))
      result = await rpc.call("refresh", ownerGithubAccountId);
    else result = await rpc.call("disconnect", ownerGithubAccountId);
    return Response.json(
      { ...result, ownerGithubAccountId },
      { status: result.ok ? 200 : errorStatus(result.code), headers },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        code:
          error instanceof PersonalBodyError
            ? "request_invalid"
            : "storage_failed",
        error: "The connection request could not be completed. Try again.",
      },
      { status: error instanceof PersonalBodyError ? 400 : 503, headers },
    );
  }
}
