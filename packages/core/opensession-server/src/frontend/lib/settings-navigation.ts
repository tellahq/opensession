import type { PlaceOverride } from "./new-layout-place";

export type SettingsReturn = {
  path: string;
  depth: number | null;
  steps: number;
  /** The new layout's place the page beneath was showing in, when its route
   *  alone does not give it. Sections can move the place while Settings is
   *  open, so closing it restores the one it was opened from. */
  place?: PlaceOverride;
};

/**
 * Keep the page beneath Settings attached to every Settings history entry.
 * Section changes can add their own entries, so closing the whole surface can
 * skip all of them and return to the page that opened it.
 */
export function settingsReturnForNavigation({
  currentIsSettings,
  nextIsSettings,
  currentReturn,
  currentPath,
  currentDepth,
  currentPlace,
  replace,
}: {
  currentIsSettings: boolean;
  nextIsSettings: boolean;
  currentReturn?: SettingsReturn;
  currentPath: string;
  currentDepth: number | null;
  currentPlace?: PlaceOverride;
  replace: boolean;
}): SettingsReturn | undefined {
  if (!nextIsSettings) return undefined;
  if (!currentIsSettings)
    return {
      path: currentPath,
      depth: currentDepth,
      steps: replace ? 0 : 1,
      ...(currentPlace && { place: currentPlace }),
    };
  if (!currentReturn) return undefined;
  return replace
    ? currentReturn
    : { ...currentReturn, steps: currentReturn.steps + 1 };
}
