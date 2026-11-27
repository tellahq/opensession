import React from "react";
import type { SetupController } from "../hooks/useSetupStatus";
import { Button } from "../ui/button";
import { LoadingState } from "../ui/state";
import { Code } from "./setup-shared";

// The "changes saved — restart to apply" banner, and the veil it puts over the
// page while the server is down. Any page that can save a credential or an
// enable flag renders one, so the offer to apply the change is always where
// the change was made. The parent must be `relative` — the veil is absolute.

export function SetupRestart({ setup }: { setup: SetupController }) {
  // First-run setup applies live-readable settings as it progresses. Do not
  // interrupt /welcome with a restart prompt between steps.
  if (
    typeof window !== "undefined" &&
    /\/welcome\/?$/.test(window.location.pathname)
  ) {
    return null;
  }
  const { restartNeeded, restartState, restartServer } = setup;
  return (
    <>
      {restartNeeded && restartState !== "working" && (
        <div className="sticky bottom-3 z-float mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-panel px-4 py-3 smooth-shadow-soft">
          <div className="min-w-0 flex-1">
            <div className="text-control-label font-medium text-fg">
              Changes saved. Restart to apply.
            </div>
            <div className="mt-0.5 text-supporting text-dim">
              {restartState === "failed" ? (
                <>
                  Still not back. Check <Code>opensession logs</Code>.
                </>
              ) : (
                "The server reads credentials and enable flags on boot. Restarts take a few seconds; running engine turns keep going."
              )}
            </div>
          </div>
          {restartState === "failed" ? (
            <Button onClick={() => restartServer(false)}>Check again</Button>
          ) : (
            <Button variant="primary" onClick={() => restartServer()}>
              Restart server
            </Button>
          )}
        </div>
      )}
      {restartState === "working" && (
        <div className="absolute inset-0 z-shell-overlay rounded-lg bg-bg/75 backdrop-blur-[2px]">
          <div className="sticky top-[30vh] pb-8">
            <LoadingState>Restarting…</LoadingState>
          </div>
        </div>
      )}
    </>
  );
}
