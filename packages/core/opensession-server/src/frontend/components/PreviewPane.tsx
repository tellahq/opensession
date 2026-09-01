import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useRef, useState } from "react";
import type { PreviewStatus } from "../lib/api";
import { startPreviewApi, stopPreviewApi } from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { Button } from "../ui/button";
import { PageLoader } from "../ui/page-loader";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  hFull: {
    height: "100%",
  },
  minH0: {
    minHeight: "0",
  },
  flexCol: {
    flexDirection: "column",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  hoverBgRedSoft: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--red-soft)",
      },
    },
  },
  hoverTextRed: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--red)",
      },
    },
  },
  block: {
    display: "block",
  },
  wFull: {
    width: "100%",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgWhite: {
    backgroundColor: "var(--color-white)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  textCenter: {
    textAlign: "center",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  maxWSm: {
    maxWidth: "var(--container-sm)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
});

/**
 * Full-width Preview view-tab (a sibling of Review/Preview environment/Assets): the
 * session's dev server embedded in an iframe, with a toolbar to break out to
 * a real browser window, reload, or stop the preview. The app's CSP already
 * allowlists framing from the app's own origin (frame-ancestors).
 *
 * Status comes from the parent (SessionViewer polls it for the header button
 * anyway); this pane starts the preview when opened while nothing runs, shows
 * the starting state, and swaps to the iframe once the URL is live. In the
 * Mac shell the break-out lands in the system browser (the Electron window-
 * open handler externalizes non-app origins).
 */
export function PreviewPane({
  session,
  status,
  onClose,
}: {
  session: UnifiedSession;
  status: PreviewStatus | null;
  onClose: () => void;
}) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [stopping, setStopping] = useState(false);
  const kickedRef = useRef(false);

  const url =
    status?.running && status.previewUrl
      ? withPreviewPath(status.previewUrl, session.previewPath)
      : null;

  // Opening the tab IS the start intent: kick the claim once when nothing is
  // running or starting yet (pool claims serve in seconds).
  useEffect(() => {
    if (kickedRef.current || !status) return;
    if (!status.running && !status.starting && status.bootable !== false) {
      kickedRef.current = true;
      startPreviewApi(session.id).catch(() => {});
    }
  }, [status, session.id]);
  useEffect(() => {
    kickedRef.current = false;
  }, [session.id]);

  async function stop() {
    setStopping(true);
    await (async () => {
      await stopPreviewApi(session.id);
      onClose();
    })().finally(async () => {
      setStopping(false);
    });
  }

  return (
    <div {...stylex.props(sx.flex, sx.hFull, sx.minH0, sx.flexCol)}>
      <div
        {...stylex.props(
          sx.flex,
          sx.itemsCenter,
          sx.gap2,
          sx.borderB,
          sx.borderDivider,
          sx.bgPanel,
          sx.px3,
          sx.py15,
        )}
      >
        <span
          className={utilityClassName(
            `h-2 w-2 shrink-0 rounded-full ${url ? "bg-green-500" : "animate-pulse bg-amber-400"}`,
          )}
          aria-hidden="true"
        />
        <div
          {...stylex.props(
            sx.minW0,
            sx.flex1,
            sx.truncate,
            sx.fontMedium,
            sx.textDim,
            typography.supporting,
          )}
        >
          {url ??
            (status?.starting || !status
              ? "Starting the dev server…"
              : "Preview stopped")}
        </div>
        <Button
          size="sm"
          variant="soft"
          disabled={!url}
          onClick={() => setReloadNonce((n) => n + 1)}
        >
          Reload
        </Button>
        <Button
          size="sm"
          variant="soft"
          disabled={!url}
          onClick={() =>
            url && window.open(url, `preview-${session.id}`, "noopener")
          }
          title="Open in a separate browser window"
        >
          Open in browser
        </Button>
        <Button
          size="sm"
          variant="soft"
          className={mergeStylexOverrideClassName(
            "",
            sx.hoverBgRedSoft,
            sx.hoverTextRed,
          )}
          disabled={stopping || (!status?.running && !status?.starting)}
          onClick={stop}
          title="Stop the dev server and release its container"
        >
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      </div>
      {url ? (
        <iframe
          key={`${url}#${reloadNonce}`}
          {...stylex.props(
            sx.block,
            sx.minH0,
            sx.wFull,
            sx.flex1,
            sx.border0,
            sx.bgWhite,
          )}
          src={url}
          title={`Preview · ${session.title || session.id}`}
          allow="clipboard-read; clipboard-write; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"
        />
      ) : (
        <div
          {...stylex.props(
            sx.flex,
            sx.flex1,
            sx.flexCol,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.gap3,
            sx.textCenter,
          )}
        >
          <PageLoader
            className={mergeStylexOverrideClassName("", sx.textDim)}
          />
          <div
            {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}
          >
            {status?.starting || !status
              ? "Starting the dev server…"
              : "Preview is not running"}
          </div>
          <div
            {...stylex.props(
              sx.maxWSm,
              sx.fontMedium,
              sx.leadingRelaxed,
              sx.textDim,
              typography.supporting,
            )}
          >
            {status?.starting || !status
              ? "Warm claims serve in seconds; a big branch jump can take a minute to compile."
              : "It may have been stopped or released. Close and reopen this tab to start it again."}
          </div>
        </div>
      )}
    </div>
  );
}
