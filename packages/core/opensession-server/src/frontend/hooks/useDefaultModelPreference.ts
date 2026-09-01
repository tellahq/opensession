import { useEffect, useState } from "react";
import {
  getDefaultModelPref,
  onDefaultModelPrefChanged,
  setDefaultModelPref,
} from "../lib/default-model-pref";

/** Keep the per-user new-session model preference live across settings and tabs. */
export function useDefaultModelPreference() {
  const [preferredDefaultModel, setPreferredDefaultModelState] =
    useState(getDefaultModelPref);
  useEffect(
    () =>
      onDefaultModelPrefChanged(() =>
        setPreferredDefaultModelState(getDefaultModelPref()),
      ),
    [],
  );
  return {
    preferredDefaultModel,
    setPreferredDefaultModel: setDefaultModelPref,
  };
}
