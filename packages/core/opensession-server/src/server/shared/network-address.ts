import { isIP } from "net";

/** Normalize IPv4-mapped addresses and the ordinary IPv4:port form used by
 * Runner callers. Native IPv6 carries several colons and remains untouched. */
export function normalizeAddress(address: string): string {
  let ip = (address || "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const lastColon = ip.lastIndexOf(":");
  if (lastColon > 0 && ip.indexOf(":") === lastColon)
    ip = ip.slice(0, lastColon);
  return ip;
}

export function isTailnetIpv4(address: string): boolean {
  const octets = normalizeAddress(address).split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    ) &&
    octets[0] === 100 &&
    octets[1]! >= 64 &&
    octets[1]! <= 127
  );
}

/** Tailscale CGNAT plus loopback for a self-hosted single-box installation. */
export function isTailnetAddress(address: string): boolean {
  const ip = normalizeAddress(address);
  return ip === "127.0.0.1" || ip === "::1" || isTailnetIpv4(ip);
}

/** RFC1918 + loopback + link-local (cloud metadata) + CGNAT/tailnet +
 * multicast/reserved, and the IPv6 equivalents. */
export function isBlockedAddress(ip: string): boolean {
  const value = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (isTailnetIpv4(value)) return true;
    if (a! >= 224) return true;
    return false;
  }
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("::ffff:")) return isBlockedAddress(value.slice(7));
  if (value.startsWith("fe80") || value.startsWith("fec0")) return true;
  if (/^f[cd]/.test(value)) return true;
  if (/^ff/.test(value)) return true;
  return false;
}
