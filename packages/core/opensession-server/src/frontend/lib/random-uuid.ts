/**
 * Mint a UUID in browsers where `crypto.randomUUID` is unavailable.
 *
 * Browsers expose `crypto.getRandomValues` on plain HTTP origins, but gate
 * `randomUUID` behind a secure context. Private-network installs are commonly
 * opened through an HTTP Tailscale IP, so every client-side id must use this
 * wrapper rather than calling `crypto.randomUUID` directly.
 */
type UUIDCrypto = Pick<Crypto, "getRandomValues"> &
  Partial<Pick<Crypto, "randomUUID">>;

export function randomUUID(source: UUIDCrypto = globalThis.crypto): string {
  if (source.randomUUID) return source.randomUUID();

  const bytes = source.getRandomValues(new Uint8Array(16));
  // UUIDv4 version and RFC 9562 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
