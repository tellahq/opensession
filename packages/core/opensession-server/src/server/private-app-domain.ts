/** Managed private app domains: Cloudflare DNS, ACME DNS-01, and Caddy. */
import { X509Certificate, randomBytes } from "crypto";
import { resolve4 } from "dns/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { isTailnetIpv4 } from "./shared/network-address";

export type PrivateAppDnsProvider = "cloudflare" | "vercel";
export type PrivateAppHealth =
  | "ready"
  | "waiting_dns"
  | "unreachable"
  | "not_configured";

interface PrivateAppCredential {
  version: 1;
  provider: PrivateAppDnsProvider;
  domain: string;
  email: string;
  apiToken: string;
  teamId?: string;
  upstream?: string;
}

export interface PrivateAppDomainStatus {
  health: PrivateAppHealth;
  dnsProvider: PrivateAppDnsProvider | null;
  credentialConfigured: boolean;
  certificateEmailConfigured: boolean;
  certificateExpiresAt: string;
  legoInstalled: boolean;
}

const CREDENTIAL_PATH = () => stateDir("private-app-dns.json");
const ACME_PATH = () => stateDir("private-app-acme");
const CADDYFILE = () =>
  process.env.OPENSESSION_CADDYFILE || "/etc/caddy/Caddyfile";
const TLS_DIR = () => process.env.OPENSESSION_TLS_DIR || "/etc/opensession/tls";
const MANAGED_START = "# BEGIN OPENSESSION PRIVATE APP";
const MANAGED_END = "# END OPENSESSION PRIVATE APP";
const runtime = globalThis as typeof globalThis & {
  __opensessionPrivateAppRenewal?: ReturnType<typeof setInterval>;
  __opensessionPrivateAppRenewing?: boolean;
};

function safeCredential(): PrivateAppCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIAL_PATH(), "utf8"));
    if (
      parsed?.version !== 1 ||
      (parsed?.provider !== "cloudflare" && parsed?.provider !== "vercel") ||
      typeof parsed.domain !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.apiToken !== "string" ||
      (parsed.teamId !== undefined && typeof parsed.teamId !== "string") ||
      (parsed.upstream !== undefined && typeof parsed.upstream !== "string")
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function certificatePaths(domain: string): {
  certificate: string;
  key: string;
} {
  return {
    certificate: join(TLS_DIR(), `${domain}.crt`),
    key: join(TLS_DIR(), `${domain}.key`),
  };
}

function legoCertificatePaths(domain: string): {
  certificate: string;
  key: string;
} {
  return {
    certificate: join(ACME_PATH(), "certificates", `${domain}.crt`),
    key: join(ACME_PATH(), "certificates", `${domain}.key`),
  };
}

function certificateExpiry(domain: string): string {
  const candidates = [
    certificatePaths(domain).certificate,
    `/etc/lego/certificates/${domain}.crt`,
  ];
  for (const path of candidates) {
    try {
      return new Date(
        new X509Certificate(readFileSync(path)).validTo,
      ).toISOString();
    } catch {}
  }
  return "";
}

async function runCommand(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function commandEnvironment(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH:
      process.env.PATH ||
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME || "",
    LANG: process.env.LANG || "C.UTF-8",
    ...extra,
  };
}

async function cloudflareRequest(
  token: string,
  path: string,
  init?: { method: "POST" | "PUT"; body: Record<string, unknown> },
): Promise<any> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || !payload?.success) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors
          .map((entry: any) => entry?.message)
          .filter(Boolean)
          .join("; ")
      : "";
    throw new Error(
      detail || `Cloudflare DNS request failed (${response.status})`,
    );
  }
  return payload.result;
}

export function cloudflareZoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  const candidates: string[] = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    candidates.push(labels.slice(index).join("."));
  }
  return candidates;
}

async function cloudflareZone(
  token: string,
  domain: string,
): Promise<{ id: string; name: string }> {
  for (const candidate of cloudflareZoneCandidates(domain)) {
    const zones = await cloudflareRequest(
      token,
      `/zones?name=${encodeURIComponent(candidate)}&status=active`,
    );
    const zone = Array.isArray(zones) ? zones[0] : null;
    if (typeof zone?.id === "string" && typeof zone?.name === "string") {
      return { id: zone.id, name: zone.name };
    }
  }
  throw new Error(
    "The Cloudflare token cannot access the DNS zone for this domain",
  );
}

async function upsertCloudflarePrivateRecord(
  token: string,
  domain: string,
  tailnetIpv4: string,
): Promise<void> {
  const zone = await cloudflareZone(token, domain);
  const records = await cloudflareRequest(
    token,
    `/zones/${encodeURIComponent(zone.id)}/dns_records?name=${encodeURIComponent(domain)}`,
  );
  const matching = Array.isArray(records) ? records : [];
  const conflicting = matching.find((record: any) => record?.type !== "A");
  if (conflicting) {
    throw new Error(
      `${domain} already has a ${String(conflicting.type)} record in Cloudflare`,
    );
  }
  const body = {
    type: "A",
    name: domain,
    content: tailnetIpv4,
    proxied: false,
    ttl: 1,
    comment: "Managed by Open Session for private Tailscale access",
  };
  const addressRecords = matching.filter((record: any) => record?.type === "A");
  if (addressRecords.length > 1) {
    throw new Error(
      `${domain} has more than one A record in Cloudflare. Remove the extras before setup`,
    );
  }
  const existing = addressRecords[0];
  if (existing?.id) {
    await cloudflareRequest(
      token,
      `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(existing.id)}`,
      {
        method: "PUT",
        body,
      },
    );
  } else {
    await cloudflareRequest(
      token,
      `/zones/${encodeURIComponent(zone.id)}/dns_records`,
      {
        method: "POST",
        body,
      },
    );
  }
}

async function vercelRequest(
  token: string,
  path: string,
  init?: { method: "POST" | "DELETE"; body?: Record<string, unknown> },
): Promise<any> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error?.message ||
        `Vercel DNS request failed (${response.status})`,
    );
  }
  return payload;
}

function teamQuery(teamId: string | undefined): string {
  return teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
}

export function vercelZoneForDomain(
  domain: string,
  zones: string[],
): string | null {
  return (
    zones
      .map((name) => name.toLowerCase())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .find((name) => domain === name || domain.endsWith(`.${name}`)) || null
  );
}

async function upsertVercelPrivateRecord(
  token: string,
  domain: string,
  tailnetIpv4: string,
  teamId?: string,
): Promise<void> {
  const zoneNames: string[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const listed = await vercelRequest(
      token,
      `/v5/domains?limit=100${teamQuery(teamId)}${cursor ? `&until=${encodeURIComponent(cursor)}` : ""}`,
    );
    const domains = Array.isArray(listed?.domains) ? listed.domains : [];
    zoneNames.push(...domains.map((entry: any) => String(entry?.name || "")));
    const next = listed?.pagination?.next;
    if (next === undefined || next === null || String(next) === cursor) break;
    cursor = String(next);
  }
  const zone = vercelZoneForDomain(domain, zoneNames);
  if (!zone)
    throw new Error(
      "The Vercel token cannot access the DNS zone for this domain",
    );
  const relativeName =
    domain === zone ? "" : domain.slice(0, -(zone.length + 1));
  const query = teamQuery(teamId);
  const listedRecords = await vercelRequest(
    token,
    `/v4/domains/${encodeURIComponent(zone)}/records?limit=100${query}`,
  );
  const records = Array.isArray(listedRecords?.records)
    ? listedRecords.records
    : [];
  const named = records.filter((record: any) => {
    const name = String(record?.name || "")
      .replace(/\.$/, "")
      .toLowerCase();
    return name === relativeName || name === domain;
  });
  const conflicting = named.find((record: any) => record?.type !== "A");
  if (conflicting)
    throw new Error(
      `${domain} already has a ${String(conflicting.type)} record in Vercel`,
    );
  if (named.length > 1)
    throw new Error(
      `${domain} has more than one A record in Vercel. Remove the extras before setup`,
    );
  const existing = named[0];
  if (existing?.value === tailnetIpv4) return;
  if (existing?.id) {
    await vercelRequest(
      token,
      `/v2/domains/${encodeURIComponent(zone)}/records/${encodeURIComponent(existing.id)}?${query.slice(1)}`,
      {
        method: "DELETE",
      },
    );
  }
  await vercelRequest(
    token,
    `/v2/domains/${encodeURIComponent(zone)}/records?${query.slice(1)}`,
    {
      method: "POST",
      body: { name: relativeName, type: "A", value: tailnetIpv4, ttl: 60 },
    },
  );
}

function validateCredentialInput(input: {
  domain: string;
  provider: PrivateAppDnsProvider;
  email?: string;
  apiToken?: string;
  teamId?: string;
  upstream?: string;
}): PrivateAppCredential {
  const saved = safeCredential();
  const canReuse =
    saved?.domain === input.domain && saved.provider === input.provider;
  const email = (input.email || (canReuse ? saved.email : "")).trim();
  const apiToken = (input.apiToken || (canReuse ? saved.apiToken : "")).trim();
  const teamId = (input.teamId || (canReuse ? saved.teamId : "") || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error("A valid certificate email is required");
  }
  if (!apiToken || apiToken.length > 4096 || /\s/.test(apiToken)) {
    throw new Error(
      `A valid ${input.provider === "cloudflare" ? "Cloudflare" : "Vercel"} API token is required`,
    );
  }
  if (teamId && !/^(team|org)_[A-Za-z0-9]+$/.test(teamId)) {
    throw new Error("Vercel team ID must start with team_ or org_");
  }
  return {
    version: 1,
    provider: input.provider,
    domain: input.domain,
    email,
    apiToken,
    ...(input.provider === "vercel" && teamId ? { teamId } : {}),
    ...(input.upstream ? { upstream: input.upstream } : {}),
  };
}

export function privateAppCaddyUpstream(host: string, port: number): string {
  const normalized = host.replace(/^\[|\]$/g, "").trim();
  const upstreamHost =
    !normalized || normalized === "0.0.0.0"
      ? "127.0.0.1"
      : normalized === "::"
        ? "::1"
        : normalized;
  return `${upstreamHost.includes(":") ? `[${upstreamHost}]` : upstreamHost}:${port}`;
}

export function privateAppCaddySnippet(
  domain: string,
  tailnetIpv4: string,
  paths = certificatePaths(domain),
  upstream = "127.0.0.1:3850",
): string {
  return `${domain} {\n    ${MANAGED_START}\n    bind ${tailnetIpv4}\n    tls ${paths.certificate} ${paths.key}\n    reverse_proxy ${upstream} {\n        lb_try_duration 15s\n        lb_try_interval 250ms\n    }\n    ${MANAGED_END}\n}`;
}

function managedBlock(
  domain: string,
  tailnetIpv4: string,
  upstream: string,
): string {
  const paths = certificatePaths(domain);
  return `${MANAGED_START}\nbind ${tailnetIpv4}\ntls ${paths.certificate} ${paths.key}\nreverse_proxy ${upstream} {\n    lb_try_duration 15s\n    lb_try_interval 250ms\n}\n${MANAGED_END}`;
}

function closingBrace(source: string, opening: number): number | undefined {
  let depth = 0;
  let quoted = false;
  let comment = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (!quoted && character === "#") {
      comment = true;
      continue;
    }
    if (character === '"' && source[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return undefined;
}

function caddySites(
  source: string,
): Array<{ header: number; opening: number; closing: number }> {
  const sites: Array<{ header: number; opening: number; closing: number }> = [];
  for (const match of source.matchAll(/^([^\n#{}]+)\{/gm)) {
    const header = match.index || 0;
    const opening = header + match[0].lastIndexOf("{");
    const closing = closingBrace(source, opening);
    if (closing !== undefined) sites.push({ header, opening, closing });
  }
  return sites;
}

/** Update only Open Session's marked private-app site. Existing unmarked sites
 * are left alone because silently taking ownership could expose or break them. */
export function upsertPrivateAppCaddy(
  caddyfile: string,
  domain: string,
  tailnetIpv4: string,
  upstream = "127.0.0.1:3850",
): string {
  const managed = new RegExp(
    `^[ \\t]*${MANAGED_START}[\\s\\S]*?^[ \\t]*${MANAGED_END}[ \\t]*(?:\\r?\\n)?`,
    "gm",
  );
  const owned = caddySites(caddyfile).find(({ opening, closing }) =>
    caddyfile.slice(opening + 1, closing).includes(MANAGED_START),
  );
  if (owned) {
    const body = caddyfile.slice(owned.opening + 1, owned.closing);
    const replacement = managedBlock(domain, tailnetIpv4, upstream)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    managed.lastIndex = 0;
    const nextBody = body.replace(managed, `${replacement}\n`);
    return `${caddyfile.slice(0, owned.header)}${domain} {${nextBody}${caddyfile.slice(owned.closing)}`;
  }
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(`^\\s*(?:https?://)?${escaped}(?::443)?\\s*\\{`, "m").test(
      caddyfile,
    )
  ) {
    throw new Error(
      `${domain} already has an unmanaged Caddy site. Use Advanced setup or remove that site first`,
    );
  }
  return `${caddyfile.trimEnd()}\n\n${privateAppCaddySnippet(domain, tailnetIpv4, certificatePaths(domain), upstream)}\n`;
}

async function issueCertificate(
  credential: PrivateAppCredential,
  renew = false,
): Promise<boolean> {
  const lego = Bun.which("lego");
  if (!lego) throw new Error("lego is not installed on this server");
  mkdirSync(ACME_PATH(), { recursive: true, mode: 0o700 });
  chmodSync(ACME_PATH(), 0o700);
  const certificatePath = legoCertificatePaths(credential.domain).certificate;
  const before = existsSync(certificatePath)
    ? readFileSync(certificatePath)
    : null;
  const args = [
    lego,
    "--path",
    ACME_PATH(),
    "--email",
    credential.email,
    "--accept-tos",
    "--dns",
    credential.provider,
    "--domains",
    credential.domain,
    renew ? "renew" : "run",
  ];
  if (renew) args.push("--days", "30");
  const dnsEnvironment: Record<string, string> =
    credential.provider === "cloudflare"
      ? { CF_DNS_API_TOKEN: credential.apiToken }
      : {
          VERCEL_API_TOKEN: credential.apiToken,
          ...(credential.teamId ? { VERCEL_TEAM_ID: credential.teamId } : {}),
        };
  const result = await runCommand(args, commandEnvironment(dnsEnvironment));
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Let’s Encrypt certificate request failed",
    );
  }
  const after = existsSync(certificatePath)
    ? readFileSync(certificatePath)
    : null;
  return Boolean(after && (!before || !before.equals(after)));
}

async function caddyGroup(): Promise<string> {
  const id = Bun.which("id");
  if (!id) return "caddy";
  const caddy = await runCommand([id, "-gn", "caddy"], commandEnvironment());
  if (caddy.code === 0 && /^[a-z_][a-z0-9_-]*$/i.test(caddy.stdout.trim()))
    return caddy.stdout.trim();
  const current = await runCommand([id, "-gn"], commandEnvironment());
  return /^[a-z_][a-z0-9_-]*$/i.test(current.stdout.trim())
    ? current.stdout.trim()
    : "caddy";
}

async function installCertificateAndCaddy(
  domain: string,
  tailnetIpv4: string,
  upstream = "127.0.0.1:3850",
): Promise<void> {
  const caddy = Bun.which("caddy");
  const sudo = Bun.which("sudo");
  if (!caddy || !sudo)
    throw new Error(
      "Caddy and passwordless sudo are required for automatic setup",
    );
  const source = legoCertificatePaths(domain);
  if (!existsSync(source.certificate) || !existsSync(source.key)) {
    throw new Error(
      "Let’s Encrypt did not produce the expected certificate files",
    );
  }
  const caddyfile = CADDYFILE();
  let current: string;
  try {
    current = readFileSync(caddyfile, "utf8");
  } catch {
    throw new Error(`Could not read ${caddyfile}`);
  }
  const next = upsertPrivateAppCaddy(current, domain, tailnetIpv4, upstream);
  const scratch = mkdtempSync(
    join(
      tmpdir(),
      `opensession-private-domain-${randomBytes(4).toString("hex")}-`,
    ),
  );
  const staged = join(scratch, "Caddyfile");
  const backup = `${caddyfile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const group = await caddyGroup();
  const runSudo = (args: string[]) =>
    runCommand([sudo, "-n", ...args], commandEnvironment());
  const rollback = async () => {
    await runSudo(["cp", "-p", backup, caddyfile]);
    await runSudo(["systemctl", "reload", "caddy"]);
  };
  try {
    await Bun.write(staged, next);
    if ((await runSudo(["cp", "-p", caddyfile, backup])).code !== 0)
      throw new Error("Could not back up the Caddyfile");
    if (
      (
        await runSudo([
          "install",
          "-d",
          "-m",
          "0750",
          "-o",
          "root",
          "-g",
          group,
          TLS_DIR(),
        ])
      ).code !== 0
    ) {
      throw new Error(`Could not create ${TLS_DIR()}`);
    }
    if (
      (
        await runSudo([
          "install",
          "-m",
          "0644",
          "-o",
          "root",
          "-g",
          group,
          source.certificate,
          certificatePaths(domain).certificate,
        ])
      ).code !== 0 ||
      (
        await runSudo([
          "install",
          "-m",
          "0640",
          "-o",
          "root",
          "-g",
          group,
          source.key,
          certificatePaths(domain).key,
        ])
      ).code !== 0
    ) {
      throw new Error("Could not install the private app certificate");
    }
    if (
      (await runSudo(["install", "-m", "0644", staged, caddyfile])).code !== 0
    ) {
      await rollback();
      throw new Error(
        "Could not install the private app Caddy site; the prior Caddyfile was restored",
      );
    }
    const validation = await runSudo([
      caddy,
      "validate",
      "--config",
      caddyfile,
      "--adapter",
      "caddyfile",
    ]);
    if (validation.code !== 0) {
      await rollback();
      throw new Error(
        validation.stderr.trim() ||
          "Caddy rejected the private app configuration",
      );
    }
    const reload = await runSudo(["systemctl", "reload", "caddy"]);
    if (reload.code !== 0) {
      await rollback();
      throw new Error(reload.stderr.trim() || "Caddy reload failed");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function appHealth(
  origin: string,
  tailnetIpv4: string | null,
): Promise<PrivateAppHealth> {
  if (!origin || !origin.startsWith("https://")) return "not_configured";
  let domain = "";
  try {
    domain = new URL(origin).hostname;
  } catch {
    return "not_configured";
  }
  const records = await resolve4(domain).catch((): string[] => []);
  if (!tailnetIpv4 || !records.includes(tailnetIpv4)) return "waiting_dns";
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? "ready" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function privateAppDomainStatus(
  origin: string,
  tailnetIpv4: string | null,
): Promise<PrivateAppDomainStatus> {
  let domain = "";
  try {
    domain = new URL(origin).hostname;
  } catch {}
  const credential = safeCredential();
  return {
    health: await appHealth(origin, tailnetIpv4),
    dnsProvider: credential?.domain === domain ? credential.provider : null,
    credentialConfigured: credential?.domain === domain,
    certificateEmailConfigured:
      credential?.domain === domain && Boolean(credential.email),
    certificateExpiresAt: domain ? certificateExpiry(domain) : "",
    legoInstalled: Bun.which("lego") !== null,
  };
}

export async function configurePrivateAppDomain(input: {
  domain: string;
  provider: PrivateAppDnsProvider;
  email?: string;
  apiToken?: string;
  teamId?: string;
  upstream?: string;
  tailnetIpv4: string | null;
}): Promise<void> {
  if (!input.tailnetIpv4)
    throw new Error(
      "Connect this server to Tailscale before setting up a private domain",
    );
  if (!Bun.which("caddy"))
    throw new Error("Caddy is not installed on this server");
  if (!Bun.which("lego"))
    throw new Error("lego is not installed on this server");
  const credential = validateCredentialInput(input);
  if (credential.provider === "cloudflare") {
    await upsertCloudflarePrivateRecord(
      credential.apiToken,
      credential.domain,
      input.tailnetIpv4,
    );
  } else {
    await upsertVercelPrivateRecord(
      credential.apiToken,
      credential.domain,
      input.tailnetIpv4,
      credential.teamId,
    );
  }
  await issueCertificate(
    credential,
    existsSync(legoCertificatePaths(credential.domain).certificate),
  );
  await installCertificateAndCaddy(
    credential.domain,
    input.tailnetIpv4,
    credential.upstream,
  );
  writeJsonAtomic(CREDENTIAL_PATH(), credential, true, 0o600);
}

export async function testPrivateAppDomain(
  origin: string,
  tailnetIpv4: string | null,
): Promise<PrivateAppDomainStatus> {
  return privateAppDomainStatus(origin, tailnetIpv4);
}

export async function renewPrivateAppCertificate(): Promise<boolean> {
  if (runtime.__opensessionPrivateAppRenewing) return false;
  const credential = safeCredential();
  if (!credential || !Bun.which("lego") || !Bun.which("caddy")) return false;
  runtime.__opensessionPrivateAppRenewing = true;
  try {
    const changed = await issueCertificate(credential, true);
    if (changed) {
      const records = await resolve4(credential.domain).catch(
        (): string[] => [],
      );
      const tailnetIpv4 = records.find(isTailnetIpv4);
      if (!tailnetIpv4)
        throw new Error(
          "Private app DNS no longer points to a Tailscale address",
        );
      await installCertificateAndCaddy(
        credential.domain,
        tailnetIpv4,
        credential.upstream,
      );
      console.log(`[private-app] certificate renewed for ${credential.domain}`);
    }
    return true;
  } catch (error) {
    console.error("[private-app] certificate renewal failed:", error);
    return false;
  } finally {
    runtime.__opensessionPrivateAppRenewing = false;
  }
}

/** Check at boot and every 24 hours. lego renews only inside the 30-day window. */
export function startPrivateAppCertificateRenewal(): void {
  if (runtime.__opensessionPrivateAppRenewal) return;
  void renewPrivateAppCertificate();
  runtime.__opensessionPrivateAppRenewal = setInterval(
    () => {
      void renewPrivateAppCertificate();
    },
    24 * 60 * 60 * 1_000,
  );
}
