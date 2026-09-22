import type { PiCatalogModel } from "./pi-model-runtime";

/**
 * The native provider's catalog: pi's builtin anthropic models passed through
 * untouched (ids, cost tables, context windows, compat — registerNativeProvider
 * REPLACES the builtin provider, so the catalog must ride along), plus
 * release metadata for known newer models. Unknown ids retain the conservative
 * zero-cost subscription fallback. Shared by native and HTTP bridge transports.
 */
export function buildPiAnthropicModels(
  builtin: readonly PiCatalogModel[],
  ensureModelId?: string,
): PiCatalogModel[] {
  const models = builtin.map((m) => ({ ...m }));
  if (ensureModelId && !models.some((m) => m.id === ensureModelId)) {
    models.push({
      id: ensureModelId,
      name:
        ensureModelId === "claude-opus-5-5" ? "Claude Opus 5.5" : ensureModelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      // https://platform.claude.com/docs/en/models/opus-5-5/overview
      ...(ensureModelId === "claude-opus-5-5"
        ? {
            cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
            contextWindow: 1_000_000,
            maxTokens: 128_000,
          }
        : {
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 32_000,
          }),
    } as PiCatalogModel);
  }
  return models;
}
