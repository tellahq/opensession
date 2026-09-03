import React from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { EffectRegistryProvider } from "./components/EffectRegistryProvider";
import { AgentationFeedback } from "./components/AgentationFeedback";
import { PreviewWait, matchPreviewWaitRoute } from "./components/PreviewWait";
import { TranscriptMotionLab } from "./components/TranscriptMotionLab";
import { transcriptMotionFixtureOptions } from "./lib/transcript-motion-scenarios";
import { TooltipProvider } from "./ui/tooltip";
import { AppContent } from "./AppContent";
import type { AppProps } from "./lib/app-types";

declare global {
  interface Window {
    __OPENSESSION_DEMO__?: boolean;
  }
}

// Order matters: base.css (tokens, reset, platform chrome) then legacy.css,
// which is now empty and stays imported so the "never add here" contract keeps
// a home. Utilities are linked after both, so they win source-order ties.
import "./styles/base.css";
import "./styles/legacy.css";

export function App(props: AppProps = {}) {
  return (
    <EffectRegistryProvider>
      <AppContent {...props} />
    </EffectRegistryProvider>
  );
}

// The marketing-site preview imports this component into its own fixture root.
// Keep the ordinary SPA bootstrap intact for every production build, including
// servers that still have this file configured as the bundle entry.
const embeddedDemo = Boolean(window.__OPENSESSION_DEMO__);
if (!embeddedDemo) {
  // The preview interstitial renders INSTEAD of the app (and outside UserGate —
  // it must work in cold-storage contexts like the iOS PWA's in-app browser).
  const previewWaitSessionId = matchPreviewWaitRoute(location.pathname);
  const transcriptMotionFixture = transcriptMotionFixtureOptions(
    location.pathname,
    location.search,
  );
  // `reducedMotion="user"` makes every `motion.*` component honour the OS
  // setting. Motion's default is "never", so without this the CSS blanket in
  // legacy.css would quietly cover only half the app — Motion animates inline
  // styles off the main thread, where a `transition-duration` override can't
  // reach it. "user" (rather than forcing it off) is also the right shape:
  // Motion keeps opacity and drops transform/layout, which is the "gentler,
  // not zero" behaviour this preference actually asks for.
  createRoot(document.getElementById("root")!).render(
    <MotionConfig reducedMotion="user">
      {transcriptMotionFixture ? (
        <TranscriptMotionLab
          initialSeed={transcriptMotionFixture.seed}
          speed={transcriptMotionFixture.speed}
          profile={transcriptMotionFixture.profile}
        />
      ) : previewWaitSessionId ? (
        <PreviewWait sessionId={previewWaitSessionId} />
      ) : (
        <TooltipProvider>
          <>
            <App />
            <AgentationFeedback />
          </>
        </TooltipProvider>
      )}
    </MotionConfig>,
  );
}
