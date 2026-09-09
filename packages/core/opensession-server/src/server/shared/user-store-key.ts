import { createHash } from "node:crypto";

/** Identity → the filename stem every store writes (mirrors drafts.ts). */
export function canonicalName(identity: string): string {
  const normalized = identity.trim() || "Anonymous";
  const cleaned = normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const hash = createHash("sha256")
    .update(normalized.toLocaleLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `${cleaned || "Anonymous"}-${hash}`;
}

/** A name safe to read back verbatim: no separators, no traversal. */
const SAFE_VERBATIM = /^[A-Za-z0-9@._-]+$/;

/** Filename stems these stores wrote before canonicalName; read-only. */
export function legacyNames(identity: string): string[] {
  const normalized = identity.trim() || "Anonymous";
  const slug =
    normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "Anonymous";
  const names = [slug];
  if (
    normalized !== slug &&
    SAFE_VERBATIM.test(normalized) &&
    !normalized.includes("..")
  ) {
    names.push(normalized);
  }
  return names;
}
