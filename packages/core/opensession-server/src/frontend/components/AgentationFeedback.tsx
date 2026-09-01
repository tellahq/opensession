import { lazy, Suspense } from "react";

import { useIsPhone } from "../hooks/useIsPhone";
import { AGENTATION_ENABLED } from "../lib/brand";
import { isTouchPrimary } from "../lib/platform";

const Agentation = lazy(() =>
  import("agentation").then((module) => ({ default: module.Agentation })),
);

/** Opt-in visual page feedback. Agentation does not support touch. */
export function AgentationFeedback() {
  const isPhone = useIsPhone();
  if (!AGENTATION_ENABLED || isPhone || isTouchPrimary) return null;

  return (
    <Suspense fallback={null}>
      <Agentation />
    </Suspense>
  );
}
