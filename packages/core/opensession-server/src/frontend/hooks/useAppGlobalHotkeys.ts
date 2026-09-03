import type { RefObject } from "react";
import { useEffect, useEffectEvent, useRef } from "react";
import type { CommandMenuHandle } from "../components/CommandMenuHost";
import { absoluteLink, copyToClipboard } from "../lib/share-link";
import { matchesShortcut } from "../lib/shortcuts";

interface UseAppGlobalHotkeysOptions {
  commandMenuRef: RefObject<CommandMenuHandle | null>;
  paletteOpenRef: RefObject<boolean>;
  openPalette: () => void;
  closePalette: () => void;
  toggleSidebarCollapsed: () => void;
  showToast: (message: string) => void;
  setDeskOverlay: React.Dispatch<
    React.SetStateAction<{ open: boolean; origin: "center" | "bottom-right" }>
  >;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useAppGlobalHotkeys({
  commandMenuRef,
  paletteOpenRef,
  openPalette,
  closePalette,
  toggleSidebarCollapsed,
  showToast,
  setDeskOverlay,
  setShortcutsOpen,
}: UseAppGlobalHotkeysOptions) {
  // The link ⌘⇧C copies: the open session/workspace, or the open PR preview.
  // Assigned during render (below, once currentSession is known); null when
  // the current view has nothing linkable.
  const copyLinkPathRef = useRef<string | null>(null);

  // ⌘K toggles the command palette; ⌘S starts a session in a new workspace;
  // ⌘⇧C copies a link to the open session/PR.
  // Esc closes whichever palette is open (search's
  // own input also handles Esc, but this covers the case where focus has left
  // it).
  // The three component handlers are read through effect events, so the
  // listener subscribes once and still reaches the latest closures.
  const hotkeyOpenPalette = useEffectEvent(() => openPalette());
  const hotkeyClosePalette = useEffectEvent(() => closePalette());
  const hotkeyToggleSidebar = useEffectEvent(() => toggleSidebarCollapsed());
  const hotkeyToast = useEffectEvent((message: string) => showToast(message));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, "command-menu")) {
        e.preventDefault();
        commandMenuRef.current?.toggle();
        return;
      }
      if (matchesShortcut(e, "desk")) {
        // Summon/dismiss the Desk overlay. A keyboard summon grows from
        // the center because there is no spatial trigger to connect it to.
        e.preventDefault();
        setDeskOverlay((desk) =>
          desk.open
            ? { ...desk, open: false }
            : { open: true, origin: "center" },
        );
        return;
      }
      if (matchesShortcut(e, "shortcuts-help")) {
        // The one chord whose job is to say what the other chords are, so
        // it opens over whatever is on screen and closes the same way.
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (matchesShortcut(e, "sidebar-toggle")) {
        // Toggle the desktop left sidebar. ⌘B is the panel-toggle
        // convention (VS Code / Slack).
        e.preventDefault();
        hotkeyToggleSidebar();
        return;
      }
      if (matchesShortcut(e, "session-new")) {
        // Start a session in a new workspace — the sidebar "+", by
        // keyboard. ⌘⌥N is the neighbouring chord and deliberately does
        // something else: it opens a sibling session in the workspace you
        // are already in. ⌘S is free to take because there is no document
        // here to save, so the browser's Save does nothing worth keeping.
        e.preventDefault();
        hotkeyOpenPalette();
        return;
      }
      if (matchesShortcut(e, "session-copy-link")) {
        // Let a real text selection copy normally; only hijack the chord
        // when there's a linkable view and nothing is selected. This is
        // why matchesShortcut doesn't preventDefault for us.
        if (window.getSelection?.()?.toString()) return;
        const path = copyLinkPathRef.current;
        if (!path) return;
        e.preventDefault();
        copyToClipboard(absoluteLink(path), () => hotkeyToast("Link copied"));
        return;
      }
      if (e.key === "Escape") {
        if (commandMenuRef.current?.isOpen()) commandMenuRef.current.close();
        else if (paletteOpenRef.current) hotkeyClosePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpenRef, commandMenuRef, setDeskOverlay, setShortcutsOpen]);

  return copyLinkPathRef;
}
