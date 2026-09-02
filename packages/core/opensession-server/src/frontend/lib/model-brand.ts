import { brandKey, brandLogo } from "../brand-logos";
import { modelVendor } from "./model-engine";

/** Product-facing model brands for upstream vendors whose registry names differ. */
const VENDOR_BRANDS = new Map<string, string>([
  ["anthropic", "claude"],
  ["openai", "codex"],
]);

/** Resolve one concrete model id to its product-facing brand mark. */
export function modelBrandKey(id: string, provider?: string): string | null {
  const vendor = modelVendor(id);
  if (vendor) {
    const key = VENDOR_BRANDS.get(vendor) ?? brandKey(vendor);
    return brandLogo(key) ? key : null;
  }
  // Legacy direct-SDK ids carry no vendor segment; the engine names it.
  if (provider === "claude" || id.startsWith("claude-")) return "claude";
  if (provider === "codex" || id.startsWith("gpt-") || id.startsWith("codex-"))
    return "codex";
  return null;
}

/**
 * Resolve every vendor participating in a model choice. Presets carry their
 * concrete lead/supporting composition from the catalog; repeated vendors
 * collapse to one mark, while a cross-vendor combo keeps both.
 */
export function modelBrandKeys(
  id: string,
  provider?: string,
  composition?: string[],
): string[] {
  const keys = (composition?.length ? composition : [id])
    .map((model) => modelBrandKey(model, provider))
    .filter((key): key is string => !!key);
  return [...new Set(keys)];
}
