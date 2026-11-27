import React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconArrowUpToLine } from "./icons";
import { duration, ease } from "../ui/motion";

interface FullPageFileDropOverlayProps {
  active: boolean;
}

/** Full-page feedback for a file drag owned by the foreground composer. The
 * window-level owner handles the drop, so this stays visual and never blocks
 * a modal, menu, or any other part of the page. */
export function FullPageFileDropOverlay({
  active,
}: FullPageFileDropOverlayProps) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            className="pointer-events-none fixed inset-0 z-[12000] flex flex-col items-center justify-center bg-[color-mix(in_srgb,var(--bg-panel)_68%,transparent)] px-6 text-center [backdrop-filter:blur(8px)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "tween", duration: duration.base, ease }}
            aria-hidden="true"
            data-composer-file-drop-overlay
          >
            <IconArrowUpToLine size={40} className="text-fg" />
            <div className="mt-4 text-dialog-title font-title text-fg">
              Add files
            </div>
            <div className="mt-1 text-label text-dim">
              Drop anywhere to attach them to your message.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {active && (
        <span className="sr-only" role="status">
          Drop files anywhere to attach
        </span>
      )}
    </>,
    document.body,
  );
}
