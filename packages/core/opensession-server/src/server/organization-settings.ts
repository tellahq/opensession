/** Organization artwork stored beside the instance's other durable state. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { stateDir } from "./paths";

export const MAX_ORGANIZATION_ICON_BYTES = 4 * 1024 * 1024;
const MAX_ICON_SIDE = 2048;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class OrganizationIconError extends Error {}

export function organizationIconPath(): string {
  return `${stateDir("organization")}/icon.png`;
}

export function organizationIconRevision(): string | null {
  const path = organizationIconPath();
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12)
    : null;
}

export function organizationIconBytes(): Uint8Array | null {
  const path = organizationIconPath();
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

function pngDimension(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

/** Store the square PNG prepared by the web or native image picker. */
export function saveOrganizationIcon(bytes: Uint8Array): void {
  if (!bytes.length) throw new OrganizationIconError("The upload was empty");
  if (bytes.length > MAX_ORGANIZATION_ICON_BYTES) {
    throw new OrganizationIconError(
      "That image is too large. Icons cap at 4 MB.",
    );
  }
  if (
    bytes.length < 24 ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  ) {
    throw new OrganizationIconError("An organization icon has to be a PNG");
  }
  const width = pngDimension(bytes, 16);
  const height = pngDimension(bytes, 20);
  if (!width || width !== height || width > MAX_ICON_SIDE) {
    throw new OrganizationIconError(
      `Use a square icon up to ${MAX_ICON_SIDE} × ${MAX_ICON_SIDE} pixels`,
    );
  }
  const path = organizationIconPath();
  mkdirSync(stateDir("organization"), { recursive: true });
  writeFileSync(path, bytes);
}

export function removeOrganizationIcon(): void {
  rmSync(organizationIconPath(), { force: true });
}
