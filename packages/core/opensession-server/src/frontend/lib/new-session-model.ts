/** Resolve the per-user model preselect for a new session. */
export interface NewSessionModelInput {
  models: { id: string }[];
  default: string;
  modelPref: string;
}

/** Empty means no preference, so the server applies its Pi default. */
export function preferredNewSessionModel(input: NewSessionModelInput): string {
  if (
    input.modelPref &&
    input.models.some((model) => model.id === input.modelPref)
  ) {
    return input.modelPref;
  }
  return input.default.startsWith("pi/workspace-preset/") ? input.default : "";
}
