import React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconArrowUpToLine } from "./icons";
import { duration, ease } from "../ui/motion";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import {
  mergeStylexProps,
  mergeStylexClassName,
  mergeStylexOverrideClassName,
} from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  pointerEventsNone: {
    pointerEvents: "none",
  },
  fixed: {
    position: "fixed",
  },
  inset0: {
    inset: "0",
  },
  z12000: {
    zIndex: "12000",
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  px6: {
    paddingInline: "24px",
  },
  textCenter: {
    textAlign: "center",
  },
  textFg: {
    color: "var(--text)",
  },
  mt4: {
    marginTop: "16px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  mt1: {
    marginTop: "4px",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  srOnly: {
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    position: "absolute",
    overflow: "hidden",
  },

  bgColorMixInSrgbVarBgPanel68Transparent: {
    backgroundColor: "var(--bg-panel)",
    "@supports (color: color-mix(in lab, red, red))": {
      backgroundColor: "color-mix(in srgb,var(--bg-panel) 68%,transparent)",
    },
  },
  BackdropFilterBlur8px: {
    WebkitBackdropFilter: "blur(8px)",
    backdropFilter: "blur(8px)",
  },
});

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
            {...mergeStylexProps(
              "",
              sx.bgColorMixInSrgbVarBgPanel68Transparent,
              sx.BackdropFilterBlur8px,
              sx.pointerEventsNone,
              sx.fixed,
              sx.inset0,
              sx.z12000,
              sx.flex,
              sx.flexCol,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.px6,
              sx.textCenter,
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "tween", duration: duration.base, ease }}
            aria-hidden="true"
            data-composer-file-drop-overlay
          >
            <IconArrowUpToLine
              size={40}
              className={mergeStylexOverrideClassName("", sx.textFg)}
            />
            <div
              {...mergeStylexProps(
                "text-title",
                sx.mt4,
                sx.fontSemibold,
                sx.textFg,
              )}
            >
              Add files
            </div>
            <div {...stylex.props(sx.mt1, sx.textDim, typography.label)}>
              Drop anywhere to attach them to your message.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {active && (
        <span {...stylex.props(sx.srOnly)} role="status">
          Drop files anywhere to attach
        </span>
      )}
    </>,
    document.body,
  );
}
