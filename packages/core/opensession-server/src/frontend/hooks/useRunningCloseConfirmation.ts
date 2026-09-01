import { useEffect, useState } from "react";
import type { UnifiedSession } from "../lib/types";

export function useRunningCloseConfirmation() {
  const [runningCloseConfirmation, setRunningCloseConfirmation] = useState<{
    runningCount: number;
    onConfirm: () => void;
  } | null>(null);
  useEffect(() => {
    if (!runningCloseConfirmation) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      const confirmation = runningCloseConfirmation;
      setRunningCloseConfirmation(null);
      confirmation.onConfirm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runningCloseConfirmation]);

  const confirmRunningCloses = (
    sessionsToClose: UnifiedSession[],
    onConfirm: () => void,
  ) => {
    const runningCount = sessionsToClose.filter(
      (session) => session.isRunning,
    ).length;
    if (!runningCount) {
      onConfirm();
      return;
    }
    setRunningCloseConfirmation({ runningCount, onConfirm });
  };
  const confirmRunningClose = (
    session: UnifiedSession,
    onConfirm: () => void,
  ) => confirmRunningCloses([session], onConfirm);
  const onCancel = () => setRunningCloseConfirmation(null);
  const onConfirm = () => {
    const confirmation = runningCloseConfirmation;
    setRunningCloseConfirmation(null);
    confirmation?.onConfirm();
  };

  return {
    confirmRunningClose,
    confirmRunningCloses,
    dialog: {
      runningCount: runningCloseConfirmation?.runningCount ?? null,
      onCancel,
      onConfirm,
    },
  };
}
