/** Suspend the SPA root AND every body-level portal without disposing their
 * controllers. The curtain's stylesheet hides marked roots declaratively, so
 * app-owned display/visibility/inert changes during the probe remain untouched.
 * display:none also removes focus targets and accessibility-tree content. */
export function suspendPrivateDocument(curtain: HTMLElement): () => void {
  const suspended = new Map<Element, string | null>();
  const restore = (element: Element, value: string | null) => {
    if (value === null) element.removeAttribute("data-auth-suspended");
    else element.setAttribute("data-auth-suspended", value);
  };
  const suspend = () => {
    // A failed probe can last indefinitely. Do not retain detached portal
    // subtrees; restore moved roots too, and re-register later reinsertions.
    for (const [element, value] of suspended) {
      if (element.parentElement === document.body) continue;
      restore(element, value);
      suspended.delete(element);
    }
    for (const element of document.body.children) {
      if (element === curtain || suspended.has(element)) continue;
      suspended.set(element, element.getAttribute("data-auth-suspended"));
      element.setAttribute("data-auth-suspended", "");
    }
  };
  suspend();
  const observer = new MutationObserver(suspend);
  observer.observe(document.body, { childList: true });
  return () => {
    observer.disconnect();
    for (const [element, value] of suspended) restore(element, value);
    suspended.clear();
  };
}
