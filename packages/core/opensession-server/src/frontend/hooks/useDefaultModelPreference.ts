import { useEffect, useState } from "react";
import {
  getDefaultEffortPref,
  onDefaultEffortPrefChanged,
  setDefaultEffortPref,
} from "../lib/default-effort-pref";
import {
  getDefaultModelPref,
  onDefaultModelPrefChanged,
  setDefaultModelPref,
} from "../lib/default-model-pref";

/** Save a model, and the effort chosen with it, as this person's defaults for
 *  new sessions. No effort leaves the effort preference as it is. */
function setPreferredDefault(model: string, effort?: string) {
  setDefaultModelPref(model);
  if (effort !== undefined) setDefaultEffortPref(effort);
}

/** Keep the per-user new-session model and effort preferences live across
 *  settings and tabs. */
export function useDefaultModelPreference() {
  const [preferredDefaultModel, setPreferredDefaultModelState] =
    useState(getDefaultModelPref);
  const [preferredDefaultEffort, setPreferredDefaultEffortState] =
    useState(getDefaultEffortPref);
  useEffect(
    () =>
      onDefaultModelPrefChanged(() =>
        setPreferredDefaultModelState(getDefaultModelPref()),
      ),
    [],
  );
  useEffect(
    () =>
      onDefaultEffortPrefChanged(() =>
        setPreferredDefaultEffortState(getDefaultEffortPref()),
      ),
    [],
  );
  return {
    preferredDefaultModel,
    preferredDefaultEffort,
    setPreferredDefaultModel: setPreferredDefault,
  };
}
