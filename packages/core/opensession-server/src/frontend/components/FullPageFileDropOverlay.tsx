import React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import * as stylex from "@stylexjs/stylex";
import { IconArrowUpToLine } from "./icons";
import { duration, ease } from "../ui/motion";
import { blur, color, layer, space, text, weight } from "../ui/tokens.stylex";

const styles = stylex.create({
  wash: {
    pointerEvents: "none",
    position: "fixed",
    inset: space.s0,
    zIndex: layer.dropTarget,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.dropWash,
    backdropFilter: blur.dropWash,
    paddingInline: space.s24,
    textAlign: "center",
  },
  glyph: { color: color.fg },
  title: {
    marginTop: space.s16,
    fontSize: text.dialogTitle,
    fontWeight: weight.title,
    color: color.fg,
  },
  detail: { marginTop: space.s4, fontSize: text.label, color: color.dim },
});

interface FullPageFileDropOverlayProps {
  active: boolean;
}

/** The one feedback for a file dragged over the app: the whole page washes
 * out under "Add files". Whichever composer owns the drop (a session, a
 * workspace, a new session, the Desk) renders this; the window-level owner
 * handles the drop itself, so this stays visual and never blocks a modal, a
 * menu, or any other part of the page. */
export function FullPageFileDropOverlay({
  active,
}: FullPageFileDropOverlayProps) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            {...stylex.props(styles.wash)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "tween", duration: duration.base, ease }}
            aria-hidden="true"
            data-composer-file-drop-overlay
          >
            <IconArrowUpToLine size={40} {...stylex.props(styles.glyph)} />
            <div {...stylex.props(styles.title)}>Add files</div>
            <div {...stylex.props(styles.detail)}>
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
