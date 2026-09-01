import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  sidebarStartsCollapsed,
  storeSidebarCollapsed,
} from "../lib/sidebar-collapse";
import { openWorkspaceSummary } from "../lib/workspace-summary-open";
import { suppressLayoutAnimations } from "../ui/motion";
import { useScrollEdge } from "./useScrollEdge";

export function useAppShell() {
  // On phones the layout is an iOS-style page stack: the sidebar is the root
  // page and any non-home route is a page pushed over it. `mobileDetail` drives
  // that (see the `.mobile-detail` CSS and the back button below). It's inert on
  // desktop, where the sidebar + detail are a static split.
  const detailPaneRef = useRef<HTMLElement | null>(null);
  const [detailPaneEl, setDetailPaneEl] = useState<HTMLElement | null>(null);
  const captureDetailPane = useCallback((node: HTMLElement | null) => {
    detailPaneRef.current = node;
    setDetailPaneEl(node);
  }, []);

  // Desktop-only: collapse the left sidebar entirely (persisted per browser). A
  // new browser starts collapsed so the workspace summary and conversation lead;
  // opening it once remains an explicit preference. On mobile the page-stack
  // (mobileDetail) governs the sidebar instead; this hides the static desktop
  // column and swaps in a floating re-open control.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    sidebarStartsCollapsed,
  );
  function toggleSidebarCollapsed() {
    // The sidebar changes the tab strip's available width in one frame. Reorder
    // items otherwise treat that shell resize as a layout move and glide every
    // tab sideways, even though no tab was reordered.
    const restoreMotion = suppressLayoutAnimations();
    setSidebarCollapsed((v) => {
      const next = !v;
      storeSidebarCollapsed(next);
      if (next) openWorkspaceSummary();
      return next;
    });
    restoreMotion();
  }

  // The top bar above the tab strip. The session viewer portals its header
  // (session name + actions, incl. the workspace-panel toggle) into this slot so
  // the layout reads name-on-top / tabs-below; other views render a plain title.
  const [topbarEl, setTopbarEl] = useState<HTMLElement | null>(null);
  // Trailing slot of that same bar, for a page whose controls belong in the
  // window's chrome rather than in a strip above its own list. Pull requests
  // portals its search, filters and CTA here, so the bar holds the page's
  // controls at rest and its name once the heading has scrolled under it.
  const [topbarActionsEl, setTopbarActionsEl] = useState<HTMLElement | null>(
    null,
  );
  // The phone's own top bar, held for the same reason the pane's is: its title
  // pill waits for the page's heading to scroll under it, and where that edge
  // falls is this row's own bottom, which on the routes whose header floats
  // over the content is not where the pane starts.
  const [appHeaderEl, setAppHeaderEl] = useState<HTMLElement | null>(null);
  // Only the pane's bar answers a scroller now. The sidebar's chrome strip used
  // to as well, but nothing passes beneath it any more: the organization row and
  // the tools are fixed chrome under it and only the workspace list scrolls, so
  // there is no edge for a hairline to mark and no state to track.
  // Either scroller can be the one under the bar: a session's transcript, or
  // a page's own list. Only one of the two is ever in the pane, and the bar
  // no longer carries a line of its own, so a page that failed to answer here
  // would leave content vanishing at an unmarked edge.
  useScrollEdge(
    topbarEl,
    ".viewer-messages, [data-page-scroll], [data-review-canvas]",
  );

  // Centered under the mobile top-bar title: the composer's model pill is hidden
  // on phones, so the session viewer portals a compact tap-to-switch model
  // selector into this slot — the only place a session's model surfaces there.
  const [headerModelEl, setHeaderModelEl] = useState<HTMLElement | null>(null);
  // Leading slot of the mobile title pill: the session viewer portals the repo
  // tile here so it sits in front of the name (Slack-header style).
  const [headerRepoEl, setHeaderRepoEl] = useState<HTMLElement | null>(null);
  // Right slot of the mobile top bar. On phones the session viewer portals its
  // header actions here (single iOS-style nav bar); desktop hides the bar and
  // the actions render in the topbar slot above instead.
  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLDivElement | null>(
    null,
  );

  // Right-column slot (sibling of the left sidebar). The session viewer portals
  // its workspace/sub-agent panel here so it opens as a full-height column from
  // the very top, at the same level as the left sidebar (Conductor-style).
  const [rightPanelEl, setRightPanelEl] = useState<HTMLDivElement | null>(null);

  // Desktop sidebar width (px), drag-resizable and persisted per browser. The
  // mobile drawer keeps its own fixed width (CSS media query wins there), so
  // this only takes effect on the static desktop column.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("opensession-sidebar-w"));
    return v >= 200 && v <= 480 ? v : 280;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  useLayoutEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  });
  // The column the width lands on, so a drag can write it without a render.
  const sidebarColRef = useRef<HTMLDivElement>(null);
  function startSidebarResize(e: ReactMouseEvent) {
    e.preventDefault();
    document.body.classList.add("resizing-sidebar");
    // Snap Motion layout morphs while dragging — the composer + sidebar rows
    // re-measure on every step, so springing them reads as funky text.
    const restoreMotion = suppressLayoutAnimations();
    // Only the column reads the width mid-drag, and it reads it as a custom
    // property. Routing every pointer event through state instead re-ran the
    // whole shell (list filter + sort, command actions, every pane prop) at
    // pointer rate; the state catches up once, on drop.
    let width = sidebarWidthRef.current;
    let frame = 0;
    const paint = () => {
      frame = 0;
      sidebarColRef.current?.style.setProperty("--sidebar-w", `${width}px`);
    };
    const onMove = (ev: MouseEvent) => {
      // The sidebar is the leftmost element, so the pointer's x is its width.
      width = Math.min(480, Math.max(200, ev.clientX));
      sidebarWidthRef.current = width;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onUp = () => {
      document.body.classList.remove("resizing-sidebar");
      restoreMotion();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame) cancelAnimationFrame(frame);
      setSidebarWidth(width);
      localStorage.setItem("opensession-sidebar-w", String(Math.round(width)));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return {
    pane: { detailPaneRef, detailPaneEl, captureDetailPane },
    sidebar: {
      sidebarCollapsed,
      toggleSidebarCollapsed,
      sidebarWidth,
      sidebarColRef,
      startSidebarResize,
    },
    desktopTopbar: {
      topbarEl,
      setTopbarEl,
      topbarActionsEl,
      setTopbarActionsEl,
    },
    mobileTopbar: {
      appHeaderEl,
      setAppHeaderEl,
      headerModelEl,
      setHeaderModelEl,
      headerRepoEl,
      setHeaderRepoEl,
      headerActionsEl,
      setHeaderActionsEl,
    },
    rightPanel: { rightPanelEl, setRightPanelEl },
  };
}
