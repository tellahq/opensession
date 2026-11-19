import { brandKey, brandLogo } from "../brand-logos";
import { modelVendor } from "./model-engine";

/** Product-facing model brands for upstream vendors whose registry names differ. */
const VENDOR_BRANDS = new Map<string, string>([
  ["anthropic", "claude"],
  ["openai", "codex"],
  ["xai-oauth", "xai"],
  // Pi's slug for the Gemini API. Mapped here, not as a brand alias, so a
  // connection named "google" does not draw the Gemini mark.
  ["google", "gemini"],
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
