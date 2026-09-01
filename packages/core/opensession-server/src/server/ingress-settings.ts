/** Public-ingress configuration, discovery and managed exposure helpers. */
import { randomBytes } from "crypto";
import { createSocket } from "dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { networkInterfaces, tmpdir } from "os";
import { isIP } from "net";
import { join } from "path";
import { resolve4, resolve6 } from "dns/promises";
import {
  configuredIngress,
  configuredServer,
  getConfig,
  type IngressExposure,
} from "./config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "./config-mutation";
import { isBlockedAddress } from "./shared/network-address";
import {
  caddyIngressSnippet,
  upsertCaddyIngress,
} from "./sandbox/caddy-ingress";
import { stateDir } from "./paths";
import { writeFileAtomic } from "./shared/atomic-write";
import { prepareEnvFileEdits } from "./env-file-edit";
import {
  detectedTailnetIpv4,
  normalizeAppOrigin,
  setupAccessSnapshot,
} from "./setup-access";
import {
  configurePrivateAppDomain,
  privateAppCaddyUpstream,
  privateAppDomainStatus,
  testPrivateAppDomain,
  type PrivateAppDomainStatus,
  type PrivateAppDnsProvider,
} from "./private-app-domain";

export const PUBLIC_INGRESS_PORT = 3860;
const CADDYFILE = process.env.OPENSESSION_CADDYFILE || "/etc/caddy/Caddyfile";
const CLOUDFLARE_TOKEN_PATH = stateDir("cloudflared-tunnel-token");
const INGRESS_STARTING_GRACE_MS: Record<IngressExposure, number> = {
  cloudflare: 60_000,
  custom: 60_000,
};
const runtime = globalThis as typeof globalThis & {
  __opensessionCloudflared?: ReturnType<typeof Bun.spawn>;
  __opensessionCloudflaredRestart?: ReturnType<typeof setTimeout>;
  __opensessionIngressStartedAt?: Partial<Record<IngressExposure, number>>;
};

function markIngressStarting(exposure: IngressExposure): void {
  (runtime.__opensessionIngressStartedAt ??= {})[exposure] = Date.now();
}

function ingressStartedAt(exposure: IngressExposure | null): number {
  return exposure ? runtime.__opensessionIngressStartedAt?.[exposure] || 0 : 0;
}

export interface IngressStatus {
  canManage: boolean;
  publicBaseUrl: string;
  exposure: IngressExposure | null;
  health:
    | "ready"
    | "starting"
    | "waiting_dns"
    | "unreachable"
    | "not_configured";
  localUrl: string;
  hostname: string;
  app: {
    publicBaseUrl: string;
    hostname: string;
    tailnetIpv4: string | null;
    domain: PrivateAppDomainStatus;
  };
  server: { ipv4: string[]; ipv6: string[] };
  dns: { a: string[]; aaaa: string[]; suggested: string[] };
  cloudflare: {
    installed: boolean;
    tunnelId: string;
    cnameTarget: string;
    connectorTarget: string;
    tokenConfigured: boolean;
    connectorRunning: boolean;
  };
  custom: { caddyInstalled: boolean; generatedConfig: string };
}

/** The configured private app origin as persisted by the setup flow.
 *
 * `configuredServer()` intentionally gives the boot environment precedence,
 * but that value remains stale until a requested restart. Settings status must
 * use the freshly persisted config so a saved friendly domain does not
 * disappear on the next poll.
 */
export function configuredPrivateAppOrigin(): string {
  return setupAccessSnapshot().publicBaseUrl;
}

/** The public ingress origin persisted by Settings. The boot environment may
 * still contain the prior value until restart, so status and validation use
 * the freshly saved config first while ordinary config keeps env precedence. */
export function configuredPublicIngress(): ReturnType<
  typeof configuredIngress
> {
  const configured = configuredIngress();
  return {
    ...configured,
    publicBaseUrl: configured.exposure
      ? (
          getConfig().ingress?.publicBaseUrl || configured.publicBaseUrl
        ).replace(/\/+$/, "")
      : "",
  };
}

export function normalizeIngressOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Public ingress URL is required");
  if (trimmed.length > 2048 || /[\r\n\0]/.test(trimmed)) {
    throw new Error("Public ingress URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Public ingress URL must be a full HTTPS URL");
  }
  if (parsed.protocol !== "https:")
    throw new Error("Public ingress URL must use HTTPS");
  if (parsed.port || parsed.username || parsed.password) {
    throw new Error(
      "Public ingress URL must use the default HTTPS port and no credentials",
    );
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      "Public ingress URL must not include a path, query, or fragment",
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isBlockedAddress(host)
  ) {
    throw new Error(
      "Public ingress must be reachable from the public internet",
    );
  }
  const appHost = (() => {
    try {
      return new URL(configuredPrivateAppOrigin()).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host === appHost) {
    throw new Error(
      "Public ingress must use a different hostname from the private app",
    );
  }
  return parsed.origin;
}

/** Custom-domain setup asks for a domain, not URL syntax. HTTPS is fixed by
 * the ingress contract and Caddy provisions it, so adding a scheme is busywork. */
export function normalizeCustomIngressOrigin(value: string): string {
  const trimmed = value.trim();
  return normalizeIngressOrigin(
    trimmed.includes("://") ? trimmed : `https://${trimmed}`,
  );
}

/** Select the local interface that carries traffic to the public internet.
 * On NATed hosts the operator enters the public address, while Caddy must bind
 * the corresponding private interface address. Never fall back to wildcard:
 * the private app already owns HTTPS on the Tailscale interface, and two HTTP/3
 * UDP listeners on port 443 cannot overlap. */
export function directHttpsBindAddress(
  publicAddress: string,
  routedAddress: string,
  tailnetAddress: string | null,
): string | null {
  const family = isIP(publicAddress);
  if (!family || isIP(routedAddress) !== family) return null;
  if (
    routedAddress === tailnetAddress ||
    routedAddress === "0.0.0.0" ||
    routedAddress === "::" ||
    routedAddress === "127.0.0.1" ||
    routedAddress === "::1"
  )
    return null;
  return routedAddress;
}

async function routedInternetAddress(family: 4 | 6): Promise<string> {
  const socket = createSocket(family === 4 ? "udp4" : "udp6");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const address = error ? "" : socket.address().address;
      socket.close();
      if (error || !address) reject(error || new Error("No routed address"));
      else resolve(address);
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out finding the public-facing interface")),
      2_000,
    );
    socket.once("error", finish);
    socket.connect(53, family === 4 ? "1.1.1.1" : "2606:4700:4700::1111", () =>
      finish(),
    );
  });
}

/** A private app custom domain is always HTTPS, but the form asks for the
 * hostname rather than making people type protocol syntax. */
export function normalizePrivateAppOrigin(value: string): string {
  const trimmed = value.trim();
  const origin = normalizeAppOrigin(
    trimmed.includes("://") ? trimmed : `https://${trimmed}`,
  );
  if (new URL(origin).protocol !== "https:")
    throw new Error("Private app domain must use HTTPS");
  const ingressHost = (() => {
    try {
      return new URL(
        configuredPublicIngress().publicBaseUrl,
      ).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (new URL(origin).hostname.toLowerCase() === ingressHost) {
    throw new Error(
      "Private app and public ingress must use different domains",
    );
  }
  return origin;
}

async function command(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function publicInterfaceAddresses(): { a: string[]; aaaa: string[] } {
  const a = new Set<string>();
  const aaaa = new Set<string>();
  if (process.env.OPENSESSION_PUBLIC_IPV4)
    a.add(process.env.OPENSESSION_PUBLIC_IPV4.trim());
  if (process.env.OPENSESSION_PUBLIC_IPV6)
    aaaa.add(process.env.OPENSESSION_PUBLIC_IPV6.trim());
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || isBlockedAddress(entry.address)) continue;
      if (entry.family === "IPv4") a.add(entry.address);
      else if (entry.family === "IPv6") aaaa.add(entry.address);
    }
  }
  return {
    a: [...a].filter(
      (address) => isIP(address) === 4 && !isBlockedAddress(address),
    ),
    aaaa: [...aaaa].filter(
      (address) => isIP(address) === 6 && !isBlockedAddress(address),
    ),
  };
}

async function metadataValue(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<string> {
  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(700),
    });
    if (!response.ok) return "";
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

/** Discover a NATed cloud VM's public address without sending instance data to
 * an internet "what is my IP" service. These are fixed link-local metadata
 * endpoints for AWS, GCP, and Azure; unsupported providers simply time out. */
async function cloudMetadataPublicIpv4(): Promise<string[]> {
  const aws = (async () => {
    const token = await metadataValue(
      "http://169.254.169.254/latest/api/token",
      { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      "PUT",
    );
    return metadataValue(
      "http://169.254.169.254/latest/meta-data/public-ipv4",
      token ? { "X-aws-ec2-metadata-token": token } : {},
    );
  })();
  const [awsAddress, gcpAddress, azureAddress] = await Promise.all([
    aws,
    metadataValue(
      "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
      { "Metadata-Flavor": "Google" },
    ),
    metadataValue(
      "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text",
      { Metadata: "true" },
    ),
  ]);
  return [...new Set([awsAddress, gcpAddress, azureAddress])].filter(
    (address) => isIP(address) === 4 && !isBlockedAddress(address),
  );
}

async function publicServerAddresses(): Promise<{
  a: string[];
  aaaa: string[];
}> {
  const direct = publicInterfaceAddresses();
  const metadata = direct.a.length ? [] : await cloudMetadataPublicIpv4();
  return { a: [...new Set([...direct.a, ...metadata])], aaaa: direct.aaaa };
}

async function currentDns(
  hostname: string,
): Promise<{ a: string[]; aaaa: string[] }> {
  if (!hostname) return { a: [], aaaa: [] };
  const [a, aaaa] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  return { a, aaaa };
}

async function ingressHealth(
  origin: string,
): Promise<"ready" | "unreachable" | "not_configured"> {
  if (!origin) return "not_configured";
  try {
    const response = await fetch(`${origin}/ingress-health`, {
      signal: AbortSignal.timeout(6_000),
    });
    return response.ok && (await response.text()).trim() === "ok"
      ? "ready"
      : "unreachable";
  } catch {
    return "unreachable";
  }
}

export function publicIngressHealth(
  exposure: IngressExposure | null,
  probed: "ready" | "unreachable" | "not_configured",
  dns: { a: string[]; aaaa: string[] },
  server: { a: string[]; aaaa: string[] },
  startedAt = 0,
  now = Date.now(),
): IngressStatus["health"] {
  if (probed !== "unreachable") return probed;
  if (exposure === "custom") {
    const expectedAddresses = [...server.a, ...server.aaaa];
    const resolvedAddresses = [...dns.a, ...dns.aaaa];
    const dnsPointsHere = expectedAddresses.length
      ? resolvedAddresses.some((address) => expectedAddresses.includes(address))
      : resolvedAddresses.length > 0;
    if (!dnsPointsHere) return "waiting_dns";
  }
  if (
    exposure &&
    startedAt > 0 &&
    now - startedAt < INGRESS_STARTING_GRACE_MS[exposure]
  )
    return "starting";
  return probed;
}

export function displayedServerAddresses(
  server: { a: string[]; aaaa: string[] },
  dns: { a: string[]; aaaa: string[] },
  health: IngressStatus["health"],
): { a: string[]; aaaa: string[] } {
  return server.a.length || server.aaaa.length || health !== "ready"
    ? server
    : dns;
}

export async function publicIngressStatus(
  canManage: boolean,
  options: { appBaseUrl?: string } = {},
): Promise<IngressStatus> {
  const configured = configuredPublicIngress();
  const appBaseUrl = options.appBaseUrl || configuredPrivateAppOrigin();
  let appHostname = "";
  try {
    appHostname = new URL(appBaseUrl).hostname;
  } catch {}
  let hostname = "";
  try {
    hostname = new URL(configured.publicBaseUrl).hostname;
  } catch {}
  const tailnetIpv4 = detectedTailnetIpv4();
  const [dns, probedHealth, serverAddresses, appDomain] = await Promise.all([
    currentDns(hostname),
    ingressHealth(configured.publicBaseUrl),
    publicServerAddresses(),
    privateAppDomainStatus(appBaseUrl, tailnetIpv4),
  ]);
  const connectorRunning = cloudflareConnectorRunning();
  const health = publicIngressHealth(
    configured.exposure,
    probedHealth,
    dns,
    serverAddresses,
    configured.exposure !== "cloudflare" || connectorRunning
      ? ingressStartedAt(configured.exposure)
      : 0,
  );
  // A healthy direct Caddy origin proves its resolved addresses reach this
  // listener. Reuse that exact answer on NATed hosts whose cloud metadata is
  // disabled, so an already-working setup still tells the operator which
  // public address to use for another custom-domain record.
  const displayedAddresses = displayedServerAddresses(
    serverAddresses,
    dns,
    health,
  );
  const tunnelId = configured.cloudflareTunnelId;
  return {
    canManage,
    publicBaseUrl: configured.publicBaseUrl,
    exposure: configured.exposure,
    health,
    localUrl: `http://127.0.0.1:${PUBLIC_INGRESS_PORT}`,
    hostname,
    app: {
      publicBaseUrl: appBaseUrl.replace(/\/+$/, ""),
      hostname: appHostname,
      tailnetIpv4,
      domain: appDomain,
    },
    server: { ipv4: displayedAddresses.a, ipv6: displayedAddresses.aaaa },
    dns: {
      ...dns,
      suggested: [
        ...displayedAddresses.a.map(
          (address) => `A ${hostname || "ingress.example.com"} ${address}`,
        ),
        ...displayedAddresses.aaaa.map(
          (address) => `AAAA ${hostname || "ingress.example.com"} ${address}`,
        ),
      ],
    },
    cloudflare: {
      installed: Bun.which("cloudflared") !== null,
      tunnelId,
      cnameTarget: tunnelId
        ? `${tunnelId}.cfargotunnel.com`
        : "<tunnel-id>.cfargotunnel.com",
      connectorTarget: `http://127.0.0.1:${PUBLIC_INGRESS_PORT}`,
      tokenConfigured: existsSync(CLOUDFLARE_TOKEN_PATH),
      connectorRunning,
    },
    custom: {
      caddyInstalled: Bun.which("caddy") !== null,
      generatedConfig: caddyIngressSnippet(
        configured.publicBaseUrl || "https://ingress.example.com",
      ),
    },
  };
}

export async function setupPrivateAppDomain(input: {
  domain: string;
  provider: PrivateAppDnsProvider;
  email?: string;
  apiToken?: string;
  teamId?: string;
}): Promise<string> {
  const publicBaseUrl = normalizePrivateAppOrigin(input.domain);
  const server = configuredServer();
  await configurePrivateAppDomain({
    domain: new URL(publicBaseUrl).hostname,
    provider: input.provider,
    email: input.email,
    apiToken: input.apiToken,
    teamId: input.teamId,
    upstream: privateAppCaddyUpstream(server.host, server.port),
    tailnetIpv4: detectedTailnetIpv4(),
  });
  return savePrivateAppOrigin(publicBaseUrl);
}

export async function verifyPrivateAppDomain(): Promise<PrivateAppDomainStatus> {
  return testPrivateAppDomain(
    configuredPrivateAppOrigin(),
    detectedTailnetIpv4(),
  );
}

export async function savePrivateAppOrigin(value: string): Promise<string> {
  const publicBaseUrl = normalizePrivateAppOrigin(value);
  await withConfigMutationLock(async () => {
    const raw = rawConfig();
    const server =
      raw.server && typeof raw.server === "object" && !Array.isArray(raw.server)
        ? (raw.server as Record<string, unknown>)
        : {};
    raw.server = server;
    server.publicBaseUrl = publicBaseUrl;
    const envEdit = prepareEnvFileEdits({ OPENSESSION_UI_BASE: publicBaseUrl });
    envEdit.commit();
    try {
      persistRawConfig(raw);
    } catch (error) {
      envEdit.rollback();
      throw error;
    }
  });
  return publicBaseUrl;
}

export async function savePublicIngress(input: {
  publicBaseUrl: string;
  exposure: IngressExposure;
  cloudflareTunnelId?: string;
  publicIp?: string;
}): Promise<void> {
  const publicBaseUrl = normalizeIngressOrigin(input.publicBaseUrl);
  if (!(["cloudflare", "custom"] as string[]).includes(input.exposure)) {
    throw new Error("Unknown exposure method");
  }
  const cloudflareTunnelId = (input.cloudflareTunnelId || "").trim();
  if (
    input.exposure === "cloudflare" &&
    !/^[0-9a-f-]{36}$/i.test(cloudflareTunnelId)
  ) {
    throw new Error("Cloudflare tunnel ID must be a UUID");
  }
  const publicIp = (input.publicIp || "").trim();
  const publicIpFamily = isIP(publicIp);
  if (publicIp && (!publicIpFamily || isBlockedAddress(publicIp))) {
    throw new Error("Enter a publicly routable IPv4 or IPv6 address");
  }
  await withConfigMutationLock(async () => {
    const raw = rawConfig();
    raw.ingress = {
      publicBaseUrl,
      exposure: input.exposure,
      ...(cloudflareTunnelId ? { cloudflareTunnelId } : {}),
    };
    // The public origin has one owner now. Remove the retired webhook origin
    // instead of leaving two values that can drift.
    if (
      raw.server &&
      typeof raw.server === "object" &&
      !Array.isArray(raw.server)
    ) {
      delete (raw.server as Record<string, unknown>).webhookBaseUrl;
      delete (raw.server as Record<string, unknown>).webhookPort;
    }
    const envKey =
      publicIpFamily === 4
        ? "OPENSESSION_PUBLIC_IPV4"
        : "OPENSESSION_PUBLIC_IPV6";
    const envEdit = prepareEnvFileEdits({
      OPENSESSION_INGRESS_BASE: publicBaseUrl,
      ...(publicIp ? { [envKey]: publicIp } : {}),
    });
    envEdit.commit();
    try {
      persistRawConfig(raw);
    } catch (error) {
      envEdit.rollback();
      throw error;
    }
  });
  // Public ingress always binds the same isolated local listener, so changing
  // its published origin can take effect immediately. Keep dynamic config
  // readers truthful now while the env-file edit makes it survive a restart.
  process.env.OPENSESSION_INGRESS_BASE = publicBaseUrl;
  if (publicIpFamily === 4) process.env.OPENSESSION_PUBLIC_IPV4 = publicIp;
  if (publicIpFamily === 6) process.env.OPENSESSION_PUBLIC_IPV6 = publicIp;
  if (input.exposure !== "cloudflare") {
    if (runtime.__opensessionCloudflaredRestart) {
      clearTimeout(runtime.__opensessionCloudflaredRestart);
      runtime.__opensessionCloudflaredRestart = undefined;
    }
    runtime.__opensessionCloudflared?.kill();
    runtime.__opensessionCloudflared = undefined;
  }
}

function cloudflareConnectorRunning(): boolean {
  return runtime.__opensessionCloudflared?.exitCode === null;
}

/** Start or reuse the named Cloudflare connector. Called explicitly at boot
 * and after Settings stores a token; importing this module has no effects. */
export function ensureCloudflareTunnel(): boolean {
  if (configuredIngress().exposure !== "cloudflare") return false;
  if (cloudflareConnectorRunning()) return true;
  const binary = Bun.which("cloudflared");
  if (!binary || !existsSync(CLOUDFLARE_TOKEN_PATH)) return false;
  if (runtime.__opensessionCloudflaredRestart) {
    clearTimeout(runtime.__opensessionCloudflaredRestart);
    runtime.__opensessionCloudflaredRestart = undefined;
  }
  const child = Bun.spawn(
    [
      binary,
      "tunnel",
      "--no-autoupdate",
      "run",
      "--token-file",
      CLOUDFLARE_TOKEN_PATH,
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env },
  );
  runtime.__opensessionCloudflared = child;
  console.log("[public-ingress] Cloudflare Tunnel connector started");
  void child.exited.then((code) => {
    if (runtime.__opensessionCloudflared !== child) return;
    runtime.__opensessionCloudflared = undefined;
    console.error(
      `[public-ingress] Cloudflare Tunnel connector exited (${code})`,
    );
    if (configuredIngress().exposure === "cloudflare") {
      runtime.__opensessionCloudflaredRestart = setTimeout(
        () => ensureCloudflareTunnel(),
        5_000,
      );
    }
  });
  return true;
}

export async function configureCloudflareTunnel(input: {
  publicBaseUrl: string;
  tunnelId: string;
  token?: string;
}): Promise<void> {
  const token = (input.token || "").trim();
  if (/\s/.test(token) || token.length > 4096)
    throw new Error("Cloudflare tunnel token is invalid");
  if (!token && !existsSync(CLOUDFLARE_TOKEN_PATH)) {
    throw new Error("Cloudflare tunnel token is required");
  }
  if (!Bun.which("cloudflared"))
    throw new Error("cloudflared is not installed on this server");
  if (token) writeFileAtomic(CLOUDFLARE_TOKEN_PATH, `${token}\n`, 0o600);
  await savePublicIngress({
    publicBaseUrl: input.publicBaseUrl,
    exposure: "cloudflare",
    cloudflareTunnelId: input.tunnelId,
  });
  if (!ensureCloudflareTunnel())
    throw new Error("Could not start the Cloudflare Tunnel connector");
  markIngressStarting("cloudflare");
}

export async function installManagedCaddy(
  originValue: string,
  publicIp?: string,
): Promise<void> {
  const origin = normalizeCustomIngressOrigin(originValue);
  const publicAddress = (publicIp || "").trim();
  const family = isIP(publicAddress);
  if (family !== 4 && family !== 6) {
    throw new Error("Enter this server’s public IPv4 or IPv6 address");
  }
  const routedAddress = await routedInternetAddress(family).catch(() => "");
  const bindAddress = directHttpsBindAddress(
    publicAddress,
    routedAddress,
    detectedTailnetIpv4(),
  );
  if (!bindAddress) {
    throw new Error(
      "Could not determine the public-facing network interface for Caddy",
    );
  }
  const caddy = Bun.which("caddy");
  const sudo = Bun.which("sudo");
  if (!caddy || !sudo)
    throw new Error("Caddy and sudo are required for managed custom domains");
  let current: string;
  try {
    current = readFileSync(CADDYFILE, "utf8");
  } catch {
    throw new Error(`Could not read ${CADDYFILE}`);
  }
  const scratch = mkdtempSync(
    join(tmpdir(), `opensession-ingress-${randomBytes(4).toString("hex")}-`),
  );
  const staged = join(scratch, "Caddyfile");
  const backup = `${CADDYFILE}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runSudo = (args: string[]) => command([sudo, "-n", ...args]);
  const rollback = async () => {
    await runSudo(["cp", "-p", backup, CADDYFILE]);
    await runSudo(["systemctl", "reload", "caddy"]);
  };
  try {
    await Bun.write(staged, upsertCaddyIngress(current, origin, bindAddress));
    if ((await runSudo(["cp", "-p", CADDYFILE, backup])).code !== 0) {
      throw new Error("Could not back up the Caddyfile");
    }
    if (
      (await runSudo(["install", "-m", "0644", staged, CADDYFILE])).code !== 0
    ) {
      await rollback();
      throw new Error(
        "Could not install the managed Caddy route; the prior Caddyfile was restored",
      );
    }
    const validate = await runSudo([
      caddy,
      "validate",
      "--config",
      CADDYFILE,
      "--adapter",
      "caddyfile",
    ]);
    if (validate.code !== 0) {
      await rollback();
      throw new Error(
        validate.stderr.trim() || "Caddy rejected the generated configuration",
      );
    }
    const reload = await runSudo(["systemctl", "reload", "caddy"]);
    if (reload.code !== 0) {
      await rollback();
      throw new Error(reload.stderr.trim() || "Caddy reload failed");
    }
    try {
      await savePublicIngress({
        publicBaseUrl: origin,
        exposure: "custom",
        publicIp,
      });
      markIngressStarting("custom");
    } catch (error) {
      await rollback();
      throw error;
    }
    // DNS may intentionally be the operator's next step. Caddy keeps retrying
    // certificate issuance after propagation, while status reports waiting_dns.
    // Do not roll back a valid listener merely because the public edge is not
    // reachable in the first few seconds.
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
