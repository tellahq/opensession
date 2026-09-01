import type { Dispatch, SetStateAction } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { SidebarHandle } from "../components/Sidebar";
import { getCurrentUser } from "../components/UserPicker";
import { isSettingsRoute, type Route } from "../lib/app-route";
import { closestHTMLElement, eventTargetElement } from "../lib/event-target";
import { trackKeyboardInset } from "../lib/keyboard-inset";
import { initAlerts } from "../lib/notify";
import { reviewRequestTargetsPerson } from "../lib/review-queue";
import type { useSidebarFilter } from "../lib/sidebar-filter";
import { personFilterFor, setFilter } from "../lib/sidebar-filter";
import { getTabColors, onTabColorsChanged } from "../lib/tab-colors";
import type { UnifiedSession } from "../lib/types";
import type { useAppRoute } from "./useAppRoute";
import { useBackSwipe } from "./useBackSwipe";
import { useInputAlerts } from "./useInputAlerts";
import { useIsPhone } from "./useIsPhone";

interface UseAppDocumentInteractionsOptions {
  route: Route;
  sidebarFilter: ReturnType<typeof useSidebarFilter>;
  navigate: ReturnType<typeof useAppRoute>["navigate"];
  goBack: () => void;
  detailPaneRef: React.RefObject<HTMLElement | null>;
  sessions: UnifiedSession[];
  connected: boolean;
  setTabColors: Dispatch<SetStateAction<Record<string, string>>>;
}

export function useAppDocumentInteractions({
  route,
  sidebarFilter,
  navigate,
  goBack,
  detailPaneRef,
  sessions,
  connected,
  setTabColors,
}: UseAppDocumentInteractionsOptions) {
  // Track the on-screen keyboard via input focus. It's the only reliable iOS
  // signal: in a standalone PWA visualViewport doesn't shrink, and
  // env(safe-area-inset-bottom) keeps reporting the home-indicator inset even
  // while the keyboard covers that area. A `kb-open` body class lets the
  // composer drop its safe-area bottom padding so it sits snug above the
  // keyboard instead of floating ~34px above it.
  //
  // The same focus is what starts measuring HOW MUCH the keyboard covers
  // (`--kb-inset`, lib/keyboard-inset): the class says a keyboard is up, the
  // variable says how tall it is, and a surface resting on the bottom edge
  // needs both.
  useEffect(() => {
    let releaseInset: (() => void) | null = null;
    const isText = (element: Element | null) =>
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        ![
          "button",
          "checkbox",
          "radio",
          "submit",
          "file",
          "range",
          "color",
        ].includes(element.type)) ||
      (element instanceof HTMLElement && element.isContentEditable);
    const onIn = (e: FocusEvent) => {
      if (!isText(eventTargetElement(e))) return;
      document.body.classList.add("kb-open");
      if (releaseInset === null) releaseInset = trackKeyboardInset();
    };
    const onOut = () => {
      // activeElement updates a tick after focusout; defer so moving between
      // fields doesn't flicker the class off and back on.
      setTimeout(() => {
        if (isText(document.activeElement)) return;
        document.body.classList.remove("kb-open");
        releaseInset?.();
        releaseInset = null;
      }, 0);
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      releaseInset?.();
    };
  }, []);
  useEffect(() => {
    const unsub = onTabColorsChanged(() => setTabColors(getTabColors()));
    setTabColors(getTabColors());
    return unsub;
  }, [setTabColors]);

  // Settings (and the tool surfaces it hosts) render as a full page on
  // desktop, but as a bottom sheet over the root list on phones.
  const settingsActive = isSettingsRoute(route);
  const isPhone = useIsPhone();
  const borrowedSidebar = sidebarFilter.person !== "me";

  // A pushed detail page is showing (anything but the sidebar-root home view).
  // On phones, Settings is a sheet floating over the root page rather than a
  // pushed page — the bar keeps the brand and the sidebar stays underneath.
  const mobileDetail = route.view !== "prs" && !(isPhone && settingsActive);

  const sidebarRef = useRef<SidebarHandle>(null);
  const nextChatRef = useRef<() => void>(() => {});
  const [nextChatAvailable, setNextChatAvailable] = useState(false);
  // Set below, once the review-focus callback it needs exists.
  const openPrRef = useRef<(repo: string, number: number) => void>(() => {});

  // PR-mention chips (markdown.ts) are anchors inside
  // dangerouslySetInnerHTML, so they can't carry a React handler — and they
  // turn up in every markdown surface, not just the transcript. One
  // document-level listener gives them both readings of "open this PR":
  //   - plain click → the review here, navigated in place rather than
  //     reloading the whole SPA to follow the href
  //   - cmd/ctrl-click (and the middle button, which fires `auxclick`) → the
  //     PR on github.com in a new tab. That gesture means "open elsewhere",
  //     and elsewhere for a PR is GitHub — opening a second copy of this app
  //     in a tab is never what it was asked for.
  // A repo with no GitHub name to go to keeps the browser's own behavior.
  useEffect(() => {
    const chipAt = (e: MouseEvent) => {
      if (e.defaultPrevented) return null;
      const el = closestHTMLElement(e, "a[data-pr-number]");
      const repo = el?.dataset.prRepo;
      const number = Number(el?.dataset.prNumber);
      if (!repo || !Number.isInteger(number)) return null;
      return { repo, number, ghRepo: el?.dataset.prGh };
    };
    const openOnGithub = (
      e: MouseEvent,
      chip: NonNullable<ReturnType<typeof chipAt>>,
    ) => {
      if (!chip.ghRepo) return false;
      e.preventDefault();
      window.open(
        `https://github.com/${chip.ghRepo}/pull/${chip.number}`,
        "_blank",
        "noopener,noreferrer",
      );
      return true;
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const chip = chipAt(e);
      if (!chip) return;
      if (e.metaKey || e.ctrlKey) {
        openOnGithub(e, chip);
        return;
      }
      // Shift (new window) and alt (download) are deliberate browser
      // gestures on the href — leave them to it.
      if (e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPrRef.current(chip.repo, chip.number);
    };
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return;
      const chip = chipAt(e);
      if (chip) openOnGithub(e, chip);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("auxclick", onAuxClick);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("auxclick", onAuxClick);
    };
  }, []);

  // Automation-id chips carry a real href for browser gestures. Plain clicks
  // stay inside the SPA and open that automation's settings drawer directly.
  const navigateFromDocument = useEffectEvent(navigate);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const el = closestHTMLElement(e, "a.automation-link[data-automation-id]");
      const id = el?.dataset.automationId;
      if (!id) return;
      e.preventDefault();
      navigateFromDocument({ view: "automations", id });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // @-mention chips (markdown.ts) are anchors inside dangerouslySetInnerHTML
  // too, so they get the same treatment: one document-level listener, and a
  // click puts the sidebar on that person's sessions. Enter/Space as well —
  // the chip is a role="button", so the keyboard has to reach it.
  useEffect(() => {
    const personAt = (e: Event) => {
      if (e.defaultPrevented) return null;
      const el = closestHTMLElement(e, "a.person-chip[data-person]");
      return el?.dataset.person || null;
    };
    const show = (person: string) => {
      setFilter({
        person: personFilterFor(person.toLowerCase(), getCurrentUser()),
      });
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const person = personAt(e);
      if (!person) return;
      e.preventDefault();
      show(person);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const person = personAt(e);
      if (!person) return;
      e.preventDefault();
      show(person);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Edge-swipe-from-left pops the pushed page back to the sidebar on phones.
  useBackSwipe({
    active: mobileDetail,
    onBack: goBack,
    paneRef: detailPaneRef,
  });

  // Arm audio + request notification permission on the first user gesture.
  useEffect(() => initAlerts(), []);

  // Sound + desktop notification whenever one of *my* sessions newly flips into
  // "needs input" (blocked on a question). Scoped to the current user's own
  // non-automation sessions — the same set as the sidebar's "Needs input" bucket.
  useInputAlerts(sessions, {
    isMine: (s) => {
      const me = getCurrentUser().toLowerCase();
      return !s.automation && !!s.startedBy && s.startedBy.toLowerCase() === me;
    },
    isMyReview: (s) =>
      reviewRequestTargetsPerson(s.reviewRequest, getCurrentUser()) &&
      !s.reviewRequest?.accepted,
    onOpen: (id) => navigate({ view: "session", id }),
    connected,
  });

  return {
    settingsActive,
    isPhone,
    borrowedSidebar,
    mobileDetail,
    sidebarRef,
    nextChatRef,
    nextChatAvailable,
    setNextChatAvailable,
    openPrRef,
  };
}
