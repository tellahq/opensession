import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence } from "motion/react";
import {
  canMorphFrom,
  HERO_TRANSITION_NAME,
  LIGHTBOX_TRANSITION_CSS,
  markTransition,
  mediaElement,
  nextMediaLightboxId,
  registerMediaLightboxHost,
  setTransitionName,
  supportsHeroTransition,
  type LightboxRequest,
  type LightboxState,
  type ViewTransitionDocument,
  type ViewTransitionHandle,
} from "../lib/media-lightbox";
import {
  lightboxDiagramFor,
  openGalleryFrom,
} from "../lib/media-lightbox-gallery";
import { MediaLightboxGallery } from "./MediaLightboxGallery";

/**
 * Full-screen lightbox for all in-app media: workspace-media thumbnails (the
 * sidebar hover card, the mobile sheet, and the WorkspaceInfo panel) and any
 * session media (markdown images, pasted-image attachments, tool-result
 * screenshots and recordings), with prev/next browsing instead of jumping to
 * the raw file in a new tab — which for data:/blob URLs browsers block,
 * leaving an empty window.
 *
 * Global singleton: the thumbnails live inside transient popovers — the
 * hover card unmounts on mouseleave/scroll — so the modal is hosted once in
 * App and opened imperatively via openLightbox(), surviving its opener.
 * Session media is wired through a delegated capture-phase click listener here
 * (rather than per-component onClicks) because markdown images are injected
 * via dangerouslySetInnerHTML and can't carry React handlers.
 */
export function MediaLightboxHost() {
  const [state, setState] = useState<LightboxState | null>(null);
  const activeTransition = useRef<ViewTransitionHandle | null>(null);
  const activeSourceCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    const open = (request: LightboxRequest) => {
      const id = nextMediaLightboxId();
      const origin = mediaElement(request.origin);
      const next: LightboxState = {
        ...request,
        id,
        origin,
        originIndex: request.index,
        useHeroTransition: false,
      };
      const item = request.items[request.index];
      if (
        item?.kind !== "image" ||
        !canMorphFrom(origin) ||
        !supportsHeroTransition()
      ) {
        setState(next);
        return;
      }

      activeTransition.current?.skipTransition();
      activeSourceCleanup.current?.();
      const restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
      activeSourceCleanup.current = restoreOrigin;
      const clearTransitionMark = markTransition("opening", id);
      try {
        const transition = (document as ViewTransitionDocument)
          .startViewTransition!(() => {
          // The source belongs only to the old snapshot. Removing its name before
          // React mounts the destination avoids duplicate named elements.
          restoreOrigin();
          if (activeSourceCleanup.current === restoreOrigin) {
            activeSourceCleanup.current = null;
          }
          flushSync(() => setState({ ...next, useHeroTransition: true }));
        });
        activeTransition.current = transition;
        const finish = () => {
          if (activeTransition.current === transition)
            activeTransition.current = null;
          clearTransitionMark();
        };
        void transition.finished.then(finish, finish);
      } catch {
        restoreOrigin();
        if (activeSourceCleanup.current === restoreOrigin) {
          activeSourceCleanup.current = null;
        }
        clearTransitionMark();
        setState(next);
      }
    };
    const unregister = registerMediaLightboxHost(open);
    return () => {
      unregister();
      activeTransition.current?.skipTransition();
      activeSourceCleanup.current?.();
    };
  }, []);
  // Delegated capture-phase listener: intercept plain left-clicks on any
  // session image and open the gallery instead of following the wrapping
  // <a target="_blank"> (kept for cmd/middle-click open-in-tab). Videos are
  // not intercepted — clicks there drive the native controls.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const target = e.target as HTMLElement;
      // Enter on the focused link dispatches a click whose target is the
      // wrapping <a>, not the <img> inside it — match both, or keyboard
      // activation falls through to the raw file in a new tab.
      const media =
        target.closest?.("img.md-image") ||
        target.closest?.("a.md-image-link")?.querySelector("img.md-image") ||
        lightboxDiagramFor(target);
      if (!media) return;
      e.preventDefault();
      e.stopPropagation();
      openGalleryFrom(media);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  function close(current: LightboxState, allowHeroTransition = true) {
    const item = current.items[current.index];
    const origin = current.origin;
    const canReturn =
      allowHeroTransition &&
      current.useHeroTransition &&
      current.index === current.originIndex &&
      item?.kind === "image" &&
      canMorphFrom(origin) &&
      supportsHeroTransition();

    if (!canReturn) {
      // Native transitions don't need Motion's lifecycle. If the source has
      // disappeared (for example, a hover card closed), opt back into the
      // fallback for one frame so the viewer still leaves gracefully.
      activeTransition.current?.skipTransition();
      activeTransition.current = null;
      activeSourceCleanup.current?.();
      activeSourceCleanup.current = null;
      if (
        document.documentElement.dataset.lightboxTransitionId ===
        String(current.id)
      ) {
        delete document.documentElement.dataset.lightboxTransition;
        delete document.documentElement.dataset.lightboxTransitionId;
      }
      setState({ ...current, useHeroTransition: false });
      requestAnimationFrame(() => {
        setState((latest) => (latest?.id === current.id ? null : latest));
      });
      return;
    }

    activeTransition.current?.skipTransition();
    activeSourceCleanup.current?.();
    activeSourceCleanup.current = null;
    const clearTransitionMark = markTransition("closing", current.id);
    let restoreOrigin: (() => void) | undefined;
    try {
      const transition = (document as ViewTransitionDocument)
        .startViewTransition!(() => {
        // The target belongs only to the old snapshot; name the source after
        // that capture so it becomes the destination in the new snapshot.
        restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
        activeSourceCleanup.current = restoreOrigin;
        flushSync(() => setState(null));
      });
      activeTransition.current = transition;
      const finish = () => {
        restoreOrigin?.();
        if (activeSourceCleanup.current === restoreOrigin) {
          activeSourceCleanup.current = null;
        }
        if (activeTransition.current === transition)
          activeTransition.current = null;
        clearTransitionMark();
      };
      void transition.finished.then(finish, finish);
    } catch {
      restoreOrigin?.();
      if (activeSourceCleanup.current === restoreOrigin) {
        activeSourceCleanup.current = null;
      }
      clearTransitionMark();
      setState(null);
    }
  }

  const lightbox = state ? (
    <MediaLightboxGallery
      key={state.id}
      items={state.items}
      index={state.index}
      onIndex={(index) =>
        setState((latest) =>
          latest?.id === state.id ? { ...latest, index } : latest,
        )
      }
      onClose={(allowHeroTransition) => close(state, allowHeroTransition)}
      useHeroTransition={state.useHeroTransition}
      startCommenting={state.startCommenting}
      heroTransitionName={
        state.useHeroTransition && state.index === state.originIndex
          ? HERO_TRANSITION_NAME
          : undefined
      }
    />
  ) : null;

  return (
    <>
      <style>{LIGHTBOX_TRANSITION_CSS}</style>
      {state?.useHeroTransition ? (
        lightbox
      ) : (
        <AnimatePresence initial={false}>{lightbox}</AnimatePresence>
      )}
    </>
  );
}
