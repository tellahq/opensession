/** How long the first Escape press stays armed waiting for the second. */
export const ESC_STOP_WINDOW_MS = 1500;

export interface EscEventLike {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly repeat: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

const MODAL_OR_POPOVER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement))
    return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

/**
 * Returns true when a bare Escape pressed outside editable inputs and open
 * dialogs/menus should arm (or confirm) stopping an active session turn.
 */
export function shouldHandleTranscriptEscape(
  event: EscEventLike,
  doc: Document | null = typeof document !== "undefined" ? document : null,
): boolean {
  if (event.key !== "Escape") return false;
  if (event.defaultPrevented || event.repeat) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isEditableTarget(event.target)) return false;
  if (doc && doc.querySelector(MODAL_OR_POPOVER_SELECTOR)) return false;
  return true;
}
