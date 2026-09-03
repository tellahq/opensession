import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import type { Route } from "../lib/app-route";
import type { UnifiedSession } from "../lib/types";
import type { useAppRoute } from "./useAppRoute";
import { useHydratedSession } from "./useHydratedSession";

// How long the launch splash may hold the screen while the first session list
// is still in flight. Past this the app takes over and reports for itself.
const SPLASH_MAX_MS = 8000;
const SPLASH_EXIT_MS = 400;

interface UseActiveSessionOptions {
  route: Route;
  sessions: UnifiedSession[];
  optimisticSession: UnifiedSession | null;
  loading: boolean;
  restoredSessionId: string | undefined;
  forgetLastSession: ReturnType<typeof useAppRoute>["forgetLastSession"];
  navigate: ReturnType<typeof useAppRoute>["navigate"];
  setLaunchComplete: Dispatch<SetStateAction<boolean>>;
}

export function useActiveSession({
  route,
  sessions,
  optimisticSession,
  loading,
  restoredSessionId,
  forgetLastSession,
  navigate,
  setLaunchComplete,
}: UseActiveSessionOptions) {
  // The list is the live slice, and archived sessions arrive as summaries, so
  // the row it finds may be missing or partial. Hydrate the route directly,
  // before the list finishes, so a deep link can hand off from the launch
  // splash as soon as its one session is ready.
  const listedSession: UnifiedSession | null =
    route.view === "session"
      ? optimisticSession?.id === route.id
        ? optimisticSession
        : sessions.find(
            (s) => s.id === route.id || s.aliasIds?.includes(route.id),
          ) || null
      : null;
  const currentSession = useHydratedSession(
    route.view === "session" ? route.id : null,
    listedSession,
  );
  // A stale PWA memory yields to home once hydration proves it is archived.
  // Explicit archived deep links have no automatic-restore marker and stay open.
  useEffect(() => {
    if (
      route.view !== "session" ||
      !currentSession?.archived ||
      restoredSessionId !== route.id
    )
      return;
    forgetLastSession();
    navigate({ view: "prs" }, { replace: true });
  }, [
    currentSession?.archived,
    route,
    restoredSessionId,
    forgetLastSession,
    navigate,
  ]);
  const shellLoading = loading && !currentSession;

  // Tear down the launch splash (rendered in index.html) once there is
  // something to draw. Mounting is not that moment: React mounts as soon as the
  // bundle parses, which needs no data, and the app is transparent all the way
  // down (html, body and #root under the desktop shell's window material), so
  // handing the screen over then leaves an empty window rather than a bare one.
  // The desktop shell feels this most, having no service worker to serve the
  // shell or the list from cache, and it shows the window material through the
  // gap: measured at 1.5s on loopback and 9s on a slow poll. The cap keeps a
  // server that never answers from parking anyone behind a splash for good.
  useEffect(() => {
    const splash = document.getElementById("splash");
    let removal: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      if (!splash) return;
      splash.classList.add("splash-hide");
      removal = setTimeout(() => splash.remove(), SPLASH_EXIT_MS);
    };
    if (!shellLoading) {
      // The window is only handed over when there is something in it: the
      // desktop shell's vibrancy is gated on this class, and a transparent
      // window with an empty app in it reads as no window at all. The cap
      // below deliberately does not set it, so a server that never answers
      // gets the app's own surface rather than a hole in the desktop.
      document.documentElement.classList.add("app-ready");
      hide();
      return () => clearTimeout(removal);
    }
    const cap = setTimeout(hide, SPLASH_MAX_MS);
    return () => {
      clearTimeout(cap);
      clearTimeout(removal);
    };
  }, [shellLoading]);

  useEffect(() => {
    if (shellLoading) return;
    const timer = setTimeout(() => setLaunchComplete(true), SPLASH_EXIT_MS);
    return () => clearTimeout(timer);
  }, [shellLoading, setLaunchComplete]);

  return { listedSession, currentSession, shellLoading };
}
