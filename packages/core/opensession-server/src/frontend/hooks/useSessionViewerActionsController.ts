import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GitStatusInfo } from "../lib/types";
import {
  isSlackShareDismissed,
  onSlackShareDismissChanged,
  slackShareDismissKey,
} from "../lib/slack-share-dismiss";
import { fetchGitStatus } from "../lib/api";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
import { PHONE_QUERY } from "../lib/breakpoints";
import { matchesShortcut } from "../lib/shortcuts";

interface ShippedShareIdentity {
  sessionId: string;
  mergedPrNumber?: number;
}

export function useShippedShareState(identity: ShippedShareIdentity) {
  // Closing the card is a decision about this PR, not a fold, so it sticks
  // across reloads and devices (lib/slack-share-dismiss). The next merged PR
  // in the same session gets its own card, and "Send to Slack…" in the
  // composer menu still opens a composer, so closing loses nothing.
  const dismissKey = identity.mergedPrNumber
    ? slackShareDismissKey(identity.sessionId, identity.mergedPrNumber)
    : "";
  const [dismissed, setDismissed] = useState(() =>
    isSlackShareDismissed(dismissKey),
  );
  useEffect(() => {
    const sync = () => setDismissed(isSlackShareDismissed(dismissKey));
    sync();
    return onSlackShareDismissChanged(sync);
  }, [dismissKey]);

  return { dismissKey, dismissed };
}

interface HeaderLayoutIdentity {
  topbarEl?: HTMLElement | null;
  workspaceSummaryOpen: () => boolean;
}

export function useSessionHeaderLayout(identity: HeaderLayoutIdentity) {
  // Responsive header: when the top bar gets narrow (small window, sidebar +
  // workspace panel both open), the title truncates first (CSS), then the
  // Share button collapses into the ⋯ menu so it never overlaps the title.
  // (Pin stays inline beside Preview on desktop; Spin off lives in the ⋯ menu.) Measured on the
  // header element itself so it tracks the real available width regardless
  // of the surrounding chrome.
  const headerRef = useRef<HTMLDivElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const [reviewSessionActionTarget, setReviewSessionActionTarget] =
    useState<HTMLDivElement | null>(null);
  const desktopChangesRef = useRef<HTMLDivElement>(null);
  const [headerW, setHeaderW] = useState(0);
  // Whether the header's workspace-summary card is up. The transcript and
  // composer shift out from under it while it is, and the header's own PR
  // strip and preview globe stand down, so this lives here rather than inside
  // the card. Seeded from the stored preference rather than starting shut: the
  // card reports itself an effect later, and a frame of the strip it replaces
  // is the thing this is here to prevent.
  const [summaryOpen, setSummaryOpen] = useState(identity.workspaceSummaryOpen);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    // Once by hand, before the first paint: the observer's own opening callback
    // lands after it, and this width decides whether the summary card has room
    // to stand open. A frame late is a frame of a card lying across a narrow
    // transcript. Content box, to match what the observer reports below.
    const box = getComputedStyle(el);
    setHeaderW(
      el.clientWidth -
        parseFloat(box.paddingLeft) -
        parseFloat(box.paddingRight),
    );
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setHeaderW(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [identity.topbarEl]);
  // Collapse before the inline row can overrun: the title's non-shrinkable
  // floor (source chip + Working pill) plus the inline actions (facepile,
  // links, Share) needs ~740px, so below that Share moves into the ⋯ menu.
  const compactHeader = headerW > 0 && headerW < 740;
  // Phone layout (same 720px breakpoint as the CSS page-stack): the header
  // actions portal into the top bar next to the centered title, and every
  // secondary action folds into the ⋯ menu so the bar holds just ⋯ + Workspace.
  const [isPhone, setIsPhone] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const onChange = () => setIsPhone(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return {
    elements: {
      headerRef,
      headerActionsRef,
      reviewSessionActionTarget,
      setReviewSessionActionTarget,
      desktopChangesRef,
    },
    width: { headerW, compactHeader },
    summary: { summaryOpen, setSummaryOpen },
    viewport: { isPhone },
  };
}

interface OverflowIdentity {
  sessionId: string;
  repo?: string;
  branch?: string | null;
  hasRepoWork: boolean;
  primaryPrNumber?: number;
}

export function useSessionOverflowState(identity: OverflowIdentity) {
  const [overflowGit, setOverflowGit] = useState<{
    sessionId: string;
    status: GitStatusInfo | null;
  } | null>(null);
  const [branchActionBusy, setBranchActionBusy] = useState<
    "move" | "create" | null
  >(null);
  const [branchConfirmOpen, setBranchConfirmOpen] = useState(false);
  const [branchConfirmMode, setBranchConfirmMode] = useState<"move" | "create">(
    "move",
  );
  const [mobileActionMenuEl, setMobileActionMenuEl] =
    useState<HTMLDivElement | null>(null);
  // PR actions are tucked into the overflow menu. Fetch once when the session
  // branch changes so the menu does not open first and add its actions later.
  useEffect(() => {
    if (!identity.hasRepoWork || identity.primaryPrNumber) return;
    let stale = false;
    fetchGitStatus(identity.sessionId, identity.repo)
      .then((status) => {
        if (!stale) setOverflowGit({ sessionId: identity.sessionId, status });
      })
      .catch(() => {
        if (!stale)
          setOverflowGit({ sessionId: identity.sessionId, status: null });
      });
    return () => {
      stale = true;
    };
  }, [
    identity.hasRepoWork,
    identity.primaryPrNumber,
    identity.sessionId,
    identity.repo,
    identity.branch,
  ]);
  useEffect(() => {
    setOverflowGit(null);
    setBranchActionBusy(null);
    setBranchConfirmOpen(false);
    setBranchConfirmMode("move");
  }, [identity.sessionId]);

  return {
    menu: { mobileActionMenuEl, setMobileActionMenuEl },
    git: { overflowGit },
    branch: {
      branchActionBusy,
      setBranchActionBusy,
      branchConfirmOpen,
      setBranchConfirmOpen,
      branchConfirmMode,
      setBranchConfirmMode,
    },
  };
}

interface ArchiveShortcutIdentity {
  focused: boolean;
  archiving: boolean;
  archived?: boolean;
}

interface ArchiveShortcutActions {
  archive: () => Promise<void>;
  openNextChat?: () => void;
}

export function useSessionArchiveShortcut({
  identity: { focused, archiving, archived },
  actions: { archive, openNextChat },
}: {
  identity: ArchiveShortcutIdentity;
  actions: ArchiveShortcutActions;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!focused) return;
      if (event.defaultPrevented || blockingOverlayOpen()) return;
      // Same composer exemption as the sidebar's archive chords: the
      // composer autofocuses, so an unconditional editable-focus bail
      // would leave ⌘E dead almost always. Other inputs keep the guard.
      const target = event.target;
      const editable =
        target instanceof Element
          ? target.closest(
              "input, textarea, select, [contenteditable='true'], [contenteditable='']",
            )
          : null;
      if (editable && !editable.classList.contains("composer-textarea")) return;
      if (matchesShortcut(event, "workspace-next-unread") && openNextChat) {
        event.preventDefault();
        openNextChat();
        return;
      }
      // The sidebar handles live sessions when it can, because it knows which
      // visible row comes next. Keep this listener as the route-level fallback:
      // the viewer remains mounted even when the sidebar cannot handle the open
      // session. `defaultPrevented` above ensures only one handler fires.
      if (matchesShortcut(event, "session-archive") && !archiving) {
        event.preventDefault();
        void archive();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focused, archiving, archive, openNextChat, archived]);
}
