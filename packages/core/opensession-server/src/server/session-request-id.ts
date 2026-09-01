/** Stable session id for a retried create intent, scoped to its verified actor. */
export function sessionIdForRequest(scope: string, requestId: string): string {
  const hex = new Bun.CryptoHasher("sha256")
    .update(`${scope}\0${requestId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "7";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const id = hex.join("");
  return `bks-${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Canonical JSON identity: object key order never changes a durable receipt. */
export function canonicalCommandPayload(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return input;
  };
  return JSON.stringify(normalize(value));
}
