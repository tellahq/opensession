/**
 * code.storage connection setup — connect the org + signing key entirely from
 * the web UI, no config-file editing. Part of the /api/setup family
 * (dispatched from setup.ts):
 *
 *   POST /api/setup/codestorage/connect    — validate + store the pasted PKCS8
 *                                            key, persist integrations.codestorage,
 *                                            probe the org's repo list.
 *   GET  /api/setup/codestorage/status     — configured/org/repoCount (60s-cached
 *                                            probe) + webhook receiver info
 *                                            (secret, last delivery, sync warnings).
 *   POST /api/setup/codestorage/disconnect — remove the integration config
 *                                            (the key file is left on disk).
 *
 * AUTHZ: like the rest of the /api/setup family (see setup.ts), the global
 * web-auth gate in opensession.ts is the authorization — these paths are not
 * in the gate's exempt list, so with web sign-in active every request already
 * requires a signed-in team member. No route here does its own auth.
 *
 * The webhook secret is generated once (crypto.randomBytes) and persisted on
 * the first connect/status call; the inbound receiver itself lives in
 * codestorage/webhook.ts. Connecting also registers the receiver route on the
 * live webhook server (addWebhookRoute) so deliveries work immediately — the
 * boot-time registration via CodeStorageIntegration.getRoutes() takes over on
 * the next restart.
 */

import { randomBytes } from "crypto";
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { audit } from "../audit";
import { importPkcs8Pem } from "../codestorage/auth";
import { listRepos as listCsRepos } from "../codestorage/client";
import { csWebhookState, handleCsWebhook } from "../codestorage/webhook";
import { codeStorageConfig, configPath } from "../config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import { addWebhookRoute } from "../webhook-server";
import type { RouteContext } from "./context";
import { invalidateCsRepoListCache } from "./setup-repos";

const CS_WEBHOOK_ROUTE_KEY = "POST /codestorage/webhook";
const CS_WEBHOOK_PATH = "/codestorage/webhook";

/** The `<org>.code.storage` subdomain / JWT `iss` — DNS-label shaped. */
const CS_ORG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The signing key lives next to config.json (~/.opensession/codestorage.pem
 *  in the standard profile), so every profile keeps it inside its own state. */
function keyFilePath(): string {
  return `${dirname(configPath())}/codestorage.pem`;
}

/** The integration section key to write: respect an existing camelCase
 *  `codeStorage` section (both spellings are read and camel wins in
 *  codeStorageConfig()) so a hand-edited config keeps one section. */
function integrationsSection(config: Record<string, unknown>): {
  integrations: Record<string, unknown>;
  section: Record<string, unknown>;
  key: string;
} {
  const integrations =
    config.integrations &&
    typeof config.integrations === "object" &&
    !Array.isArray(config.integrations)
      ? (config.integrations as Record<string, unknown>)
      : {};
  config.integrations = integrations;
  const key =
    integrations.codeStorage &&
    typeof integrations.codeStorage === "object" &&
    !Array.isArray(integrations.codeStorage)
      ? "codeStorage"
      : "codestorage";
  const section =
    integrations[key] &&
    typeof integrations[key] === "object" &&
    !Array.isArray(integrations[key])
      ? (integrations[key] as Record<string, unknown>)
      : {};
  integrations[key] = section;
  return { integrations, section, key };
}

/** Turn a listRepos failure into the precise story the UI can show: the key
 *  parsed but the host rejected the JWT (registration problem) vs the org's
 *  API host being unreachable (wrong org / network). */
function classifyCsError(e: unknown, org: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed: 40[13]\b/.test(msg)) {
    return (
      `code.storage rejected the signed token (${msg}). The private key parsed, ` +
      `but its public half doesn't seem to be registered for org "${org}" — ` +
      `register it in the Pierre dashboard (key management) and try again.`
    );
  }
  if (
    /timed out|timeout|aborted|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|Unable to connect/i.test(
      msg,
    )
  ) {
    return `Couldn't reach https://api.${org}.code.storage (${msg}). Check the org identifier and network path.`;
  }
  return msg;
}

// 60s cheap-status cache for the repo-list probe, so the Connections card's
// refetches don't hammer the org API. Reset on connect/disconnect.
let statusProbeCache: {
  at: number;
  repoCount?: number;
  error?: string;
} | null = null;
const STATUS_PROBE_TTL_MS = 60_000;
const STATUS_PROBE_TIMEOUT_MS = 8_000;

async function probeRepoCount(
  org: string,
): Promise<{ repoCount?: number; error?: string }> {
  if (
    statusProbeCache &&
    Date.now() - statusProbeCache.at < STATUS_PROBE_TTL_MS
  ) {
    return statusProbeCache;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const repos = await Promise.race([
      listCsRepos(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("status probe timed out")),
          STATUS_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    statusProbeCache = { at: Date.now(), repoCount: repos.length };
  } catch (e) {
    statusProbeCache = { at: Date.now(), error: classifyCsError(e, org) };
  } finally {
    clearTimeout(timer);
  }
  return statusProbeCache;
}

/** Generate + persist the webhook secret if the configured integration lacks
 *  one. Call only when codeStorageConfig() is non-null. */
async function ensureWebhookSecret(): Promise<void> {
  if (codeStorageConfig()?.webhookSecret) return;
  await withConfigMutationLock(async () => {
    if (codeStorageConfig()?.webhookSecret) return; // raced another caller
    const config = rawConfig();
    const { section } = integrationsSection(config);
    if (typeof section.webhookSecret === "string" && section.webhookSecret)
      return;
    section.webhookSecret = randomBytes(32).toString("hex");
    persistRawConfig(config);
  });
}

export async function handleSetupCodestorageRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/setup/codestorage/connect" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      org?: unknown;
      privateKeyPem?: unknown;
    } | null;
    const org =
      typeof body?.org === "string" ? body.org.trim().toLowerCase() : "";
    if (!CS_ORG_RE.test(org)) {
      return Response.json(
        {
          error:
            "org must be the code.storage organization identifier — the <org>.code.storage subdomain (letters, digits, hyphens)",
        },
        { status: 400 },
      );
    }
    const pem =
      typeof body?.privateKeyPem === "string" ? body.privateKeyPem.trim() : "";
    if (!pem.includes("-----BEGIN")) {
      return Response.json(
        { error: "privateKeyPem must be a PEM-encoded private key" },
        { status: 400 },
      );
    }
    try {
      await importPkcs8Pem(pem);
    } catch {
      return Response.json(
        {
          error:
            "privateKeyPem did not parse as a PKCS8 EC P-256 or RSA private key. " +
            "Export it unencrypted in PKCS8 form (`openssl pkcs8 -topk8 -nocrypt`).",
        },
        { status: 400 },
      );
    }

    const keyPath = keyFilePath();
    await withConfigMutationLock(async () => {
      // 0600 from birth (temp file created with the mode, then atomic rename)
      // — the key is the whole org credential.
      mkdirSync(dirname(keyPath), { recursive: true });
      const tmp = `${keyPath}.tmp.${process.pid}`;
      writeFileSync(tmp, pem.endsWith("\n") ? pem : `${pem}\n`, {
        mode: 0o600,
      });
      renameSync(tmp, keyPath);
      const config = rawConfig();
      const { section } = integrationsSection(config);
      const prevOrg = typeof section.org === "string" ? section.org : undefined;
      section.enabled = true;
      section.org = org;
      section.privateKeyPath = keyPath;
      // A custom apiBase persisted for a different org would now point at the
      // wrong host — drop it; the default derives from the new org.
      if (prevOrg && prevOrg !== org) delete section.apiBase;
      if (typeof section.webhookSecret !== "string" || !section.webhookSecret) {
        section.webhookSecret = randomBytes(32).toString("hex");
      }
      persistRawConfig(config);
    });
    audit({ kind: "setup_codestorage_connect", org, keyPath });
    invalidateCsRepoListCache();
    // Live in this process without a restart; boot-time registration (via the
    // integration's getRoutes()) takes over from the next restart on.
    addWebhookRoute(CS_WEBHOOK_ROUTE_KEY, (r) => handleCsWebhook(r));

    // Validate: one real API round-trip with the freshly stored key. Nothing
    // is rolled back on failure — the config stays so status keeps reporting
    // the same precise error until the operator fixes the key or org.
    try {
      const repos = await listCsRepos();
      statusProbeCache = { at: Date.now(), repoCount: repos.length };
      return Response.json({ ok: true, org, repoCount: repos.length });
    } catch (e) {
      const error = classifyCsError(e, org);
      statusProbeCache = { at: Date.now(), error };
      return Response.json({ ok: false, org, error }, { status: 502 });
    }
  }

  if (path === "/api/setup/codestorage/status" && req.method === "GET") {
    let cfg = codeStorageConfig();
    if (!cfg) return Response.json({ configured: false });
    // First-touch provisioning: a hand-edited config gets its webhook secret
    // (and the live receiver route) on the first status read.
    if (!cfg.webhookSecret) {
      await ensureWebhookSecret();
      cfg = codeStorageConfig() ?? cfg;
    }
    addWebhookRoute(CS_WEBHOOK_ROUTE_KEY, (r) => handleCsWebhook(r));
    const probe = await probeRepoCount(cfg.org);
    const wh = csWebhookState();
    return Response.json({
      configured: true,
      org: cfg.org,
      keyPath: cfg.privateKeyPath,
      ...(probe.repoCount !== undefined ? { repoCount: probe.repoCount } : {}),
      ...(probe.error ? { error: probe.error } : {}),
      webhook: {
        path: CS_WEBHOOK_PATH,
        port: 3860,
        secret: cfg.webhookSecret ?? "",
        lastDelivery: wh.lastDelivery,
        lastRejected: wh.lastRejected,
        rejectedCount: wh.rejectedCount,
        syncFailures: Object.entries(wh.syncFailures).map(([repo, f]) => ({
          repo,
          ...f,
        })),
      },
    });
  }

  if (path === "/api/setup/codestorage/disconnect" && req.method === "POST") {
    const cfg = codeStorageConfig();
    if (!cfg) return Response.json({ ok: true, wasConfigured: false });
    await withConfigMutationLock(async () => {
      const config = rawConfig();
      const integrations =
        config.integrations &&
        typeof config.integrations === "object" &&
        !Array.isArray(config.integrations)
          ? (config.integrations as Record<string, unknown>)
          : {};
      delete integrations.codestorage;
      delete integrations.codeStorage;
      persistRawConfig(config);
    });
    statusProbeCache = null;
    invalidateCsRepoListCache();
    audit({ kind: "setup_codestorage_disconnect", org: cfg.org });
    return Response.json({
      ok: true,
      keyFileKept: cfg.privateKeyPath,
      note: `Disconnected. The private key file was left at ${cfg.privateKeyPath} — delete it yourself once the key is retired.`,
    });
  }

  return undefined;
}
