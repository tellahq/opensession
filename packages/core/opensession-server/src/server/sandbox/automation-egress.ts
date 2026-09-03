/**
 * Outbound policy for sandboxed automation runs.
 *
 * A sandboxed automation runs in a disposable Daytona Executor whose egress is
 * restricted with Daytona's per-sandbox domain allowlist (runner-enforced, no
 * essential-services bypass). This module turns the launch's inputs into that
 * list: the hosts every run needs (model APIs, GitHub, the Open Session
 * dial-back), runner bootstrap services, the run's MCP destinations, and the
 * operator's extra entries.
 *
 * Daytona accepts hostnames and `*.` wildcards only, at most 20 entries, and
 * its domain and CIDR allowlists are mutually exclusive. Anything that cannot
 * be expressed inside those limits fails closed here instead of launching a
 * run with a wider policy than the operator configured.
 */

export const AUTOMATION_BASELINE_EGRESS_DOMAINS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "bun.sh",
  "nodejs.org",
  "registry.npmjs.org",
] as const;

/** Daytona's documented ceiling for `domainAllowList`. */
export const DAYTONA_DOMAIN_ALLOWLIST_MAX = 20;

export function automationModelEgressDestinations(model: string): string[] {
  if (/^pi\/anthropic\//.test(model)) return ["api.anthropic.com"];
  if (/^pi\/openai\//.test(model)) return ["api.openai.com", "chatgpt.com"];
  throw new Error(`unsupported sandbox automation model: ${model}`);
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

function looksLikeIp(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * Normalize one operator- or config-supplied egress entry to a Daytona domain
 * allowlist item. Accepts a bare hostname, a `*.example.com` wildcard, or a
 * URL (only its host is kept). Refuses IPs, CIDRs, ports, paths, and
 * bare wildcards: Daytona cannot combine a domain list with CIDRs, and a run
 * must never be admitted with a policy Daytona will silently drop.
 */
export function parseAutomationEgressDomain(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("empty automation egress destination");
  let host = raw;
  let wildcard = false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`invalid automation egress destination: ${value}`);
    }
    if (!/^(?:https?|wss?):$/.test(url.protocol)) {
      throw new Error(`unsupported automation egress destination: ${value}`);
    }
    host = url.hostname;
  } else {
    if (raw.startsWith("*.")) {
      wildcard = true;
      host = raw.slice(2);
    }
    if (/[/?#:@\s]/.test(host)) {
      throw new Error(
        `automation egress destinations must be hostnames, not URLs with paths, ports, or CIDRs: ${value}`,
      );
    }
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (!host || host === "*") {
    throw new Error(`wildcards are not allowed in automation egress: ${value}`);
  }
  if (looksLikeIp(host) || /^\[/.test(host)) {
    throw new Error(
      `automation egress destinations must be domains, not IP addresses or CIDRs: ${value}`,
    );
  }
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    !labels.every((label) => HOSTNAME_LABEL.test(label))
  ) {
    throw new Error(`invalid automation egress destination: ${value}`);
  }
  return wildcard ? `*.${host}` : host;
}

/** Hosts a run's projected MCP configuration will contact. */
export function mcpEgressDestinations(
  projected: Record<string, unknown>,
): string[] {
  const destinations = new Set<string>();
  for (const config of Object.values(projected)) {
    if (!config || typeof config !== "object") continue;
    const entry = config as Record<string, unknown>;
    if (typeof entry.url === "string") destinations.add(entry.url);
    if (entry.env && typeof entry.env === "object") {
      for (const value of Object.values(entry.env as Record<string, unknown>)) {
        if (typeof value === "string" && /^(?:https?|wss?):\/\//i.test(value))
          destinations.add(value);
      }
    }
  }
  return [...destinations];
}

/**
 * The complete domain allowlist for one automation launch, deduplicated and
 * bounded by Daytona's limit. Throws when the run cannot be expressed within
 * that limit rather than dropping entries.
 */
export function automationEgressDomains(input: {
  callbackBaseUrl: string;
  cloneUrl: string;
  mcpDestinations?: string[];
  extra?: string[];
}): string[] {
  const domains = new Set<string>();
  for (const value of [
    input.callbackBaseUrl,
    input.cloneUrl,
    ...AUTOMATION_BASELINE_EGRESS_DOMAINS,
    ...(input.mcpDestinations || []),
    ...(input.extra || []),
  ]) {
    domains.add(parseAutomationEgressDomain(value));
  }
  const list = [...domains];
  if (list.length > DAYTONA_DOMAIN_ALLOWLIST_MAX) {
    throw new Error(
      `automation egress allowlist has ${list.length} domains; Daytona allows at most ${DAYTONA_DOMAIN_ALLOWLIST_MAX}. Trim the automation's MCP servers or the configured egressAllowlist.`,
    );
  }
  return list;
}

const EGRESS_PROBE_CANDIDATES = [
  "https://example.com/",
  "https://www.iana.org/",
  "https://example.org/",
] as const;

function domainAllowsHost(domain: string, host: string): boolean {
  return (
    domain === host ||
    (domain.startsWith("*.") && host.endsWith(domain.slice(1)))
  );
}

/** Pick a real reachable host outside the policy so the launch can prove it is blocked. */
export function automationEgressProbeBlockedUrl(domains: string[]): string {
  const candidate = EGRESS_PROBE_CANDIDATES.find((url) => {
    const host = new URL(url).hostname;
    return !domains.some((domain) => domainAllowsHost(domain, host));
  });
  if (!candidate) {
    throw new Error(
      "automation egress allowlist includes every policy probe host; remove example.com, iana.org, or example.org",
    );
  }
  return candidate;
}

/** Comma-separated form Daytona's API expects. */
export function daytonaDomainAllowList(domains: string[]): string {
  return domains.join(",");
}
