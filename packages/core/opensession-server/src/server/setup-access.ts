import { networkInterfaces } from "os";
import { configuredServer, getConfig } from "./config";
import { isBlockedAddress, isTailnetIpv4 } from "./shared/network-address";

export { isTailnetIpv4 } from "./shared/network-address";

const MAX_ORIGIN_LENGTH = 2048;

function normalizeOrigin(value: string, label: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.length > MAX_ORIGIN_LENGTH)
    throw new Error(`${label} is too long`);
  if (/[\r\n\0]/.test(trimmed)) throw new Error(`${label} must be one line`);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `${label} must be a full URL, such as https://os.example.com`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.protocol === "https:" && url.port) {
    throw new Error(`${label} must use the default HTTPS port 443`);
  }
  if (url.username || url.password)
    throw new Error(`${label} cannot include credentials`);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must not include a path, query, or fragment`);
  }
  return url;
}

/** Normalize the address people use to open the app. Existing tailnet HTTP
 * origins remain valid, while a custom domain can use HTTPS through Caddy. */
export function normalizeAppOrigin(value: string): string {
  return normalizeOrigin(value, "App address").origin;
}

/** Webhook providers cannot dial loopback, private LANs, or a Tailscale-only
 * address. Hostnames that resolve privately are still caught by the setup
 * guide's external verification, but the obvious unsafe inputs fail here. */
export function isObviouslyPrivateWebhookHost(value: string): boolean {
  const host = value
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".intranet") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".ts.net")
  ) {
    return true;
  }

  if (isBlockedAddress(host) || /^fe[89ab]/.test(host)) return true;
  const [a, b] = host.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

/** Empty means no separate webhook origin. Integrations then retain the
 * historical fallback to the app origin. */
export function normalizeWebhookOrigin(
  value: string,
  appOrigin: string,
): string {
  if (!value.trim()) return "";
  const url = normalizeOrigin(value, "Webhook address");
  if (url.protocol !== "https:")
    throw new Error("Webhook address must use https");
  if (isObviouslyPrivateWebhookHost(url.hostname)) {
    throw new Error(
      "Webhook address must be reachable from the public internet",
    );
  }
  if (
    url.hostname.toLowerCase() === new URL(appOrigin).hostname.toLowerCase()
  ) {
    throw new Error(
      "Webhook address must use a different hostname from the private app",
    );
  }
  return url.origin;
}

export interface SetupAccessSnapshot {
  publicBaseUrl: string;
  port: number;
  tailnetIp: string | null;
  caddyInstalled: boolean;
}

/** The access facts shared by GET status and the access-save response. Explicit
 * origins keep the save response truthful; persisted env values keep later GETs
 * truthful while process.env still contains boot-time values. */
export function setupAccessSnapshot(
  options: {
    publicBaseUrl?: string;
    persistedEnv?: Readonly<Record<string, string>>;
  } = {},
): SetupAccessSnapshot {
  const server = configuredServer();
  const configServer = getConfig().server;
  const persistedOrigin = (
    key: "OPENSESSION_UI_BASE",
    configValue: string | undefined,
    bootValue: string | undefined,
  ): string | null => {
    if (options.persistedEnv && key in options.persistedEnv) {
      return options.persistedEnv[key]?.trim() || null;
    }
    return configValue?.trim() || bootValue?.trim() || null;
  };
  const publicBaseUrl =
    options.publicBaseUrl ??
    persistedOrigin(
      "OPENSESSION_UI_BASE",
      configServer?.publicBaseUrl,
      server.publicBaseUrl,
    ) ??
    server.publicBaseUrl;
  return {
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    port: server.port,
    tailnetIp: detectedTailnetIpv4(),
    caddyInstalled: Bun.which("caddy") !== null,
  };
}

/** Best-effort display value for the DNS and Caddy guide. This does not make
 * network reachability a trust decision. */
export function detectedTailnetIpv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && isTailnetIpv4(address.address)) {
        return address.address;
      }
    }
  }
  return null;
}
