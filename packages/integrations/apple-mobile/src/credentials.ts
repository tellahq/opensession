import { resolvePrivateKeyPath } from "./security";

export const CREDENTIAL_REFS = {
  keyId: "<APPLE_ASC_KEY_ID>",
  issuerId: "<APPLE_ASC_ISSUER_ID>",
  keyPath: "<APPLE_ASC_PRIVATE_KEY_PATH>",
} as const;

export function credentials(required: boolean, projectDir?: string) {
  const keyId = process.env.APPLE_ASC_KEY_ID;
  const issuerId = process.env.APPLE_ASC_ISSUER_ID;
  const keyPath = process.env.APPLE_ASC_PRIVATE_KEY_PATH;
  if (required && (!keyId || !issuerId || !keyPath)) {
    throw new Error(
      "APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID, and APPLE_ASC_PRIVATE_KEY_PATH are required",
    );
  }
  const resolvedKeyPath = keyPath
    ? resolvePrivateKeyPath(keyPath, projectDir)
    : undefined;
  return { keyId, issuerId, keyPath: resolvedKeyPath };
}
