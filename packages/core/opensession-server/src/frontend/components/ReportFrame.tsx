import React, { useEffect, useState } from "react";
import { reportRawUrl } from "../lib/api";
import {
  parseNewSessionLink,
  type NewSessionPrefill,
} from "../lib/new-session-link";
import {
  effectiveTheme,
  onThemeChanged,
  type EffectiveTheme,
} from "../lib/theme";
import { cn } from "../ui/cn";

/**
 * A published report, rendered as the document it is.
 *
 * Two things are worth knowing before changing this. The frame is sandboxed
 * without scripts, so the report can neither adapt itself nor open a link on
 * its own: the theme is asked for in the URL and resolved server-side
 * (src/server/report-theme.ts), and every anchor is given its target here,
 * after load. And both places that show a report — the Reports page and a
 * session's Reports tab — go through this one component, because the last time
 * they each kept their own copy of that link handling the two drifted.
 */

/** A support link inside a report opens the ticket here, not in a new tab. */
function supportIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return null;
    const match = url.pathname.match(
      /^\/(?:opensession\/|backstage\/)?support\/([^/?#]+)/,
    );
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function ReportFrame({
  automationId,
  reportId,
  title,
  onOpenNewSession,
  onOpenSupport,
  className,
}: {
  automationId: string;
  reportId: string;
  title: string;
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
  /** Absent where there is nowhere to put a ticket, e.g. the session tab. */
  onOpenSupport?: (threadId: string) => void;
  className?: string;
}) {
  const [theme, setTheme] = useState<EffectiveTheme>(() => effectiveTheme());
  // Covers the OS flipping under "system" too: theme.ts re-broadcasts that.
  useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);

  return (
    <iframe
      // The document is re-fetched for the new scheme rather than patched
      // in place, so a theme switch reloads the frame by identity.
      key={`${automationId}/${reportId}/${theme}`}
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      src={reportRawUrl(automationId, reportId, theme)}
      onLoad={(event) => {
        const doc = event.currentTarget.contentDocument;
        if (!doc) return;
        for (const link of doc.querySelectorAll("a")) {
          if (parseNewSessionLink(link.href)) {
            link.removeAttribute("target");
            continue;
          }
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          if (onOpenSupport && supportIdFromHref(link.href))
            link.removeAttribute("target");
        }
        doc.addEventListener("click", (clickEvent) => {
          const target = clickEvent.target;
          const ElementOwner = doc.defaultView?.Element;
          const link =
            ElementOwner && target instanceof ElementOwner
              ? target.closest("a")
              : null;
          const prefill = link ? parseNewSessionLink(link.href) : null;
          if (prefill) {
            clickEvent.preventDefault();
            onOpenNewSession(prefill);
            return;
          }
          const supportId = onOpenSupport && supportIdFromHref(link?.href);
          if (!supportId) return;
          clickEvent.preventDefault();
          onOpenSupport(supportId);
        });
      }}
      // Only ever seen for the moment before the document paints, so it
      // takes the app's page colour rather than a report's paper white.
      className={cn("min-h-0 flex-1 border-0 bg-bg", className)}
    />
  );
}
