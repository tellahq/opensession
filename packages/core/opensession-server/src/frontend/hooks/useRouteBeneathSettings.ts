import { useState } from "react";
import {
  isSettingsRoute,
  isToolView,
  parseRoute,
  type Route,
} from "../lib/app-route";
import { useNewLayoutPref } from "../lib/new-layout-pref";
import { useIsPhone } from "./useIsPhone";

export type RouteBeneathSettings = {
  /** What the app body renders. */
  route: Route;
  /** Whether the Settings modal is open over it. */
  settingsModal: boolean;
};

/**
 * On desktop Settings is a modal over the page it was opened from, so the app
 * keeps rendering that page underneath while the URL names a Settings
 * section. Returns the route the app body should render, and whether the
 * Settings modal is open. Phones keep the sheet, and the new layout's tool
 * pages (Automations, Goals, Security) are app pages, not Settings.
 */
export function useRouteBeneathSettings(route: Route): RouteBeneathSettings {
  const isPhone = useIsPhone();
  const newLayout = useNewLayoutPref();
  const settingsModal =
    !isPhone &&
    isSettingsRoute(route) &&
    !(newLayout && isToolView(route.view));
  const [beneath, setBeneath] = useState<Route>(() =>
    // Settings loaded first (a link or a reload) opens over the home page.
    settingsModal ? parseRoute("/") : route,
  );
  // Follow every page shown outside Settings, so the modal opens over it.
  if (!settingsModal && beneath !== route) setBeneath(route);
  return { route: settingsModal ? beneath : route, settingsModal };
}
