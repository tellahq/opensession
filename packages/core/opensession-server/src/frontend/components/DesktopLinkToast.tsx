import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconShare, IconX } from "./icons";
import { desktopProtocolUrlFromBrowser } from "../lib/desktop-link";
import { PERSISTENT_NOTICE_CARD } from "../lib/notification-classes";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { Tooltip } from "../ui/tooltip";

export function DesktopLinkToast() {
  const [dismissed, setDismissed] = useState(false);
  const url = desktopProtocolUrlFromBrowser();
  if (!url) return null;

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          className={cn(PERSISTENT_NOTICE_CARD, "animate-none")}
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
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <img className="size-6 shrink-0" src="/mac-app-icon.png" alt="" />
            <span className="min-w-0 flex-1 truncate text-supporting font-medium leading-[1.3] text-fg">
              View in the app
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="primary"
              size="sm"
              icon={<IconShare size={20} />}
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
                icon={<IconX size={20} />}
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
