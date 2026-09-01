import type { IngressExposure, PublicIngressSettings } from "./api/ingress";

export const INGRESS_METHODS: Array<{
  value: IngressExposure;
  label: string;
  description: string;
}> = [
  {
    value: "custom",
    label: "Direct HTTPS with Caddy",
    description:
      "Your domain with any DNS provider. Requires ports 80 and 443.",
  },
  {
    value: "cloudflare",
    label: "Cloudflare Tunnel",
    description: "Your domain through Cloudflare. No inbound ports.",
  },
];

export function ingressHealthLabel(
  health: PublicIngressSettings["health"],
): string {
  if (health === "ready") return "Ready";
  if (health === "starting") return "Waiting";
  if (health === "waiting_dns") return "Waiting for DNS";
  if (health === "unreachable") return "Not reachable";
  return "Not configured";
}

export function ingressHealthDot(
  health: PublicIngressSettings["health"],
): string {
  if (health === "ready") return "var(--green)";
  if (health === "starting" || health === "waiting_dns") return "var(--yellow)";
  if (health === "unreachable") return "var(--red)";
  return "var(--text-faint)";
}

/** Accept a hostname or an HTTPS origin and return only its hostname. */
export function ingressHostname(
  value: string,
  fallback = "ingress.example.com",
): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return (
      new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
        .hostname || fallback
    );
  } catch {
    return fallback;
  }
}

export function customDnsRecords(
  settings: PublicIngressSettings,
  value: string,
  publicAddress = "",
): string[] {
  const hostname = ingressHostname(value);
  const override = publicAddress.trim();
  const ipv4 = override.includes(":")
    ? settings.server.ipv4
    : override
      ? [override]
      : settings.server.ipv4;
  const ipv6 = override.includes(":") ? [override] : settings.server.ipv6;
  return [
    ...ipv4.map((address) => `A ${hostname} ${address}`),
    ...ipv6.map((address) => `AAAA ${hostname} ${address}`),
  ];
}

export function suggestedPublicIngressDomain(privateDomain: string): string {
  const hostname = ingressHostname(privateDomain, "");
  return hostname ? `ingress.${hostname}` : "";
}

export function publicUrlForMethod(
  settings: PublicIngressSettings,
  method: IngressExposure,
  draft: string,
): string {
  const hostname = ingressHostname(draft, "");
  return hostname ? `https://${hostname}` : "";
}

export function customCaddyConfig(value: string): string {
  return `${ingressHostname(value)} {\n    # BEGIN OPENSESSION SANDBOX INGRESS\n    handle {\n        reverse_proxy 127.0.0.1:3860\n    }\n    # END OPENSESSION SANDBOX INGRESS\n}`;
}

export function configuredAppDomain(settings: PublicIngressSettings): string {
  try {
    const url = new URL(settings.app.publicBaseUrl);
    return url.protocol === "https:" ? url.hostname : "";
  } catch {
    return "";
  }
}

export function privateAppDnsRecord(
  settings: PublicIngressSettings,
  value: string,
): string | null {
  return settings.app.tailnetIpv4
    ? `A ${ingressHostname(value, "os.example.com")} ${settings.app.tailnetIpv4}`
    : null;
}

export function privateAppCaddyConfig(
  settings: PublicIngressSettings,
  value: string,
): string {
  const hostname = ingressHostname(value, "os.example.com");
  const bind = settings.app.tailnetIpv4 || "<tailscale-ip>";
  return `${hostname} {\n    bind ${bind}\n    tls /etc/opensession/tls/${hostname}.crt /etc/opensession/tls/${hostname}.key\n    reverse_proxy 127.0.0.1:3850 {\n        lb_try_duration 15s\n        lb_try_interval 250ms\n    }\n}`;
}

export function configuredIngressDrafts(
  settings: PublicIngressSettings,
): Record<IngressExposure, string> {
  const suggestedDomain = suggestedPublicIngressDomain(
    configuredAppDomain(settings),
  );
  return {
    cloudflare:
      settings.exposure === "cloudflare" && settings.publicBaseUrl
        ? settings.publicBaseUrl
        : suggestedDomain
          ? `https://${suggestedDomain}`
          : "",
    custom:
      settings.exposure === "custom" && settings.publicBaseUrl
        ? ingressHostname(settings.publicBaseUrl, "")
        : suggestedDomain,
  };
}
