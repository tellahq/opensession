import { lazy, Suspense } from "react";

const Agentation = lazy(() =>
  import("agentation").then((module) => ({ default: module.Agentation })),
);

const feedbackHost =
  ["localhost", "127.0.0.1"].includes(window.location.hostname) ||
  window.location.hostname.endsWith(".ts.net");
const feedbackDevice = !window.matchMedia(
  "(max-width: 720px), (pointer: coarse)",
).matches;

/** Desktop visual feedback for local development and tailnet staging. */
export function AgentationFeedback() {
  if (!feedbackHost || !feedbackDevice) return null;

  return (
    <Suspense fallback={null}>
      <Agentation />
    </Suspense>
  );
}
