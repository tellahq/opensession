import { lazy, Suspense, useEffect, useState } from "react";

import { useIsPhone } from "../hooks/useIsPhone";
import { getAgentationPref, onAgentationChanged } from "../lib/agentation-pref";
import { AGENTATION_ENABLED } from "../lib/brand";
import { isTouchPrimary } from "../lib/platform";

const Agentation = lazy(() =>
  import("agentation").then((module) => ({ default: module.Agentation })),
);

/** Visual page feedback, gated by the instance and personal preference. */
export function AgentationFeedback() {
  const isPhone = useIsPhone();
  const [wanted, setWanted] = useState(getAgentationPref);
  useEffect(
    () => onAgentationChanged(() => setWanted(getAgentationPref())),
    [],
  );
  if (!AGENTATION_ENABLED || !wanted || isPhone || isTouchPrimary) return null;

  return (
    <Suspense fallback={null}>
      <Agentation />
    </Suspense>
  );
}
