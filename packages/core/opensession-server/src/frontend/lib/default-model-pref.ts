// Per-user default model for NEW sessions (Settings → Preferences): what the
// New-session palette (and the workspace/support first-session composers)
// preselect for this user. "" = no preference — fall back to the workspace's
// interactive default from GET /api/models. A makeUserPref instance — see
// lib/user-pref for the server-side ui-prefs hydrate pattern. Any string the
// server sends (including "" for an explicit reset) is applied as-is.
//
// resolveNewSessionModel below is what those composers actually call: it folds
// in the engine half of the same question (lib/default-engine-pref) through
// the rule in lib/new-session-model.

import { z } from "zod";
import { preferredNewSessionModel } from "./new-session-model";
import * as userPref from "./user-pref";

const storedModelSchema = z.string();

const pref = userPref.makeUserPref<string>({
  localKey: "opensession-default-model-pref",
  prefKey: "default-model",
  changeEvent: "opensession-default-model-pref-changed",
  defaultValue: "",
  decode: (value) => {
    const result = storedModelSchema.safeParse(value);
    return result.success ? result.data : null;
  },
  encode: (v) => v,
});

/** The user's preferred new-session model id, or "" for no preference. */
export const getDefaultModelPref = pref.get;
export const setDefaultModelPref = pref.set;
export const onDefaultModelPrefChanged = pref.onChanged;

/**
 * The id a new-session composer should preselect for this person: their model
 * and engine preferences applied to the catalog it just fetched. "" means no
 * preference, so the composer sends no model and the server picks.
 */
export async function resolveNewSessionModel(catalog: {
  models: { id: string }[];
  default: string;
}): Promise<string> {
  return preferredNewSessionModel({
    models: catalog.models,
    default: catalog.default,
    modelPref: getDefaultModelPref(),
  });
}
