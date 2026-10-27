import { baseModelId } from "./model-engine";

/** Resolve the per-user model and effort preselect for a new session. */
export interface NewSessionModelInput {
  models: { id: string; efforts?: string[] }[];
  default: string;
  modelPref: string;
}

/** Empty means no preference, so the server applies its Pi default. A stored
 * retired preset id counts as the model it ran on. */
export function preferredNewSessionModel(input: NewSessionModelInput): string {
  const pref = input.modelPref ? baseModelId(input.modelPref) : "";
  return pref && input.models.some((model) => model.id === pref) ? pref : "";
}

/** The preferred effort for the model a new session starts on, or undefined
 * when there is no preference or that model does not offer it. */
export function preferredNewSessionEffort(input: {
  models: { id: string; efforts?: string[] }[];
  model: string;
  effortPref: string;
}): string | undefined {
  if (!input.effortPref) return undefined;
  const efforts = input.models.find((m) => m.id === input.model)?.efforts;
  return efforts?.includes(input.effortPref) ? input.effortPref : undefined;
}
