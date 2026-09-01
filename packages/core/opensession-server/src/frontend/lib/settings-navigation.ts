export type SettingsReturn = {
  path: string;
  depth: number | null;
  steps: number;
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
  replace,
}: {
  currentIsSettings: boolean;
  nextIsSettings: boolean;
  currentReturn?: SettingsReturn;
  currentPath: string;
  currentDepth: number | null;
  replace: boolean;
}): SettingsReturn | undefined {
  if (!nextIsSettings) return undefined;
  if (!currentIsSettings)
    return {
      path: currentPath,
      depth: currentDepth,
      steps: replace ? 0 : 1,
    };
  if (!currentReturn) return undefined;
  return replace
    ? currentReturn
    : { ...currentReturn, steps: currentReturn.steps + 1 };
}
