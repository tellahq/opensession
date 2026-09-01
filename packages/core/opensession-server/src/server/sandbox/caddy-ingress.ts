/** Discovery and generated Caddy configuration for sandbox ingress. */

import { configuredIngress, configuredServer } from "../config";

export interface SandboxIngressStatus {
  configuredUrl?: string;
  proposedUrl?: string;
  source: "config" | "caddy" | "none";
  health: "ready" | "unreachable" | "not_configured";
  caddyAdminReachable: boolean;
  generatedSnippet: string;
  note?: string;
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "wss:") return undefined;
    return `https://${url.host}`;
  } catch {
    return undefined;
  }
}

export function ingressHostsFromCaddy(config: unknown): string[] {
  const found = new Set<string>();
  function walk(value: unknown, inheritedHosts: string[] = []): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, inheritedHosts);
      return;
    }
    const object = value as Record<string, unknown>;
    let hosts = inheritedHosts;
    if (Array.isArray(object.match)) {
      const matched = object.match.flatMap((entry: any) =>
        Array.isArray(entry?.host)
          ? entry.host.filter((host: unknown) => typeof host === "string")
          : [],
      );
      if (matched.length) hosts = matched;
    }
    if (object.handler === "reverse_proxy" && Array.isArray(object.upstreams)) {
      const ingress = object.upstreams.some((upstream: any) =>
        /(^|:)3860$/.test(String(upstream?.dial || "")),
      );
      if (ingress) for (const host of hosts) found.add(host);
    }
    for (const child of Object.values(object)) walk(child, hosts);
  }
  walk(config);
  return [...found];
}

const MANAGED_START = "# BEGIN OPENSESSION SANDBOX INGRESS";
const MANAGED_END = "# END OPENSESSION SANDBOX INGRESS";

function managedRoutes(indent = "    ", bindAddress?: string): string {
  const bind = bindAddress ? `${indent}bind ${bindAddress}\n` : "";
  return `${indent}${MANAGED_START}
${bind}${indent}handle {
${indent}    reverse_proxy 127.0.0.1:3860
${indent}}
${indent}${MANAGED_END}`;
}

function closingBrace(source: string, opening: number): number | undefined {
  let depth = 0;
  let quoted = false;
  let comment = false;
  for (let index = opening; index < source.length; index++) {
    const char = source[index];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (!quoted && char === "#") {
      comment = true;
      continue;
    }
    if (char === '"' && source[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return undefined;
}

function hostLabelMatches(label: string, host: string): boolean {
  return label
    .trim()
    .split(/[\s,]+/)
    .map((part) => part.replace(/^https?:\/\//, "").replace(/:443$/, ""))
    .includes(host);
}

function siteRanges(
  source: string,
  host: string,
): Array<{ opening: number; closing: number }> {
  const ranges: Array<{ opening: number; closing: number }> = [];
  const headers = /^([^\n#{}]+)\{/gm;
  for (const match of source.matchAll(headers)) {
    if (!hostLabelMatches(match[1] || "", host)) continue;
    const opening = (match.index || 0) + match[0].lastIndexOf("{");
    const closing = closingBrace(source, opening);
    if (closing !== undefined) ranges.push({ opening, closing });
  }
  return ranges;
}

function stripKnownSandboxRoutes(site: string): string {
  const paths = [
    "/run-ws/\\*",
    "/rpc-ws",
    "/sandbox-portal-ws",
    "/ingress-health",
    "/workload-identity/\\*",
    "/opensession/run-ws/\\*",
    "/opensession/rpc-ws",
    "/backstage/run-ws/\\*",
    "/backstage/rpc-ws",
  ];
  for (const path of paths) {
    site = site.replace(
      new RegExp(
        `^[ \\t]*handle ${path} \\{\\s*reverse_proxy (?:localhost|127\\.0\\.0\\.1):3860\\s*\\}\\s*`,
        "gm",
      ),
      "",
    );
  }
  // Remove the retired webhook listener fallback. The unified gateway on 3860
  // now owns those exact registered routes too.
  return site.replace(
    /^[ \t]*handle\s*\{\s*reverse_proxy (?:localhost|127\.0\.0\.1):3848\s*\}\s*/gm,
    "",
  );
}

/**
 * Own the sandbox route section in an existing webhook host, or create a new
 * public webhook host when it is absent. The markers make reruns idempotent.
 */
export function upsertCaddyIngress(
  caddyfile: string,
  origin: string,
  bindAddress?: string,
): string {
  const host = new URL(origin).host;
  const managed = new RegExp(
    `^[ \\t]*${MANAGED_START}[\\s\\S]*?^[ \\t]*${MANAGED_END}[ \\t]*(?:\\r?\\n)?`,
    "gm",
  );
  let next = caddyfile.replace(managed, "");
  const matches = siteRanges(next, host);
  if (matches.length > 1) {
    throw new Error(
      `Caddyfile defines ${host} more than once; consolidate it before setup`,
    );
  }
  if (!matches.length) {
    return `${next.trimEnd()}\n\n${caddyIngressSnippet(origin, bindAddress)}\n`;
  }
  const range = matches[0]!;
  const site = stripKnownSandboxRoutes(
    next.slice(range.opening + 1, range.closing),
  );
  return `${next.slice(0, range.opening + 1)}\n${managedRoutes("    ", bindAddress)}\n${site.replace(/^\s*\n/, "")}${next.slice(range.closing)}`;
}

export function caddyIngressSnippet(
  origin: string,
  bindAddress?: string,
): string {
  const host = new URL(origin).host;
  return `${host} {\n${managedRoutes("    ", bindAddress)}\n}`;
}

async function health(
  origin: string | undefined,
): Promise<"ready" | "unreachable" | "not_configured"> {
  if (!origin) return "not_configured";
  try {
    const response = await fetch(`${origin}/ingress-health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok && (await response.text()).trim() === "ok"
      ? "ready"
      : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function sandboxIngressStatus(): Promise<SandboxIngressStatus> {
  const configured = normalizeOrigin(configuredIngress().publicBaseUrl);
  let caddyAdminReachable = false;
  let caddyHosts: string[] = [];
  try {
    const response = await fetch(
      `${configuredServer().caddyAdmin.replace(/\/$/, "")}/config/`,
      {
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (response.ok) {
      caddyAdminReachable = true;
      caddyHosts = ingressHostsFromCaddy(await response.json());
    }
  } catch {}
  const caddyOrigin =
    caddyHosts.length === 1 ? `https://${caddyHosts[0]}` : undefined;
  const proposed = configured || caddyOrigin;
  const source: SandboxIngressStatus["source"] = configured
    ? "config"
    : caddyOrigin
      ? "caddy"
      : "none";
  return {
    ...(configured ? { configuredUrl: configured } : {}),
    ...(proposed ? { proposedUrl: proposed } : {}),
    source,
    health: await health(configured),
    caddyAdminReachable,
    generatedSnippet: caddyIngressSnippet(
      proposed || "https://ingress.example.com",
    ),
    ...(caddyHosts.length > 1
      ? {
          note: "More than one Caddy host routes to the webhook listener; choose the public origin explicitly.",
        }
      : !configured && caddyOrigin
        ? {
            note: "An existing public webhook origin was found. Confirm it before Open Session uses it for sandbox callbacks.",
          }
        : !configured
          ? {
              note: "Enter a public HTTPS origin or add the generated routes to Caddy.",
            }
          : {}),
  };
}
