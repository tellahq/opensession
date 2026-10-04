/** Additive client/server feature negotiation. Missing keys are unsupported. */
export const CAPABILITY_KEYS = [
  "commandResults",
  "deskVoice",
  "sessionVoice",
  "sessionListSlices",
  "sessionCreateIdempotency",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type ServerCapabilities = Partial<
  Record<CapabilityKey, boolean | number>
>;

export interface ServerDescriptor {
  serverVersion: string;
  protocolVersion: number;
  capabilities: ServerCapabilities;
}

/** Tolerate future keys and malformed values without enabling a feature. */
export function decodeServerDescriptor(
  value: unknown,
): ServerDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const wire = value as Record<string, unknown>;
  if (
    typeof wire.serverVersion !== "string" ||
    !Number.isSafeInteger(wire.protocolVersion) ||
    (wire.protocolVersion as number) < 1 ||
    !wire.capabilities ||
    typeof wire.capabilities !== "object"
  )
    return null;
  const capabilities: ServerCapabilities = {};
  const source = wire.capabilities as Record<string, unknown>;
  for (const key of CAPABILITY_KEYS) {
    const flag = source[key];
    if (
      typeof flag === "boolean" ||
      (typeof flag === "number" && Number.isSafeInteger(flag) && flag >= 0)
    ) {
      capabilities[key] = flag;
    }
  }
  return {
    serverVersion: wire.serverVersion,
    protocolVersion: wire.protocolVersion as number,
    capabilities,
  };
}

export function supportsCapability(
  descriptor: ServerDescriptor | null | undefined,
  key: CapabilityKey,
  minimumVersion = 1,
): boolean {
  const flag = descriptor?.capabilities[key];
  return flag === true
    ? minimumVersion <= 1
    : typeof flag === "number" && flag >= minimumVersion;
}
