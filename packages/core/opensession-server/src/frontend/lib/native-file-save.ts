type IOSNavigator = Navigator & { standalone?: boolean };

export function shouldUseNativeIOSShare(input: {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
  displayModeStandalone: boolean;
  hasShare: boolean;
}): boolean {
  const isiOS =
    /iPhone|iPad|iPod/.test(input.userAgent) ||
    (input.platform === "MacIntel" && input.maxTouchPoints > 1);
  return (
    isiOS && (input.standalone || input.displayModeStandalone) && input.hasShare
  );
}

/**
 * Installed iOS PWAs ignore attachment responses and same-origin new tabs can
 * replace the app without browser chrome. Use the native share sheet there:
 * files get "Save to Files", while URLs can be handed to another browser.
 */
export function canUseNativeIOSShare(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return false;
  const nav = navigator as IOSNavigator;
  return shouldUseNativeIOSShare({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: nav.standalone === true,
    displayModeStandalone: window.matchMedia("(display-mode: standalone)")
      .matches,
    hasShare: typeof navigator.share === "function",
  });
}

export async function saveFileWithNativeShare(
  url: string,
  name: string,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const blob = await response.blob();
  const file = new File([blob], name, {
    type: blob.type || "application/octet-stream",
  });
  if (
    typeof navigator.canShare === "function" &&
    !navigator.canShare({ files: [file] })
  ) {
    throw new Error("This file cannot be saved on this device");
  }
  await navigator.share({ files: [file] });
}

export function shareURL(url: string): Promise<void> {
  return navigator.share({ url: new URL(url, location.href).href });
}

export function nativeShareWasCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
