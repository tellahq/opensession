import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PanelBrowserTarget } from "../lib/portal-pin";
import { PANEL_RESIZE } from "../lib/session-panel-classes";
import {
  isWideSidePanelPage,
  type SidePanelDock,
  type SidePanelPage,
  type SidePanelTab,
} from "../lib/side-panel-open";
import {
  closeSidePanelTab,
  finishSidePanelOpening,
  getSidePanelState,
  selectSidePanelPage,
  setSidePanelBrowser,
  setSidePanelOpen,
  sidePanelViewOf,
  subscribeSidePanel,
} from "../lib/side-panel-store";
import { suppressLayoutAnimations } from "../ui/motion";

/**
 * The right side panel's open state, tabs and width, shared by every surface
 * that shows one: the session viewer and the session-less workspace route.
 *
 * Open state, the selected tab and the Browser tab's page are each session's
 * own (`key`), kept in one module store (lib/side-panel-store) with the shared
 * tab strip, so a Review or Browser request from the app shell lands in
 * whichever panel is on screen, across browser tabs too.
 *
 * Width also remains in localStorage, once for the tool tabs and once for the
 * wide ones (Review, Browser), so opening a page beside the conversation makes
 * room for it and switching back to Changes gives that room back. The handle
 * drags from the panel's left edge, so its width is the pointer's distance
 * from the container's right side.
 */
const WIDTH_KEY = "opensession-panel-w";
const WIDE_WIDTH_KEY = "opensession-panel-w-wide";
/** A wide tab's share of the window until someone drags it. */
const WIDE_DEFAULT = "50%";
const MIN_W = 320;
const MAX_W = 2400;

interface SidePanelStyle extends React.CSSProperties {
  "--panel-w": string;
}

export interface SidePanel {
  open: boolean;
  setOpen: (open: boolean) => void;
  page: SidePanelPage;
  /** Select a page; a tab that is not in the strip yet is added. */
  setPage: (page: SidePanelPage) => void;
  tabs: SidePanelTab[];
  closeTab: (tab: SidePanelTab) => void;
  /** The page this session's Browser tab shows, if one is attached. */
  browser: PanelBrowserTarget | null;
  setBrowser: (target: PanelBrowserTarget | null) => void;
  dock: SidePanelDock;
  /** An action just opened the panel: slide it in (see PANEL_ENTER). */
  entering: boolean;
  /** `--panel-w` for PANEL_SHELL; undefined while no width is stored. */
  style: React.CSSProperties | undefined;
  /** The panel's left-edge drag handle — render it inside PANEL_SHELL. */
  resizeHandle: React.ReactNode;
}

function storedWidth(key: string): number {
  const stored = Number(localStorage.getItem(key));
  return stored >= MIN_W && stored <= MAX_W ? stored : 0;
}

/** How long the panel takes to slide in or change width: `--dur-lg`. */
const RESIZE_MS = 280;

export function useSidePanel(key: string): SidePanel {
  const current = useSyncExternalStore(subscribeSidePanel, getSidePanelState);
  const { open, page } = sidePanelViewOf(current, key);
  const { tabs, dock } = current;
  const entering = current.opening === key;
  useEffect(() => {
    if (!entering) return;
    const timer = window.setTimeout(
      () => finishSidePanelOpening(key),
      RESIZE_MS + 50,
    );
    return () => window.clearTimeout(timer);
  }, [entering, key]);
  const wide = isWideSidePanelPage(page);

  const [widths, setWidths] = useState(() => ({
    tool: storedWidth(WIDTH_KEY),
    wide: storedWidth(WIDE_WIDTH_KEY),
  }));
  const width = wide ? widths.wide : widths.tool;
  const widthRef = useRef(width);
  useLayoutEffect(() => {
    widthRef.current = width;
  });
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const right =
      e.currentTarget.parentElement?.getBoundingClientRect().right ??
      window.innerWidth;
    const which = wide ? "wide" : "tool";
    document.body.classList.add("resizing-panel");
    // Snap Motion layout morphs while dragging — the composer re-measures on
    // every step, so springing it reads as funky text (mirrors the sidebar).
    const restoreMotion = suppressLayoutAnimations();
    const onMove = (ev: MouseEvent) => {
      // Wide enough to review code side-by-side: only reserve room for the
      // left sidebar + a readable session column instead of a fixed cap.
      const max = Math.max(480, Math.round(window.innerWidth - 620));
      const next = Math.min(
        max,
        Math.max(MIN_W, Math.round(right - ev.clientX)),
      );
      widthRef.current = next;
      setWidths((prev) => ({ ...prev, [which]: next }));
    };
    const onUp = () => {
      document.body.classList.remove("resizing-panel");
      restoreMotion();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      localStorage.setItem(
        which === "wide" ? WIDE_WIDTH_KEY : WIDTH_KEY,
        String(Math.round(widthRef.current)),
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const style: SidePanelStyle | undefined = width
    ? { "--panel-w": `${width}px` }
    : wide
      ? { "--panel-w": WIDE_DEFAULT }
      : undefined;

  return {
    open,
    setOpen: (next) => setSidePanelOpen(key, next),
    page,
    setPage: (next) => selectSidePanelPage(key, next),
    tabs,
    closeTab: (tab) => closeSidePanelTab(key, tab),
    browser: current.browsers[key] ?? null,
    setBrowser: (target) => setSidePanelBrowser(key, target),
    dock,
    entering,
    style,
    resizeHandle: (
      <div
        className={PANEL_RESIZE}
        onMouseDown={startResize}
        aria-hidden="true"
      />
    ),
  };
}
