/** Validate the immutable release's prebuilt SPA before any service is stopped. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FRONTEND_DIST,
  frontendInputsHash,
} from "../packages/core/opensession-server/src/server/frontend-build";

type BundleMeta = {
  inputsHash?: unknown;
  assets?: unknown;
};

export function validateFrontendBuild(
  dist: string,
  expectedHash: string,
): { assets: string[]; inputsHash: string } {
  const metaPath = join(dist, ".bundle-meta.json");
  let meta: BundleMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as BundleMeta;
  } catch (error) {
    throw new Error(
      `frontend bundle metadata is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (meta.inputsHash !== expectedHash) {
    throw new Error(
      `frontend bundle input hash mismatch: expected ${expectedHash}, got ${String(meta.inputsHash || "missing")}`,
    );
  }
  if (!Array.isArray(meta.assets) || meta.assets.length === 0) {
    throw new Error("frontend bundle metadata has no assets");
  }
  const assets = meta.assets as unknown[];
  for (const asset of assets) {
    if (typeof asset !== "string" || !asset || !existsSync(join(dist, asset))) {
      throw new Error(
        `frontend bundle is incomplete: missing ${String(asset)}`,
      );
    }
  }
  return { assets: assets as string[], inputsHash: expectedHash };
}

if (import.meta.main) {
  const validated = validateFrontendBuild(FRONTEND_DIST, frontendInputsHash());
  console.log(
    `frontend bundle validated (${validated.assets.length} assets, inputs ${validated.inputsHash})`,
  );
}
