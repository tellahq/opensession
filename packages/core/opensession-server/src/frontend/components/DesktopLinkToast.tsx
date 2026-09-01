import { utilityClassName } from "../ui/cn";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconShare, IconX } from "./icons";
import { desktopProtocolUrlFromBrowser } from "../lib/desktop-link";
import { PERSISTENT_NOTICE_CARD } from "../lib/notification-classes";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { Tooltip } from "../ui/tooltip";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  size6: {
    width: "calc(4px * 6)",
    height: "calc(4px * 6)",
  },
  shrink0: {
    flexShrink: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  leading13: {
    lineHeight: "1.3",
  },
  textFg: {
    color: "var(--text)",
  },
  gap1: {
    gap: "4px",
  },
});

export function DesktopLinkToast() {
  const [dismissed, setDismissed] = useState(false);
  const url = desktopProtocolUrlFromBrowser();
  if (!url) return null;

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          className={cn(
            PERSISTENT_NOTICE_CARD,
            utilityClassName("animate-none"),
          )}
          role="region"
          aria-label="View in the app"
          initial={{ opacity: 0, x: -12 }}
          animate={{
            opacity: 1,
            x: 0,
            transition: {
              type: "spring",
              duration: duration.large,
              bounce: 0,
            },
          }}
          exit={{
            opacity: 0,
            x: 0,
            y: 6,
            transition: { type: "tween", duration: 0.1, ease },
          }}
        >
          <div
            {...stylex.props(
              sx.flex,
              sx.minW0,
              sx.flex1,
              sx.itemsCenter,
              sx.gap2,
            )}
          >
            <img
              {...stylex.props(sx.size6, sx.shrink0)}
              src="/mac-app-icon.png"
              alt=""
            />
            <span
              {...stylex.props(
                sx.minW0,
                sx.flex1,
                sx.truncate,
                sx.fontMedium,
                sx.leading13,
                sx.textFg,
                typography.supporting,
              )}
            >
              View in the app
            </span>
          </div>
          <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap1)}>
            <Button
              variant="primary"
              size="sm"
              icon={<IconShare size={18} />}
              onClick={() => {
                // A user-initiated hidden navigation can open a custom protocol while
                // keeping this web page available when no desktop app handles it.
                const frame = document.createElement("iframe");
                frame.hidden = true;
                frame.setAttribute("aria-hidden", "true");
                frame.src = url;
                document.body.appendChild(frame);
                setTimeout(() => frame.remove(), 1_500);
                setDismissed(true);
              }}
            >
              Open
            </Button>
            <Tooltip label="Dismiss" side="top">
              <Button
                variant="ghost"
                size="sm"
                icon={<IconX size={16} />}
                aria-label="Dismiss"
                onClick={() => setDismissed(true)}
              />
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
