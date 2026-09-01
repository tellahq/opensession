export function restoreSelectFocusAfterClose(reason: string) {
  return reason !== "outside-press" && reason !== "focus-out";
}
