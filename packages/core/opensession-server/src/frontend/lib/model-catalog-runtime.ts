import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { request } from "./api/request";

export const engineCapabilitiesSchema = Schema.Struct({
  version: Schema.Literal(1),
  supportsSteering: Schema.Boolean,
  supportsInterrupt: Schema.Boolean,
  canResume: Schema.Boolean,
  canRewindConversation: Schema.Boolean,
  canForkNatively: Schema.Boolean,
  supportsMcpTools: Schema.Boolean,
  supportsImages: Schema.Boolean,
  streamsReasoning: Schema.Boolean,
  emitsToolOutput: Schema.Boolean,
  terminalStatusQuality: Schema.Literals(["authoritative", "best-effort"]),
});
const modelSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.Literals(["claude", "codex", "pi", "acp"]),
  label: Schema.String,
  aliases: Schema.Array(Schema.String),
  efforts: Schema.Array(Schema.String),
  fixedEffort: Schema.optionalKey(Schema.String),
  accountProvider: Schema.optionalKey(
    Schema.Literals(["claude", "codex", "xai"]),
  ),
  group: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  composition: Schema.optionalKey(Schema.Array(Schema.String)),
  fastModeSupported: Schema.optionalKey(Schema.Boolean),
  ultrafastSupported: Schema.optionalKey(Schema.Boolean),
  engineCapabilities: Schema.optionalKey(engineCapabilitiesSchema),
  available: Schema.optionalKey(Schema.Boolean),
  unavailableReason: Schema.optionalKey(Schema.String),
});
const catalogSchema = Schema.Struct({
  models: Schema.Array(modelSchema),
  default: Schema.String,
});
export class ModelCatalogFetchError extends Error {
  readonly _tag = "ModelCatalogFetchError";
}
/** Fetching and wire decoding live outside React; interruption aborts HTTP. */
export function fetchModelCatalog(workspaceId?: string) {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  return Effect.tryPromise({
    try: (signal) =>
      request<unknown>(`/models${params.size ? `?${params}` : ""}`, {
        signal,
        label: "Failed to fetch models",
      }),
    catch: (error) => new ModelCatalogFetchError(String(error)),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(catalogSchema)));
}
/** Unknown metadata preserves existing clients; a declared false always wins. */
export function modelSupportsSteering(
  models: ReadonlyArray<{
    id: string;
    engineCapabilities?: { supportsSteering: boolean };
  }>,
  id?: string,
): boolean {
  return (
    models.find((model) => model.id === id)?.engineCapabilities
      ?.supportsSteering !== false
  );
}
