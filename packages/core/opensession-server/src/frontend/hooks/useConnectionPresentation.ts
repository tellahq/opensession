import { useEffect, useState } from "react";

import { CONNECTION_PRESENTATION_GRACE_MS } from "../lib/connection-presentation";

/** Delay only the visible disconnected state. Recovery is reflected immediately. */
export function useConnectionPresentation(connected: boolean): boolean {
  const [showDisconnected, setShowDisconnected] = useState(false);

  useEffect(() => {
    if (connected) {
      setShowDisconnected(false);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") {
        setShowDisconnected(false);
        return;
      }
      timer = setTimeout(
        () => setShowDisconnected(true),
        CONNECTION_PRESENTATION_GRACE_MS,
      );
    };

    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [connected]);

  return connected || !showDisconnected;
}
